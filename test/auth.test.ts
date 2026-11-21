import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth, base32Decode, base32Encode, counterAt, hashPassword, parseCookies, totp, verifyPassword } from '../src/auth.ts';

describe('TOTP / base32 / סיסמה', () => {
  test('וקטור הבדיקה של RFC 6238 (SHA1)', () => {
    const key = Buffer.from('12345678901234567890');
    // 8 ספרות לפי ה-RFC; 6 ספרות = 6 הספרות האחרונות
    assert.equal(totp(key, counterAt(59_000), 8), '94287082');
    assert.equal(totp(key, counterAt(1111111109_000), 8), '07081804');
    assert.equal(totp(key, counterAt(20000000000_000), 8), '65353130');
    assert.equal(totp(key, counterAt(59_000)), '287082');
  });
  test('base32 הלוך-חזור, ווקטור RFC 4648', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    for (let n = 0; n < 40; n++) {
      const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255));
      assert.deepEqual(base32Decode(base32Encode(b)), b);
    }
  });
  test('סיסמה: scrypt עם salt, אימות נכון ושגוי', () => {
    const h = hashPassword('correct horse battery');
    assert.notEqual(h, hashPassword('correct horse battery'));
    assert.equal(verifyPassword('correct horse battery', h), true);
    assert.equal(verifyPassword('correct horse batterY', h), false);
  });
  test('פענוח עוגיות', () => {
    assert.deepEqual(parseCookies('a=1; pinkas_session=xyz=; b'), { a: '1', pinkas_session: 'xyz=' });
  });
});

describe('Auth – הגדרה, כניסה, נעילה, ניתוק', () => {
  let dir: string; let t: number; let auth: Auth;
  const code = (secret: string, at = t) => totp(base32Decode(secret), counterAt(at));
  const setup = (pw = 'a-long-password-1') => {
    const token = readFileSync(join(dir, 'setup-token.txt'), 'utf8').trim();
    const { secret } = auth.setupStart(token, pw);
    auth.setupFinish(token, code(secret));
    return secret;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pinkas-auth-'));
    t = Date.UTC(2026, 10, 21, 12, 0, 0);
    auth = new Auth({ dataDir: dir, now: () => t });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('הגדרה ראשונית מחייבת קוד הגדרה; אחרי ההגדרה הקוד נמחק ואי אפשר להגדיר שוב', () => {
    assert.equal(auth.configured(), false);
    assert.throws(() => auth.setupStart('WRONG', 'a-long-password-1'), /קוד ההגדרה שגוי/);
    const token = readFileSync(join(dir, 'setup-token.txt'), 'utf8').trim();
    assert.throws(() => auth.setupStart(token, 'short'), /12 תווים/);
    const { secret, uri } = auth.setupStart(token, 'a-long-password-1');
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.throws(() => auth.setupFinish(token, '000000'), /הקוד שגוי/);
    auth.setupFinish(token, code(secret));
    assert.equal(auth.configured(), true);
    assert.equal(existsSync(join(dir, 'setup-token.txt')), false);
    assert.throws(() => auth.setupStart(token, 'a-long-password-1'), /כבר הוגדרה/);
  });

  test('כניסה: נדרשים סיסמה וקוד נכונים; קוד שכבר שומש נדחה', () => {
    const secret = setup();
    t += 30_000;
    assert.throws(() => auth.login('wrong-password-x', code(secret)), /שגויים/);
    t += 30_000;
    assert.throws(() => auth.login('a-long-password-1', '123456'), /שגויים/);
    const c = code(secret);
    const tok = auth.login('a-long-password-1', c);
    assert.equal(auth.check(tok), true);
    assert.throws(() => auth.login('a-long-password-1', c), /שגויים/);   // אותו קוד שוב
  });

  test('נעילה אחרי 5 כישלונות, גם לסיסמה נכונה; נעילה שנייה ארוכה יותר', () => {
    const secret = setup();
    for (let i = 0; i < 5; i++) assert.throws(() => auth.login('nope-nope-nope', '000000'));
    t += 60_000;
    assert.throws(() => auth.login('a-long-password-1', code(secret)), /נעולה/);
    t += 15 * 60_000;
    for (let i = 0; i < 5; i++) assert.throws(() => auth.login('nope-nope-nope', '000000'));
    t += 16 * 60_000;
    assert.throws(() => auth.login('a-long-password-1', code(secret)), /נעולה/);   // עכשיו 30 דקות
    t += 15 * 60_000;
    assert.ok(auth.login('a-long-password-1', code(secret)));
  });

  test('ניתוק: אחרי 30 דקות בלי פעולה, ואחרי 12 שעות בכל מקרה; יציאה מבטלת', () => {
    const secret = setup();
    t += 30_000;
    let tok = auth.login('a-long-password-1', code(secret));
    t += 29 * 60_000; assert.equal(auth.check(tok), true);
    t += 31 * 60_000; assert.equal(auth.check(tok), false);
    t += 60_000;
    tok = auth.login('a-long-password-1', code(secret));
    for (let i = 0; i < 25; i++) { t += 29 * 60_000; auth.check(tok); }
    assert.equal(auth.check(tok), false);
    t += 60_000;
    tok = auth.login('a-long-password-1', code(secret));
    auth.logout(tok);
    assert.equal(auth.check(tok), false);
    assert.equal(auth.check(undefined), false);
    assert.equal(auth.check('forged'), false);
  });

  test('הפרטים נשמרים בקובץ: הפעלה מחדש של השרת דורשת כניסה מחדש, אבל הסיסמה נשמרת', () => {
    const secret = setup();
    t += 30_000;
    const tok = auth.login('a-long-password-1', code(secret));
    const again = new Auth({ dataDir: dir, now: () => t });
    assert.equal(again.check(tok), false);
    t += 30_000;
    assert.ok(again.login('a-long-password-1', code(secret)));
    const stored = readFileSync(join(dir, 'auth.json'), 'utf8');
    assert.ok(!stored.includes('a-long-password-1'));
  });
});
