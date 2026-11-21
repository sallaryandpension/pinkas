// בדיקות קצה-לקצה של שכבת האבטחה בשרת (חלק ד' של מסמך הדרישות): מריצים את השרת האמיתי בתהליך נפרד.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode, counterAt, totp } from '../src/auth.ts';

const PORT = 5190 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;
let dir: string; let proc: ChildProcess; let cookie = ''; let secret = '';

const req = (path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) =>
  fetch(BASE + path, {
    method: opts.method ?? 'GET', redirect: 'manual',
    headers: {
      ...(opts.method && opts.method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Pinkas': '1' } : {}),
      ...(opts.auth === false ? {} : cookie ? { Cookie: cookie } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const codeNow = (offset = 0) => totp(base32Decode(secret), counterAt(Date.now()) + offset);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pinkas-srv-'));
  proc = spawn(process.execPath, ['src/server.ts', '--data', dir, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 15_000);
    proc.stdout!.on('data', (d) => { if (String(d).includes('פנקס פועל')) { clearTimeout(to); resolve(); } });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => { proc.kill(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

describe('שרת: כניסה וכותרות אבטחה', () => {
  test('ד.1 בלי כניסה: הממשק מפנה לדף הכניסה, ה-API מחזיר 401', async () => {
    for (const p of ['/', '/index.html', '/app.js']) {
      const r = await req(p);
      assert.equal(r.status, 302, p); assert.equal(r.headers.get('location'), '/login.html');
    }
    for (const p of ['/api/documents', '/api/expenses/1/attachment', '/api/backup/status']) assert.equal((await req(p)).status, 401, p);
    assert.equal((await req('/api/documents', { method: 'POST', body: {} })).status, 401);
    assert.equal((await req('/login.html')).status, 200);
  });

  test('כותרות אבטחה בכל תשובה', async () => {
    const r = await req('/login.html');
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
  });

  test('Host זר נדחה (DNS rebinding); Origin זר וחוסר X-Pinkas נדחים בכתיבה', async () => {
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: PORT, path: '/login.html', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject); r.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await req('/api/auth/login', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
  });

  test('הגדרה ראשונית עם קוד ההגדרה, ואז כניסה עם סיסמה + קוד', async () => {
    const token = readFileSync(join(dir, 'setup-token.txt'), 'utf8').trim();
    assert.equal((await req('/api/auth/setup/start', { method: 'POST', body: { token: 'NOPE', password: 'x'.repeat(14) } })).status, 401);
    const s = await (await req('/api/auth/setup/start', { method: 'POST', body: { token, password: 'server-test-pass' } })).json();
    secret = s.secret;
    const first = codeNow();
    assert.equal((await req('/api/auth/setup/finish', { method: 'POST', body: { token, code: first } })).status, 200);
    assert.equal((await req('/api/auth/login', { method: 'POST', body: { password: 'server-test-pass', code: first } })).status, 401, 'אותו קוד פעמיים');
    // הקוד הבא (מותר חלון אחד קדימה בגלל סטיית שעון)
    const r = await req('/api/auth/login', { method: 'POST', body: { password: 'server-test-pass', code: codeNow(1) } });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie') ?? '';
    assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
    cookie = sc.split(';')[0];
    assert.equal((await req('/')).status, 200);
    assert.equal((await req('/api/documents')).status, 200);
  });

  test('קובץ מצורף מסוג HTML נדחה; נתיב גיבוי מחוץ לתיקיות הגיבוי נדחה', async () => {
    const r = await req('/api/expenses', { method: 'POST', body: {
      expenseDate: new Date().toISOString().slice(0, 10), supplierName: 'ספק', docKind: 'receipt', docNumber: '1', description: 'x',
      category: 'אחר', amountAgorot: 100, paymentMethod: 'cash', acknowledgeWarnings: true,
      attachment: { name: 'r.pdf', type: 'application/pdf', base64: Buffer.from('<script>alert(1)</script>').toString('base64') } } });
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(await r.json()), /סוג קובץ/);
    for (const path of [dir, join(dir, '..'), 'C:\\Windows', '/etc']) {
      assert.equal((await req('/api/backup/verify', { method: 'POST', body: { path } })).status, 403, path);
    }
    assert.equal((await req(`/api/backup/report?path=${encodeURIComponent(join(dir, 'backups', '..', '..'))}`)).status, 403);
  });

  test('ד.4 יציאה: העוגייה בוטלה, Clear-Site-Data נשלח, והגישה נחסמת', async () => {
    const r = await req('/api/auth/logout', { method: 'POST' });
    assert.match(r.headers.get('clear-site-data') ?? '', /"storage"/);
    assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal((await req('/api/documents')).status, 401);
  });

  test('יומן: כניסות, כישלונות ויציאה נרשמים ב-audit_log', async () => {
    // נכנסים שוב כדי לקרוא את היומן דרך ה-API של בדיקת השרשרת
    await new Promise((res) => setTimeout(res, 50));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'pinkas.db'), { readOnly: true });
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'auth.%'").all() as { action: string }[]).map((a) => a.action);
    db.close();
    for (const a of ['auth.setup', 'auth.login', 'auth.login_failed', 'auth.setup_failed', 'auth.logout']) assert.ok(actions.includes(a), a);
  });
});
