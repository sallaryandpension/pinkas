/**
 * כניסה לשרת: סיסמה + קוד משתנה (TOTP, RFC 6238), עוגיית כניסה, ניתוק אוטומטי ונעילה אחרי כישלונות.
 * משתמש יחיד (בעל העסק). הפרטים נשמרים ב-auth.json (הרשאות 600) בתיקיית הנתונים.
 * הגדרה ראשונית מחייבת "קוד הגדרה" שנכתב לקובץ setup-token.txt בשרת, כדי שמי שמגיע לדף לפני
 * בעל השרת לא יוכל לתפוס אותו.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- base32 (RFC 4648) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = ((value << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 לא תקין');
    value = ((value << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---------- TOTP (RFC 6238, HMAC-SHA1, 30 שניות, 6 ספרות – מה שאפליקציות הקודים תומכות בו) ----------
export const TOTP_STEP = 30;
export const counterAt = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP);

export function totp(secret: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

// ---------- סיסמה (scrypt) ----------
const MAXMEM = 64 * 1024 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
export const MIN_PASSWORD = 12;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw.normalize('NFC'), salt, 32, { ...SCRYPT, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = scryptSync(pw.normalize('NFC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return timingSafeEqual(got, expected);
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
const tokenKey = (token: string) => createHash('sha256').update(token).digest('base64url');

// ---------- עוגייה ----------
export const COOKIE = 'pinkas_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Secure עובד גם ב-http://localhost (דפדפנים מתייחסים אליו כהקשר מאובטח). */
export const sessionCookie = (token: string, maxAgeSec: number) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// ---------- מנהל הכניסה ----------
export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Stored = { version: 1; passwordHash: string; totpSecret: string; lastCounter: number; createdAt: string };
type Session = { created: number; lastSeen: number };

export type AuthOptions = {
  dataDir: string;
  now?: () => number;
  idleMs?: number;        // ניתוק אחרי זמן ללא פעולה
  maxMs?: number;         // זמן מרבי לכניסה
  maxFailures?: number;   // כישלונות רצופים עד נעילה
  lockMs?: number;        // נעילה ראשונה; כל נעילה נוספת כפולה, עד 24 שעות
};

export class Auth {
  dataDir: string;
  now: () => number;
  idleMs: number;
  maxMs: number;
  maxFailures: number;
  lockMs: number;
  sessions = new Map<string, Session>();
  failures = 0;
  lockCount = 0;
  lockedUntil = 0;
  setupToken: string | null = null;
  pending: { secret: string; passwordHash: string } | null = null;

  constructor(o: AuthOptions) {
    this.dataDir = o.dataDir;
    this.now = o.now ?? Date.now;
    this.idleMs = o.idleMs ?? 30 * 60_000;
    this.maxMs = o.maxMs ?? 12 * 60 * 60_000;
    this.maxFailures = o.maxFailures ?? 5;
    this.lockMs = o.lockMs ?? 15 * 60_000;
    if (!this.configured()) this.ensureSetupToken();
  }

  get file() { return join(this.dataDir, 'auth.json'); }
  get tokenFile() { return join(this.dataDir, 'setup-token.txt'); }
  configured(): boolean { return existsSync(this.file); }

  private load(): Stored { return JSON.parse(readFileSync(this.file, 'utf8')); }
  private save(s: Stored) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }

  private ensureSetupToken() {
    if (existsSync(this.tokenFile)) this.setupToken = readFileSync(this.tokenFile, 'utf8').trim();
    else {
      this.setupToken = base32Encode(randomBytes(10));
      writeFileSync(this.tokenFile, `${this.setupToken}\n`, { mode: 0o600 });
    }
  }

  status() {
    const locked = this.now() < this.lockedUntil;
    return { configured: this.configured(), locked, lockedMinutes: locked ? Math.ceil((this.lockedUntil - this.now()) / 60_000) : 0 };
  }

  private checkLock() {
    const s = this.status();
    if (s.locked) throw new AuthError(429, `יותר מדי ניסיונות כושלים. הכניסה נעולה לעוד ${s.lockedMinutes} דקות.`);
  }

  private fail() {
    this.failures++;
    if (this.failures >= this.maxFailures) {
      this.lockCount++;
      this.lockedUntil = this.now() + Math.min(this.lockMs * 2 ** (this.lockCount - 1), 24 * 60 * 60_000);
      this.failures = 0;
    }
  }

  private checkSetupToken(token: unknown) {
    if (this.configured()) throw new AuthError(409, 'הכניסה כבר הוגדרה.');
    if (!this.setupToken || !safeEqual(String(token ?? '').trim().toUpperCase(), this.setupToken)) {
      this.fail();
      throw new AuthError(401, 'קוד ההגדרה שגוי.');
    }
  }

  /** קוד תקף: החלון הנוכחי או אחד לפניו/אחריו (סטיית שעון), ורק אם לא שומש כבר (נגד שימוש חוזר). */
  private matchCode(secret: string, code: unknown, lastCounter: number): number {
    const c = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) return -1;
    const key = base32Decode(secret);
    const c0 = counterAt(this.now());
    for (const k of [c0, c0 - 1, c0 + 1]) if (k > lastCounter && safeEqual(totp(key, k), c)) return k;
    return -1;
  }

  setupStart(token: unknown, password: unknown): { secret: string; uri: string } {
    this.checkLock();
    this.checkSetupToken(token);
    const pw = String(password ?? '');
    if (pw.length < MIN_PASSWORD) throw new AuthError(400, `הסיסמה צריכה להיות באורך ${MIN_PASSWORD} תווים לפחות.`);
    const secret = base32Encode(randomBytes(20));
    this.pending = { secret, passwordHash: hashPassword(pw) };
    return { secret, uri: `otpauth://totp/Pinkas:owner?secret=${secret}&issuer=Pinkas&algorithm=SHA1&digits=6&period=${TOTP_STEP}` };
  }

  setupFinish(token: unknown, code: unknown): void {
    this.checkLock();
    this.checkSetupToken(token);
    if (!this.pending) throw new AuthError(400, 'יש להתחיל את ההגדרה מחדש.');
    const k = this.matchCode(this.pending.secret, code, -1);
    if (k < 0) { this.fail(); throw new AuthError(401, 'הקוד שגוי. בדוק שהשעון בטלפון מדויק ונסה את הקוד הבא.'); }
    this.save({ version: 1, passwordHash: this.pending.passwordHash, totpSecret: this.pending.secret, lastCounter: k, createdAt: new Date(this.now()).toISOString() });
    rmSync(this.tokenFile, { force: true });
    this.setupToken = null; this.pending = null; this.failures = 0; this.lockCount = 0;
  }

  /** מחזיר אסימון הפעלה חדש. הסיסמה והקוד נבדקים תמיד שניהם, וההודעה לא מגלה מי מהם שגוי. */
  login(password: unknown, code: unknown): string {
    this.checkLock();
    if (!this.configured()) throw new AuthError(409, 'הכניסה עוד לא הוגדרה.');
    const s = this.load();
    const pwOk = verifyPassword(String(password ?? ''), s.passwordHash);
    const k = this.matchCode(s.totpSecret, code, s.lastCounter);
    if (!pwOk || k < 0) { this.fail(); throw new AuthError(401, 'הסיסמה או הקוד שגויים. (כל קוד אפשר להשתמש בו פעם אחת בלבד.)'); }
    s.lastCounter = k; this.save(s);
    this.failures = 0; this.lockCount = 0;
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(tokenKey(token), { created: t, lastSeen: t });
    return token;
  }

  /** בדיקת הפעלה; מאריך את זמן חוסר הפעילות. */
  check(token: string | undefined): boolean {
    if (!token) return false;
    const key = tokenKey(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    const t = this.now();
    if (t - s.lastSeen > this.idleMs || t - s.created > this.maxMs) { this.sessions.delete(key); return false; }
    s.lastSeen = t;
    return true;
  }

  logout(token: string | undefined) { if (token) this.sessions.delete(tokenKey(token)); }
}
