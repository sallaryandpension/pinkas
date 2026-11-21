/**
 * פנקס – גרסת הדפדפן. כל המערכת רצה מקומית בדפדפן:
 * SQLite (sql.js) + אותו קוד ליבה ונתב כמו בגרסת המחשב. הנתונים נשמרים ב-IndexedDB של הדפדפן הזה בלבד.
 */
import schemaSql from '../src/db/schema.sql';
import { route, HttpError, type Platform, type ApiResult } from '../src/routes.ts';
import { ValidationError, type DocumentRow } from '../src/core/documents.ts';
import { continuityReport } from '../src/core/reports.ts';
import { verifyAuditChain, appendAudit } from '../src/core/audit.ts';
import { verifyExpenses } from '../src/core/expenses.ts';
import { verifyOtherIncome } from '../src/core/otherIncome.ts';
import { quarterlyBackupStatus } from '../src/core/backupStatus.ts';
import { inTransaction } from '../src/db/tx.ts';
import { nowIso, sha256Bytes, todayIL, base64ToBytes } from '../src/core/util.ts';
import { continuityBody, journalBody, renderReport } from '../src/render/html.ts';
import { BrowserDatabase } from './sqlite.ts';
import { store, DB_NAME } from './store.ts';
import { seedDemo } from './demoSeed.ts';

declare const __DEMO__: boolean;

/** בדמו: סימן מים "דמו" על כל מסמך/דוח, כדי שאף הדפסה לא תיראה כמסמך אמיתי. */
const DEMO_MARK = '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:9999">'
  + '<div style="transform:rotate(-30deg);font:700 90px Arial,sans-serif;color:rgba(200,0,0,.15);white-space:nowrap">דמו – לא מסמך אמיתי</div></div>';
const demoMark = (html: string) => (__DEMO__ ? (html.includes('</body>') ? html.replace('</body>', `${DEMO_MARK}</body>`) : html + DEMO_MARK) : html);

/** איפוס הדמו: מחיקת מסד הדמו בדפדפן הזה וטעינה מחדש עם נתוני הדוגמה. */
function resetDemo() {
  if (!__DEMO__) return;
  const r = indexedDB.deleteDatabase(DB_NAME);
  r.onsuccess = r.onerror = r.onblocked = () => location.reload();
}

declare const initSqlJs: (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new (data?: Uint8Array) => any }>;

let SQL: { Database: new (data?: Uint8Array) => any };
let db: BrowserDatabase;
let lastSavedChanges = 0;
const pendingWrites: Promise<unknown>[] = [];

// ---------------------------------------------------------------- אתחול
async function openDatabase(bytes?: Uint8Array): Promise<BrowserDatabase> {
  const d = new BrowserDatabase(new SQL.Database(bytes));
  d.exec('PRAGMA foreign_keys = ON;');
  d.exec(schemaSql);
  return d;
}

async function persist(force = false) {
  const changes = db.totalChanges();
  if (!force && changes === lastSavedChanges) return;
  await store.put('kv', 'db', db.export());
  lastSavedChanges = db.totalChanges();
}

async function dailySnapshot() {
  const today = todayIL();
  const keys = (await store.keys('snapshots')).sort();
  if (keys.includes(today)) return;
  await store.put('snapshots', today, db.export());
  for (const old of keys.slice(0, Math.max(0, keys.length + 1 - 14))) await store.del('snapshots', old);
  const docCount = (db.prepare('SELECT COUNT(*) c FROM documents').get() as { c: number }).c;
  inTransaction(db, () => {
    db.prepare('INSERT INTO backups_log (at, kind, path, doc_count, verified_ok, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowIso(), 'local', `browser-snapshot:${today}`, docCount, 1, '{}');
  });
  await persist(true);
}

async function init() {
  SQL = await initSqlJs({ locateFile: (f) => f });
  const bytes = await store.get<Uint8Array>('kv', 'db');
  db = await openDatabase(bytes ?? undefined);
  if (__DEMO__ && !bytes) seedDemo(db as any);   // דמו: נתוני דוגמה בפעם הראשונה
  await persist(true);
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  await dailySnapshot();
}

// ---------------------------------------------------------------- פלטפורמה
const platform: Platform = {
  saveAttachment: (file, bytes) => { pendingWrites.push(store.put('attachments', file, bytes)); },
};

async function isPersisted(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) ?? false; } catch { return false; }
}

// ---------------------------------------------------------------- API מקומי (אותן תשובות כמו השרת)
function apiError(status: number, data: Record<string, unknown>) {
  const e = new Error(String(data.error ?? 'שגיאה'));
  Object.assign(e, data, { status });
  return e;
}

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const url = new URL(path, 'http://local');
  const method = opts.method ?? 'GET';
  try {
    if (url.pathname === '/api/backup/status') return await backupStatus();
    const result = await route(db as any, platform, { method, path: url.pathname, query: url.searchParams, body: opts.body ?? {} });
    if (!result) throw new HttpError(404, 'לא זמין בגרסת הדפדפן');
    return await finish(result);
  } catch (err: any) {
    if (err instanceof ValidationError) throw apiError(422, { error: err.message, errors: err.errors, warnings: err.warnings });
    if (err instanceof HttpError) throw apiError(err.status, { error: err.message });
    const msg = String(err?.message ?? err);
    throw apiError(msg.includes('FORBIDDEN') ? 409 : 400, { error: msg });
  } finally {
    await Promise.all(pendingWrites.splice(0));
    await persist();
  }
}

async function finish(result: ApiResult) {
  if ('json' in result) {
    const j = result.json as any;
    return __DEMO__ && j && typeof j.html === 'string' ? { ...j, html: demoMark(j.html) } : j;   // תצוגה מקדימה
  }
  if ('html' in result) return { html: demoMark(result.html) };
  const label = result.printable.finalize?.().label;   // ההדפסה עצמה נעשית בממשק
  if (label === 'מקור') pendingWrites.push(store.put('outputs', result.printable.filename.replace(/\.pdf$/, '.html'), result.printable.html));
  return { printable: { html: result.printable.html, filename: result.printable.filename } };
}

// ---------------------------------------------------------------- הדפסה / PDF
/** מדפיס HTML דרך iframe נסתר – בחלון ההדפסה בוחרים "שמירה כ-PDF". */
function printHtml(html: string, filename: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(frame);
  const title = filename.replace(/\.pdf$/, '');
  frame.onload = () => {
    try { frame.contentDocument!.title = title; } catch { /* ignore */ }
    const prev = document.title; document.title = title;      // שם הקובץ המוצע ב"שמירה כ-PDF"
    setTimeout(() => {
      frame.contentWindow!.focus(); frame.contentWindow!.print();
      setTimeout(() => { document.title = prev; frame.remove(); }, 1500);
    }, 100);
  };
  frame.srcdoc = demoMark(html);   // כל הדפסה (מסמך, דוח, דוח מגיבוי) עוברת כאן
}

function showHtmlInWindow(win: Window | null, html: string) {
  if (!win) { printHtml(html, 'document'); return; }
  win.document.open(); win.document.write(html); win.document.close();
}

async function openAttachment(win: Window | null, id: number) {
  const r = db.prepare('SELECT attachment FROM expenses WHERE id = ?').get(id) as { attachment: string | null } | undefined;
  if (!r?.attachment) throw new Error('אין קובץ מצורף');
  const a = JSON.parse(r.attachment);
  const bytes = await store.get<Uint8Array>('attachments', a.file);
  if (!bytes) throw new Error('הקובץ המצורף לא נמצא בדפדפן הזה');
  const url = URL.createObjectURL(new Blob([bytes], { type: a.type }));
  if (win) win.location.href = url; else window.open(url, '_blank');
}

// ---------------------------------------------------------------- גיבוי לקובץ (הוראה 25(ו))
type BackupFile = {
  app: 'pinkas'; formatVersion: 1; kind: 'browser-export'; createdAt: string; docCount: number;
  lastNumbers: Record<string, number | null>;
  db: string; dbSha256: string;
  attachments: Record<string, string>;   // file → base64
  outputs: Record<string, string>;       // name → html
};

const bytesToBase64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

function stampIL() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}${p.second}`;
}

async function backupStatus() {
  const log = db.prepare('SELECT * FROM backups_log ORDER BY id DESC LIMIT 30').all();
  return { ...quarterlyBackupStatus(db as any), mode: 'browser', persisted: await isPersisted(), log };
}

/** בדיקת קובץ גיבוי: hash, שלמות המסד, רצף, שרשראות. מחזיר גם את המסד הפתוח (לדוח מהגיבוי). */
async function inspectBackup(data: BackupFile) {
  const problems: string[] = [];
  if (data?.app !== 'pinkas' || data.formatVersion !== 1) return { ok: false, problems: ['זה לא קובץ גיבוי של פנקס'], docCount: 0, bdb: null as BrowserDatabase | null, data };
  const dbBytes = base64ToBytes(data.db);
  if (sha256Bytes(dbBytes) !== data.dbSha256) problems.push('קובץ המסד בגיבוי שונה מאז שנוצר');
  for (const [file, b64] of Object.entries(data.attachments ?? {})) {
    if (!file.startsWith(sha256Bytes(base64ToBytes(b64)))) problems.push(`קובץ מצורף פגום: ${file}`);
  }
  let docCount = 0;
  let bdb: BrowserDatabase | null = null;
  try {
    bdb = new BrowserDatabase(new SQL.Database(dbBytes));
    const ic = bdb.prepare('PRAGMA integrity_check').get() as Record<string, string>;
    if (Object.values(ic)[0] !== 'ok') problems.push('בדיקת שלמות המסד נכשלה');
    const series = continuityReport(bdb as any);
    docCount = series.reduce((s, x) => s + x.count, 0);
    for (const s of series) if (!s.ok) problems.push(`רצף/תוכן לא תקין בסדרה ${s.name}`);
    if (!verifyAuditChain(bdb as any).ok) problems.push('יומן האירועים בגיבוי פגום');
    if (!verifyExpenses(bdb as any).ok) problems.push('רישומי ההוצאות בגיבוי פגומים');
    if (!verifyOtherIncome(bdb as any).ok) problems.push('רישומי ההכנסות הנוספות בגיבוי פגומים');
    if (docCount !== data.docCount) problems.push(`מספר המסמכים (${docCount}) שונה מהרשום בגיבוי (${data.docCount})`);
  } catch (e: any) { problems.push(`לא ניתן לפתוח את המסד: ${e.message}`); }
  return { ok: problems.length === 0, problems, docCount, bdb, data };
}

async function exportBackup() {
  await persist(true);
  const series = continuityReport(db as any);
  const dbBytes = db.export();
  const attachments: Record<string, string> = {};
  for (const k of await store.keys('attachments')) attachments[k] = bytesToBase64(await store.get<Uint8Array>('attachments', k) as Uint8Array);
  const outputs: Record<string, string> = {};
  for (const k of await store.keys('outputs')) outputs[k] = await store.get<string>('outputs', k) as string;
  const data: BackupFile = {
    app: 'pinkas', formatVersion: 1, kind: 'browser-export', createdAt: nowIso(),
    docCount: series.reduce((s, x) => s + x.count, 0), lastNumbers: Object.fromEntries(series.map((s) => [s.docType, s.lastNumber])),
    db: bytesToBase64(dbBytes), dbSha256: sha256Bytes(dbBytes), attachments, outputs,
  };
  const check = await inspectBackup(JSON.parse(JSON.stringify(data)));   // אימות מיידי של מה שנכתב
  check.bdb?.close();
  const name = `pinkas-backup-${stampIL()}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  inTransaction(db, () => {
    db.prepare('INSERT INTO backups_log (at, kind, path, doc_count, verified_ok, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(data.createdAt, 'external', `download:${name}`, data.docCount, check.ok ? 1 : 0, JSON.stringify({ problems: check.problems }));
    appendAudit(db as any, 'backup.create', 'backup', null, { kind: 'external', path: name, ok: check.ok });
  });
  await persist(true);
  return { name, verify: { ok: check.ok, problems: check.problems, docCount: check.docCount } };
}

async function readBackupFile(file: File): Promise<BackupFile> {
  try { return JSON.parse(await file.text()); } catch { throw new Error('הקובץ אינו קובץ גיבוי תקין'); }
}

async function verifyBackupFile(file: File) {
  const r = await inspectBackup(await readBackupFile(file));
  r.bdb?.close();
  return { ok: r.ok, problems: r.problems, docCount: r.docCount, createdAt: r.data?.createdAt };
}

/** פלט מהגיבוי (25(ו)(3)): יומן רשומות + רצף, ישירות ממסד הגיבוי. */
async function reportFromBackupFile(file: File) {
  const r = await inspectBackup(await readBackupFile(file));
  if (!r.bdb) throw new Error(r.problems.join('; '));
  try {
    const prof = r.bdb.prepare('SELECT data FROM business_profile_versions ORDER BY id DESC LIMIT 1').get() as { data: string } | undefined;
    const docs = r.bdb.prepare('SELECT * FROM documents ORDER BY id').all() as unknown as DocumentRow[];
    const html = renderReport({
      businessName: prof ? JSON.parse(prof.data).name : '-', title: 'יומן רשומות – הופק מגיבוי',
      period: `גיבוי מיום ${r.data.createdAt.slice(0, 10)} (${file.name})`, producedAt: nowIso(),
      bodyHtml: `${r.ok ? '' : `<p style="color:#b00"><b>אזהרה – בעיות בגיבוי:</b> ${r.problems.join('; ')}</p>`}${journalBody(docs)}<h3>בדיקת רצף בגיבוי</h3>${continuityBody(continuityReport(r.bdb as any))}`,
    });
    inTransaction(db, () => appendAudit(db as any, 'backup.report', 'backup', null, { path: file.name }));
    await persist();
    printHtml(html, 'report-from-backup');
  } finally { r.bdb.close(); }
}

/** שחזור מגיבוי – רק לדפדפן ריק (בלי מסמכים/הוצאות/הכנסות), כדי שלעולם לא נדרוס ספרים קיימים. */
async function restoreFromFile(file: File) {
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  if (count('documents') + count('expenses') + count('other_income') > 0)
    throw new Error('בדפדפן הזה כבר יש רישומים. שחזור אפשרי רק לדפדפן ריק, כדי לא לדרוס ספרים קיימים.');
  const r = await inspectBackup(await readBackupFile(file));
  r.bdb?.close();
  if (!r.ok) throw new Error(`הגיבוי לא תקין – לא שוחזר: ${r.problems.join('; ')}`);
  for (const [k, b64] of Object.entries(r.data.attachments ?? {})) await store.put('attachments', k, base64ToBytes(b64));
  for (const [k, html] of Object.entries(r.data.outputs ?? {})) await store.put('outputs', k, html);
  db.close();
  db = await openDatabase(base64ToBytes(r.data.db));
  inTransaction(db, () => appendAudit(db as any, 'backup.restore', 'backup', null, { file: file.name, createdAt: r.data.createdAt }));
  await persist(true);
  return { docCount: r.docCount };
}

// ---------------------------------------------------------------- חשיפה לממשק
(window as any).pinkasLocal = {
  api, print: printHtml, showHtmlInWindow, openAttachment, exportBackup, verifyBackupFile, reportFromBackupFile, restoreFromFile,
};
if (__DEMO__) {
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#fff3cd;color:#664d03;border-bottom:1px solid #ffe69c;padding:8px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:14px';
  bar.innerHTML = '<b>גרסת דמו</b><span>כל הנתונים בדויים ונשמרים רק בדפדפן הזה. אפשר לנסות הכול בחופשיות – זה לא משפיע על הספרים האמיתיים.</span>';
  const btn = document.createElement('button');
  btn.className = 'btn small'; btn.textContent = 'איפוס הדמו (חזרה לנתוני הדוגמה)';
  btn.onclick = () => { if (confirm('למחוק את כל מה ששינית בדמו ולחזור לנתוני הדוגמה?')) resetDemo(); };
  bar.appendChild(btn);
  document.body.prepend(bar);
}
(window as any).pinkasReady = init().catch((e) => {
  document.body.innerHTML = `<div style="padding:24px;font-family:Arial;direction:rtl"><h2>פנקס לא הצליח לעלות</h2><p>${String(e?.message ?? e)}</p>
    <p>ודא שהדפדפן מעודכן (Chrome / Edge) ושלא נחסם אחסון מקומי לאתר.</p></div>`;
  throw e;
});
