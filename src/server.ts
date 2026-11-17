/**
 * שרת מקומי בלבד (127.0.0.1). מגיש את הממשק ומפעיל את הנתב המשותף (routes.ts).
 * הגנות: האזנה ל-localhost בלבד; בדיקת Host (נגד DNS rebinding);
 * כל פעולת כתיבה מחייבת כותרת X-Pinkas (נגד CSRF מאתרים אחרים).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/open.ts';
import { appendAudit } from './core/audit.ts';
import { ValidationError, type DocumentRow } from './core/documents.ts';
import { continuityReport } from './core/reports.ts';
import { nowIso } from './core/util.ts';
import { continuityBody, journalBody, renderReport } from './render/html.ts';
import { htmlToPdf } from './render/pdf.ts';
import {
  availableDrives, backupStatus, createBackup, dailyLocalBackup, fsAttachmentSaver, openBackupDb, setBackupTarget, verifyBackup,
} from './core/backup.ts';
import { HttpError, route, type Platform } from './routes.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const DATA_DIR = resolve(arg('data') ?? process.env.PINKAS_DATA ?? join(ROOT, 'data'));
const PORT = Number(arg('port') ?? process.env.PINKAS_PORT ?? 5174);
const PUBLIC = join(ROOT, 'public');
const OUTPUTS = join(DATA_DIR, 'outputs');
mkdirSync(OUTPUTS, { recursive: true });

const db = openDb(join(DATA_DIR, 'pinkas.db'));

const platform: Platform = {
  saveAttachment: fsAttachmentSaver(DATA_DIR),
  backupExtras: (d) => { const s = backupStatus(d); return { target: s.target, targetAvailable: s.targetAvailable }; },
};

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}

async function readJson(req: IncomingMessage, maxBytes = 15_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > maxBytes) throw new HttpError(413, 'בקשה גדולה מדי'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON לא תקין'); }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host ?? '';
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) throw new HttpError(403, 'Host not allowed');
  const url = new URL(req.url ?? '/', `http://${host}`);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (m !== 'GET' && req.headers['x-pinkas'] !== '1') throw new HttpError(403, 'missing X-Pinkas header');

  // ---- ממשק (קבצים סטטיים) ----
  if (m === 'GET' && !p.startsWith('/api/')) {
    const file = p === '/' ? 'index.html' : p.slice(1);
    if (!/^[\w.-]+$/.test(file)) throw new HttpError(404, 'not found');
    const full = join(PUBLIC, file);
    if (!existsSync(full)) throw new HttpError(404, 'not found');
    const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
    return send(res, 200, readFileSync(full), type);
  }

  const body = m === 'GET' ? {} : await readJson(req);
  const result = await route(db, platform, { method: m, path: p, query: url.searchParams, body });
  if (result) {
    if ('json' in result) return send(res, result.status, result.json);
    if ('html' in result) return send(res, result.status, result.html, 'text/html; charset=utf-8');
    // מסמך/דוח: קודם מפיקים PDF, ורק אם הצליח – רושמים (finalize)
    const pdf = await htmlToPdf(result.printable.html);
    const label = result.printable.finalize?.().label;
    if (label === 'מקור') writeFileSync(join(OUTPUTS, result.printable.filename), pdf);   // ארכיון המקור שהופק
    return send(res, 200, pdf, 'application/pdf', { 'Content-Disposition': `attachment; filename="${result.printable.filename}"` });
  }

  // ---- נתיבים של גרסת המחשב בלבד ----
  const mm = p.match(/^\/api\/expenses\/(\d+)\/attachment$/);
  if (mm && m === 'GET') {
    const r = db.prepare('SELECT attachment FROM expenses WHERE id = ?').get(Number(mm[1])) as { attachment: string | null } | undefined;
    if (!r?.attachment) throw new HttpError(404, 'אין קובץ מצורף');
    const a = JSON.parse(r.attachment);
    if (!/^[0-9a-f]{64}\.\w+$/.test(a.file)) throw new HttpError(400, 'bad file');
    return send(res, 200, readFileSync(join(DATA_DIR, 'attachments', a.file)), a.type);
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
  if (p === '/api/backup/verify' && m === 'POST') return send(res, 200, verifyBackup(body.path));
  // פלט מהגיבוי (25(ו)(3)): יומן רשומות שמופק ישירות ממסד הגיבוי
  if (p === '/api/backup/report' && m === 'GET') {
    const dir = url.searchParams.get('path') ?? '';
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
    if (err instanceof ValidationError) return send(res, 422, { error: err.message, errors: err.errors, warnings: err.warnings });
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    const msg = String(err?.message ?? err);
    if (msg.includes('FORBIDDEN')) return send(res, 409, { error: msg });
    if (!(err instanceof Error) || !/^[֐-׿]/.test(msg)) console.error(err);
    send(res, 400, { error: msg });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`פנקס פועל: http://localhost:${PORT}  (נתונים: ${DATA_DIR})`);
});

// גיבוי מקומי אוטומטי: בהפעלה, ואחר כך בדיקה כל שעה (פעם ביום בפועל).
const runDaily = () => {
  try { const d = dailyLocalBackup(db, DATA_DIR); if (d) console.log(`גיבוי יומי נוצר: ${d}`); }
  catch (e) { console.error('גיבוי יומי נכשל:', e); }
};
runDaily();
setInterval(runDaily, 60 * 60 * 1000).unref();
