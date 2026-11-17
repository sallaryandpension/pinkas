/**
 * שרת מקומי בלבד (127.0.0.1). מגיש את הממשק ו-API.
 * הגנות: האזנה ל-localhost בלבד; בדיקת Host (נגד DNS rebinding);
 * כל פעולת כתיבה מחייבת כותרת X-Pinkas (נגד CSRF מאתרים אחרים).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/open.ts';
import { appendAudit, verifyAuditChain } from './core/audit.ts';
import { createCustomer, getBusinessProfile, getCustomer, setBusinessProfile, updateCustomer } from './core/entities.ts';
import {
  cancelDocument, DOC_TYPE_NAMES, getDocument, issueDocument, produceOutput, recordOriginalDelivery,
  setSeriesStart, validateIssue, ValidationError, type DocType, type DocumentRow, type IssueInput,
} from './core/documents.ts';
import { continuityReport, customerBalancesAt, customerLedger } from './core/reports.ts';
import { canonicalJson, nowIso, todayIL } from './core/util.ts';
import { balancesBody, continuityBody, journalBody, renderDocument, renderReport } from './render/html.ts';
import { htmlToPdf } from './render/pdf.ts';
import { EXPENSE_CATEGORIES, EXPENSE_DOC_KINDS, EXPENSE_PAYMENT_METHODS, recordExpense, reverseExpense, verifyExpenses, type ExpenseRow } from './core/expenses.ts';
import { annualSummary, exemptCeilingStatus, receiptsPaymentsBook } from './core/books.ts';
import { annualSummaryBody, bookBody } from './render/html.ts';
import { availableDrives, backupStatus, createBackup, dailyLocalBackup, openBackupDb, setBackupTarget, verifyBackup } from './core/backup.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const DATA_DIR = resolve(arg('data') ?? process.env.PINKAS_DATA ?? join(ROOT, 'data'));
const PORT = Number(arg('port') ?? process.env.PINKAS_PORT ?? 5174);
const PUBLIC = join(ROOT, 'public');
const OUTPUTS = join(DATA_DIR, 'outputs');
mkdirSync(OUTPUTS, { recursive: true });

const db = openDb(join(DATA_DIR, 'pinkas.db'));

class HttpError extends Error {
  status: number; payload?: unknown;
  constructor(status: number, message: string, payload?: unknown) { super(message); this.status = status; this.payload = payload; }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > maxBytes) throw new HttpError(413, 'בקשה גדולה מדי'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON לא תקין'); }
}

const listDocs = (type?: string) =>
  (type
    ? db.prepare('SELECT * FROM documents WHERE doc_type = ? ORDER BY id DESC').all(type)
    : db.prepare('SELECT * FROM documents ORDER BY id DESC').all()) as DocumentRow[];

const relatedOf = (d: { body: string }) =>
  ((JSON.parse(d.body).relatedDocumentIds ?? []) as number[]).map((id) => getDocument(db, id)).filter(Boolean) as DocumentRow[];

function docSummary(d: DocumentRow) {
  return {
    id: d.id, type: d.doc_type, typeName: DOC_TYPE_NAMES[d.doc_type], number: d.number, issueDate: d.issue_date,
    customer: JSON.parse(d.customer_snapshot)?.name ?? '', customerId: d.customer_id, total: d.total_agorot,
    status: d.status, cancelReason: d.cancel_reason, originalProducedAt: d.original_produced_at,
    originalDelivery: d.original_delivery ? JSON.parse(d.original_delivery) : null,
    body: JSON.parse(d.body),
  };
}

function pdfName(d: DocumentRow, label: string) {
  return `${d.doc_type}-${d.number}-${label === 'מקור' ? 'original' : 'copy'}.pdf`;
}

async function reportPdf(title: string, period: string, bodyHtml: string, action: string) {
  const business = getBusinessProfile(db);
  const html = renderReport({ businessName: business?.name ?? '-', title, period, producedAt: nowIso(), bodyHtml });
  appendAudit(db, action, 'report', null, { title, period });
  return htmlToPdf(html);
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

  // ---- עסק ----
  if (p === '/api/business' && m === 'GET') return send(res, 200, getBusinessProfile(db));
  if (p === '/api/business' && m === 'POST') { setBusinessProfile(db, { ...(await readJson(req)), status: 'exempt' }); return send(res, 200, getBusinessProfile(db)); }

  // ---- לקוחות ----
  if (p === '/api/customers' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM customers ORDER BY name').all() as any[];
    return send(res, 200, rows.map((r) => ({ ...getCustomer(db, r.id), balance: customerLedger(db, r.id).balance })));
  }
  if (p === '/api/customers' && m === 'POST') return send(res, 200, createCustomer(db, await readJson(req)));
  let mm = p.match(/^\/api\/customers\/(\d+)$/);
  if (mm && m === 'PUT') { updateCustomer(db, Number(mm[1]), await readJson(req)); return send(res, 200, getCustomer(db, Number(mm[1]))); }
  mm = p.match(/^\/api\/customers\/(\d+)\/ledger$/);
  if (mm && m === 'GET') return send(res, 200, customerLedger(db, Number(mm[1])));

  // ---- סדרות ----
  if (p === '/api/series' && m === 'GET') return send(res, 200, db.prepare('SELECT * FROM series').all());
  mm = p.match(/^\/api\/series\/(\w+)\/start$/);
  if (mm && m === 'POST') { setSeriesStart(db, mm[1] as DocType, Number((await readJson(req)).start)); return send(res, 200, { ok: true }); }

  // ---- מסמכים ----
  if (p === '/api/documents' && m === 'GET') return send(res, 200, listDocs(url.searchParams.get('type') ?? undefined).map(docSummary));
  if (p === '/api/documents' && m === 'POST') {
    const input = (await readJson(req)) as IssueInput;
    const { document, warnings } = issueDocument(db, input);
    return send(res, 200, { document: docSummary(document), warnings });
  }
  // תצוגה מקדימה של טיוטה – לא נשמרת, מסומנת "טיוטה" (נספח ה(א)(3))
  if (p === '/api/documents/preview' && m === 'POST') {
    const input = (await readJson(req)) as IssueInput;
    const business = getBusinessProfile(db);
    const c = input.customerId ? getCustomer(db, input.customerId) : input.customer;
    const customer = c ? { name: c.name, idNumber: c.idNumber ?? null, address: c.address ?? null } : null;
    const v = validateIssue(db, input, customer);
    const draft = {
      doc_type: input.type, issue_date: v.issueDate, total_agorot: v.total,
      customer_snapshot: canonicalJson(customer), business_snapshot: canonicalJson(business ?? {}),
      body: canonicalJson({ lines: input.lines ?? [], payments: input.payments ?? [], withholdingAgorot: input.withholdingAgorot ?? 0,
        description: input.description ?? null, relatedDocumentIds: input.relatedDocumentIds ?? [], reason: input.reason ?? null, notes: input.notes ?? null }),
    };
    return send(res, 200, { html: renderDocument(draft, 'טיוטה', relatedOf(draft)), errors: v.errors, warnings: v.warnings, total: v.total });
  }
  mm = p.match(/^\/api\/documents\/(\d+)$/);
  if (mm && m === 'GET') {
    const d = getDocument(db, Number(mm[1])); if (!d) throw new HttpError(404, 'לא נמצא');
    return send(res, 200, { ...docSummary(d), related: relatedOf(d).map(docSummary) });
  }
  mm = p.match(/^\/api\/documents\/(\d+)\/cancel$/);
  if (mm && m === 'POST') { cancelDocument(db, Number(mm[1]), (await readJson(req)).reason); return send(res, 200, { ok: true }); }
  mm = p.match(/^\/api\/documents\/(\d+)\/delivery$/);
  if (mm && m === 'POST') { recordOriginalDelivery(db, Number(mm[1]), await readJson(req)); return send(res, 200, { ok: true }); }
  // תצוגה על המסך – "העתק"
  mm = p.match(/^\/api\/documents\/(\d+)\/view$/);
  if (mm && m === 'GET') {
    const d = getDocument(db, Number(mm[1])); if (!d) throw new HttpError(404, 'לא נמצא');
    produceOutput(db, d.id, 'copy', 'view');
    return send(res, 200, renderDocument(d, 'העתק', relatedOf(d)), 'text/html; charset=utf-8');
  }
  // PDF: kind=original (פעם אחת) / copy; purpose=print|sent
  mm = p.match(/^\/api\/documents\/(\d+)\/pdf$/);
  if (mm && m === 'POST') {
    const { kind, purpose } = await readJson(req);
    if (kind !== 'original' && kind !== 'copy') throw new HttpError(400, 'kind לא תקין');
    const pur = purpose === 'sent' ? 'sent' : 'print';
    const id = Number(mm[1]);
    const before = getDocument(db, id); if (!before) throw new HttpError(404, 'לא נמצא');
    const html = renderDocument(before, kind === 'original' ? 'מקור' : 'העתק', relatedOf(before));
    const pdf = await htmlToPdf(html);                       // קודם מפיקים את הקובץ, ורק אז רושמים
    const { label, document } = produceOutput(db, id, kind, pur);
    const name = pdfName(document, label);
    if (label === 'מקור') writeFileSync(join(OUTPUTS, name), pdf);  // ארכיון של המקור שהודפס
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.end(pdf);
  }

  // ---- דוחות (PDF, עם כותרת חובה וסימן סיום) ----
  if (p === '/api/reports/continuity' && m === 'GET') {
    if (url.searchParams.get('format') !== 'pdf') return send(res, 200, { series: continuityReport(db), audit: verifyAuditChain(db) });
    const pdf = await reportPdf('דוח בדיקת רצף מספרים עוקבים', `כל התקופה עד ${todayIL()}`, continuityBody(continuityReport(db)), 'report.continuity');
    return send(res, 200, pdf, 'application/pdf');
  }
  if (p === '/api/reports/journal' && m === 'GET') {
    const from = url.searchParams.get('from') ?? '0000-01-01';
    const to = url.searchParams.get('to') ?? '9999-12-31';
    const docs = db.prepare('SELECT * FROM documents WHERE issue_date BETWEEN ? AND ? ORDER BY id').all(from, to) as DocumentRow[];
    const pdf = await reportPdf('יומן רשומות – תיעוד פנים לפי סדר רישומן', `${from} עד ${to}`, journalBody(docs), 'report.journal');
    return send(res, 200, pdf, 'application/pdf');
  }
  if (p === '/api/reports/balances' && m === 'GET') {
    const date = url.searchParams.get('date') ?? todayIL();
    const rows = customerBalancesAt(db, date);
    if (url.searchParams.get('format') !== 'pdf') return send(res, 200, rows);
    const pdf = await reportPdf('רשימת יתרות לקוחות', `נכון ליום ${date}`, balancesBody(rows), 'report.balances');
    return send(res, 200, pdf, 'application/pdf');
  }
  // ---- הוצאות ----
  if (p === '/api/expenses/meta' && m === 'GET')
    return send(res, 200, { categories: EXPENSE_CATEGORIES, docKinds: EXPENSE_DOC_KINDS, paymentMethods: EXPENSE_PAYMENT_METHODS });
  if (p === '/api/expenses' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM expenses ORDER BY entry_number DESC').all() as ExpenseRow[];
    const reversed = new Set(rows.filter((r) => r.reverses_id).map((r) => r.reverses_id));
    return send(res, 200, rows.map((r) => ({ ...r, attachment: r.attachment ? JSON.parse(r.attachment) : null, reversed: reversed.has(r.id) })));
  }
  if (p === '/api/expenses' && m === 'POST') return send(res, 200, recordExpense(db, DATA_DIR, await readJson(req, 15_000_000)));
  mm = p.match(/^\/api\/expenses\/(\d+)\/reverse$/);
  if (mm && m === 'POST') return send(res, 200, reverseExpense(db, Number(mm[1]), (await readJson(req)).reason));
  mm = p.match(/^\/api\/expenses\/(\d+)\/attachment$/);
  if (mm && m === 'GET') {
    const r = db.prepare('SELECT attachment FROM expenses WHERE id = ?').get(Number(mm[1])) as { attachment: string | null } | undefined;
    if (!r?.attachment) throw new HttpError(404, 'אין קובץ מצורף');
    const a = JSON.parse(r.attachment);
    if (!/^[0-9a-f]{64}\.\w+$/.test(a.file)) throw new HttpError(400, 'bad file');
    return send(res, 200, readFileSync(join(DATA_DIR, 'attachments', a.file)), a.type);
  }
  if (p === '/api/reports/book' && m === 'GET') {
    const from = url.searchParams.get('from') ?? `${todayIL().slice(0, 4)}-01-01`;
    const to = url.searchParams.get('to') ?? todayIL();
    const { rows, totals } = receiptsPaymentsBook(db, from, to);
    if (url.searchParams.get('format') !== 'pdf') return send(res, 200, { rows, totals });
    const pdf = await reportPdf('ספר תקבולים ותשלומים', `${from} עד ${to}`, bookBody(rows, totals), 'report.book');
    return send(res, 200, pdf, 'application/pdf');
  }
  if (p === '/api/reports/annual' && m === 'GET') {
    const year = Number(url.searchParams.get('year') ?? todayIL().slice(0, 4));
    const s = annualSummary(db, year);
    if (url.searchParams.get('format') !== 'pdf') return send(res, 200, s);
    const pdf = await reportPdf(`סיכום שנתי ${year}`, `01/01/${year} – 31/12/${year}`, annualSummaryBody(s), 'report.annual');
    return send(res, 200, pdf, 'application/pdf');
  }

  // ---- גיבוי (הוראה 25(ו)) ----
  if (p === '/api/backup/status' && m === 'GET') {
    const log = db.prepare('SELECT * FROM backups_log ORDER BY id DESC LIMIT 30').all();
    return send(res, 200, { ...backupStatus(db), drives: availableDrives(), dataDir: DATA_DIR, log });
  }
  if (p === '/api/backup/target' && m === 'POST') { setBackupTarget(db, (await readJson(req)).target); return send(res, 200, backupStatus(db)); }
  if (p === '/api/backup/run' && m === 'POST') {
    const { kind } = await readJson(req);
    const k = kind === 'local' ? 'local' : 'external';
    const target = k === 'local' ? join(DATA_DIR, 'backups') : backupStatus(db).target;
    if (!target) throw new HttpError(400, 'לא הוגדרה תיקיית יעד לגיבוי');
    mkdirSync(target, { recursive: true });
    return send(res, 200, createBackup(db, { dataDir: DATA_DIR, targetDir: target, kind: k }));
  }
  if (p === '/api/backup/verify' && m === 'POST') return send(res, 200, verifyBackup((await readJson(req)).path));
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

  if (p === '/api/dashboard' && m === 'GET') {
    const year = todayIL().slice(0, 4);
    const income = db.prepare(`SELECT COALESCE(SUM(total_agorot),0) s FROM documents
      WHERE status='issued' AND doc_type IN ('receipt','invoice_receipt') AND substr(issue_date,1,4)=?`).get(year) as { s: number };
    const notDelivered = db.prepare(`SELECT COUNT(*) c FROM documents WHERE status='issued' AND doc_type IN ('receipt','invoice_receipt','invoice','credit')
      AND original_produced_at IS NULL`).get() as { c: number };
    return send(res, 200, { year, incomeAgorot: income.s, originalsPending: notDelivered.c, continuityOk: continuityReport(db).every((s) => s.ok) && verifyExpenses(db).ok, backup: backupStatus(db), ceiling: exemptCeilingStatus(db) });
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
