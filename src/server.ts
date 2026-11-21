/**
 * שרת פנקס. מקשיב ל-127.0.0.1 בלבד. גישה מבחוץ רק דרך מנהרת SSH או Tailscale (שמעבירים ל-localhost).
 * הגנות:
 * - כניסה (סיסמה + קוד משתנה) על כל בקשה, חוץ מדף הכניסה עצמו (auth.ts);
 * - בדיקת Host (נגד DNS rebinding) ו-Origin; כל פעולת כתיבה מחייבת כותרת X-Pinkas (נגד CSRF);
 * - כותרות אבטחה (CSP, HSTS, frame-ancestors, nosniff, no-referrer) ו-Cache-Control: no-store;
 * - ביציאה: Clear-Site-Data; יומן כניסות וגישה לקבצים ב-audit_log (שרשרת hash).
 * משתנים: PINKAS_DATA, PINKAS_PORT, PINKAS_HOSTS (שמות מארח נוספים, למשל של Tailscale, מופרדים בפסיק).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/open.ts';
import { appendAudit } from './core/audit.ts';
import { ValidationError, type DocumentRow } from './core/documents.ts';
import { sniffAttachmentType } from './core/expenses.ts';
import { continuityReport } from './core/reports.ts';
import { nowIso } from './core/util.ts';
import { continuityBody, journalBody, renderReport } from './render/html.ts';
import { htmlToPdf } from './render/pdf.ts';
import {
  availableDrives, backupStatus, createBackup, dailyLocalBackup, fsAttachmentSaver, openBackupDb, setBackupTarget, verifyBackup,
} from './core/backup.ts';
import { HttpError, route, type Platform } from './routes.ts';
import { Auth, AuthError, COOKIE, clearCookie, parseCookies, sessionCookie } from './auth.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const DATA_DIR = resolve(arg('data') ?? process.env.PINKAS_DATA ?? join(ROOT, 'data'));
const PORT = Number(arg('port') ?? process.env.PINKAS_PORT ?? 5174);
const PUBLIC = join(ROOT, 'public');
const OUTPUTS = join(DATA_DIR, 'outputs');
mkdirSync(OUTPUTS, { recursive: true });

const EXTRA_HOSTS = (process.env.PINKAS_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...EXTRA_HOSTS]);
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...EXTRA_HOSTS.map((h) => `https://${h}`)]);

const db = openDb(join(DATA_DIR, 'pinkas.db'));
const auth = new Auth({ dataDir: DATA_DIR });

const platform: Platform = {
  saveAttachment: fsAttachmentSaver(DATA_DIR),
  backupExtras: (d) => { const s = backupStatus(d); return { target: s.target, targetAvailable: s.targetAvailable }; },
};

// ---- כותרות אבטחה ----
// סגנונות פנימיים מותרים (תצוגה מקדימה של מסמך ב-iframe srcdoc יורשת את המדיניות); סקריפטים – רק מהשרת.
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// מסמך/דוח שהשרת מרנדר כ-HTML: בלי סקריפטים בכלל.
const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-modals";
const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string | string[]> = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Security-Policy': APP_CSP, 'Content-Type': type, ...extra });
  res.end(data);
}

async function readJson(req: IncomingMessage, maxBytes = 15_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > maxBytes) throw new HttpError(413, 'בקשה גדולה מדי'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON לא תקין'); }
}

/** כתובת הלקוח לצורך היומן (מאחורי Tailscale/מנהרה – הכותרת שהמתווך המקומי הוסיף). */
function clientOf(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const direct = req.socket.remoteAddress ?? '';
  return fwd && (direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1') ? fwd : direct;
}

/** גיבוי לבדיקה/הפקה: רק בתוך תיקיית הגיבויים המקומית או תיקיית היעד שהוגדרה (נגד חריגה מתיקייה). */
function allowedBackupDir(input: unknown): string {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const dir = String(input ?? '');
  if (!dir) throw new HttpError(400, 'לא צוין גיבוי');
  const full = norm(real(resolve(dir)));
  const roots = [join(DATA_DIR, 'backups'), backupStatus(db).target].filter(Boolean).map((r) => norm(real(r as string)));
  if (!roots.some((r) => full === r || full.startsWith(r.endsWith(sep) ? r : r + sep))) {
    throw new HttpError(403, 'הנתיב אינו בתיקיית גיבוי מוכרת (הגיבויים המקומיים או תיקיית היעד שהוגדרה).');
  }
  return full;
}

const PUBLIC_FILES = new Set(['login.html', 'login.js', 'style.css']);
const STATIC_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8' };
const ATT_EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

async function handle(req: IncomingMessage, res: ServerResponse) {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!HOSTS.has(host)) throw new HttpError(403, 'Host not allowed');
  const url = new URL(req.url ?? '/', `http://${host}`);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (m !== 'GET' && m !== 'HEAD') {
    if (req.headers['x-pinkas'] !== '1') throw new HttpError(403, 'missing X-Pinkas header');
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) throw new HttpError(403, 'Origin not allowed');
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const who = clientOf(req);

  // ---- כניסה (בלי הזדהות) ----
  if (p === '/api/auth/status' && m === 'GET') return send(res, 200, { ...auth.status(), loggedIn: auth.check(token) });
  if (p === '/api/auth/login' && m === 'POST') {
    const body = await readJson(req, 10_000);
    try {
      const t = auth.login(body.password, body.code);
      appendAudit(db, 'auth.login', 'auth', null, { client: who });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie(t, Math.floor(auth.maxMs / 1000)) });
    } catch (e) {
      if (e instanceof AuthError && e.status !== 409) appendAudit(db, e.status === 429 ? 'auth.locked' : 'auth.login_failed', 'auth', null, { client: who });
      throw e;
    }
  }
  if (p === '/api/auth/setup/start' && m === 'POST') {
    const body = await readJson(req, 10_000);
    try { return send(res, 200, auth.setupStart(body.token, body.password)); }
    catch (e) { if (e instanceof AuthError && e.status === 401) appendAudit(db, 'auth.setup_failed', 'auth', null, { client: who }); throw e; }
  }
  if (p === '/api/auth/setup/finish' && m === 'POST') {
    const body = await readJson(req, 10_000);
    auth.setupFinish(body.token, body.code);
    appendAudit(db, 'auth.setup', 'auth', null, { client: who });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    if (auth.check(token)) appendAudit(db, 'auth.logout', 'auth', null, { client: who });
    auth.logout(token);
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': clearCookie(), 'Clear-Site-Data': '"cache", "storage", "cookies"' });
  }
  if (m === 'GET' && PUBLIC_FILES.has(p.slice(1))) {
    const file = p.slice(1);
    return send(res, 200, readFileSync(join(PUBLIC, file)), STATIC_TYPES[file.split('.').pop()!]);
  }

  // ---- מכאן: רק עם כניסה תקפה ----
  if (!auth.check(token)) {
    if (m === 'GET' && !p.startsWith('/api/')) return send(res, 302, '', 'text/plain; charset=utf-8', { Location: '/login.html' });
    throw new HttpError(401, 'נדרשת כניסה');
  }

  // ---- ממשק (קבצים סטטיים) ----
  if (m === 'GET' && !p.startsWith('/api/')) {
    const file = p === '/' ? 'index.html' : p.slice(1);
    if (!/^[\w-]+\.(html|js|css)$/.test(file)) throw new HttpError(404, 'not found');
    const full = join(PUBLIC, file);
    if (!existsSync(full)) throw new HttpError(404, 'not found');
    return send(res, 200, readFileSync(full), STATIC_TYPES[file.split('.').pop()!]);
  }

  const body = m === 'GET' ? {} : await readJson(req);
  const result = await route(db, platform, { method: m, path: p, query: url.searchParams, body });
  if (result) {
    if ('json' in result) return send(res, result.status, result.json);
    if ('html' in result) return send(res, result.status, result.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': DOC_CSP });
    // מסמך/דוח: קודם מפיקים PDF, ורק אם הצליח – רושמים (finalize)
    const pdf = await htmlToPdf(result.printable.html);
    const label = result.printable.finalize?.().label;
    if (label === 'מקור') writeFileSync(join(OUTPUTS, result.printable.filename), pdf);   // ארכיון המקור שהופק
    return send(res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="${result.printable.filename}"` });
  }

  // ---- נתיבים של גרסת השרת בלבד ----
  const mm = p.match(/^\/api\/expenses\/(\d+)\/attachment$/);
  if (mm && m === 'GET') {
    const r = db.prepare('SELECT attachment FROM expenses WHERE id = ?').get(Number(mm[1])) as { attachment: string | null } | undefined;
    if (!r?.attachment) throw new HttpError(404, 'not found');
    const a = JSON.parse(r.attachment);
    if (!/^[0-9a-f]{64}\.\w+$/.test(a.file)) throw new HttpError(404, 'not found');
    const full = join(DATA_DIR, 'attachments', a.file);
    if (!existsSync(full)) throw new HttpError(404, 'not found');
    const bytes = readFileSync(full);
    const type = sniffAttachmentType(bytes);   // הסוג נקבע שוב לפי התוכן (גם לקבצים שנשמרו לפני הבדיקה)
    if (!type) throw new HttpError(404, 'not found');
    appendAudit(db, 'attachment.view', 'expense', Number(mm[1]), { client: who });
    return send(res, 200, bytes, type, {
      'Content-Disposition': `inline; filename="expense-${mm[1]}.${ATT_EXT[type]}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    });
  }
  if (p === '/api/backup/status' && m === 'GET') {
    const log = db.prepare('SELECT * FROM backups_log ORDER BY id DESC LIMIT 30').all();
    return send(res, 200, { ...backupStatus(db), drives: availableDrives(), dataDir: DATA_DIR, log, mode: 'server' });
  }
  if (p === '/api/backup/target' && m === 'POST') { setBackupTarget(db, body.target); return send(res, 200, backupStatus(db)); }
  if (p === '/api/backup/run' && m === 'POST') {
    const k = body.kind === 'local' ? 'local' : 'external';
    const target = k === 'local' ? join(DATA_DIR, 'backups') : backupStatus(db).target;
    if (!target) throw new HttpError(400, 'לא הוגדרה תיקיית יעד לגיבוי');
    mkdirSync(target, { recursive: true });
    return send(res, 200, createBackup(db, { dataDir: DATA_DIR, targetDir: target, kind: k }));
  }
  if (p === '/api/backup/verify' && m === 'POST') return send(res, 200, verifyBackup(allowedBackupDir(body.path)));
  // פלט מהגיבוי (25(ו)(3)): יומן רשומות שמופק ישירות ממסד הגיבוי
  if (p === '/api/backup/report' && m === 'GET') {
    const dir = allowedBackupDir(url.searchParams.get('path'));
    const v = verifyBackup(dir);
    if (!v.manifest) throw new HttpError(400, v.problems.join('; '));
    const bdb = openBackupDb(dir);
    try {
      const prof = bdb.prepare('SELECT data FROM business_profile_versions ORDER BY id DESC LIMIT 1').get() as { data: string } | undefined;
      const docs = bdb.prepare('SELECT * FROM documents ORDER BY id').all() as DocumentRow[];
      const html = renderReport({
        businessName: prof ? JSON.parse(prof.data).name : '-', title: 'יומן רשומות – הופק מגיבוי',
        period: `גיבוי מיום ${v.manifest.createdAt.slice(0, 10)} (${dir.split(/[\\/]/).pop()})`, producedAt: nowIso(),
        bodyHtml: `${v.ok ? '' : `<p style="color:#b00"><b>אזהרה – בעיות בגיבוי:</b> ${v.problems.join('; ')}</p>`}${journalBody(docs)}<h3>בדיקת רצף בגיבוי</h3>${continuityBody(continuityReport(bdb))}`,
      });
      appendAudit(db, 'backup.report', 'backup', null, { path: dir });
      return send(res, 200, await htmlToPdf(html), 'application/pdf');
    } finally { bdb.close(); }
  }
  throw new HttpError(404, 'not found');
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof AuthError) return send(res, err.status, { error: err.message });
    if (err instanceof ValidationError) return send(res, 422, { error: err.message, errors: err.errors, warnings: err.warnings });
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    const msg = String(err?.message ?? err);
    if (msg.includes('FORBIDDEN')) return send(res, 409, { error: msg });
    if (!(err instanceof Error) || !/^[֐-׿]/.test(msg)) console.error(err);
    send(res, 400, { error: msg });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`פנקס פועל: http://localhost:${PORT}  (נתונים: ${DATA_DIR})`);
  if (!auth.configured()) console.log(`הכניסה עוד לא הוגדרה. קוד ההגדרה נמצא בקובץ: ${auth.tokenFile}`);
});

// גיבוי מקומי אוטומטי: בהפעלה, ואחר כך בדיקה כל שעה (פעם ביום בפועל).
const runDaily = () => {
  try { const d = dailyLocalBackup(db, DATA_DIR); if (d) console.log(`גיבוי יומי נוצר: ${d}`); }
  catch (e) { console.error('גיבוי יומי נכשל:', e); }
};
runDaily();
setInterval(runDaily, 60 * 60 * 1000).unref();
