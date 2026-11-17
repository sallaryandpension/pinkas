/**
 * נתב ה-API המשותף – אותו קוד רץ בשרת המקומי (Node) ובגרסת הדפדפן.
 * לוגיקה תלוית-פלטפורמה (PDF, קבצים, גיבוי) מגיעה דרך Platform.
 */
import type { DatabaseSync } from 'node:sqlite';
import { appendAudit, verifyAuditChain } from './core/audit.ts';
import { createCustomer, getBusinessProfile, getCustomer, setBusinessProfile, updateCustomer } from './core/entities.ts';
import {
  cancelDocument, DOC_TYPE_NAMES, getDocument, issueDocument, produceOutput, recordOriginalDelivery,
  setSeriesStart, validateIssue, type DocType, type DocumentRow, type IssueInput,
} from './core/documents.ts';
import { continuityReport, customerBalancesAt, customerLedger } from './core/reports.ts';
import { canonicalJson, nowIso, todayIL } from './core/util.ts';
import {
  annualSummaryBody, balancesBody, bookBody, continuityBody, journalBody, renderDocument, renderReport,
} from './render/html.ts';
import {
  EXPENSE_CATEGORIES, EXPENSE_DOC_KINDS, EXPENSE_PAYMENT_METHODS, recordExpense, reverseExpense, verifyExpenses,
  type ExpenseRow, type SaveAttachment,
} from './core/expenses.ts';
import { OTHER_INCOME_KINDS, recordOtherIncome, reverseOtherIncome, verifyOtherIncome } from './core/otherIncome.ts';
import { annualSummary, exemptCeilingStatus, receiptsPaymentsBook, upcomingDeadlines } from './core/books.ts';
import { quarterlyBackupStatus } from './core/backupStatus.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type ApiRequest = { method: string; path: string; query: URLSearchParams; body: any };

/** מסמך/דוח להדפסה. finalize() נקרא רק אחרי שההפקה הצליחה (למשל רישום "מקור"). */
export type Printable = { html: string; filename: string; finalize?: () => { label: string } };

export type ApiResult =
  | { status: number; json: unknown }
  | { status: number; html: string }
  | { status: number; printable: Printable };

export type Platform = {
  saveAttachment?: SaveAttachment;
  /** תוספות למצב הגיבוי (יעד, זמינות כונן וכו'). */
  backupExtras?: (db: DatabaseSync) => Record<string, unknown>;
};

const ok = (json: unknown): ApiResult => ({ status: 200, json });

export function docSummary(d: DocumentRow) {
  return {
    id: d.id, type: d.doc_type, typeName: DOC_TYPE_NAMES[d.doc_type], number: d.number, issueDate: d.issue_date,
    customer: JSON.parse(d.customer_snapshot)?.name ?? '', customerId: d.customer_id, total: d.total_agorot,
    status: d.status, cancelReason: d.cancel_reason, originalProducedAt: d.original_produced_at,
    originalDelivery: d.original_delivery ? JSON.parse(d.original_delivery) : null,
    body: JSON.parse(d.body),
  };
}

/** מחזיר null אם הנתיב אינו מטופל כאן (ואז הפלטפורמה מטפלת בו). */
export async function route(db: DatabaseSync, platform: Platform, req: ApiRequest): Promise<ApiResult | null> {
  const { method: m, path: p, query: q, body } = req;

  const relatedOf = (d: { body: string }) =>
    ((JSON.parse(d.body).relatedDocumentIds ?? []) as number[]).map((id) => getDocument(db, id)).filter(Boolean) as DocumentRow[];

  const report = (title: string, period: string, bodyHtml: string, action: string, filename: string): ApiResult => {
    const business = getBusinessProfile(db);
    const html = renderReport({ businessName: business?.name ?? '-', title, period, producedAt: nowIso(), bodyHtml });
    return { status: 200, printable: { html, filename, finalize: () => { appendAudit(db, action, 'report', null, { title, period }); return { label: '' }; } } };
  };

  // ---- עסק ----
  if (p === '/api/business' && m === 'GET') return ok(getBusinessProfile(db));
  if (p === '/api/business' && m === 'POST') { setBusinessProfile(db, { ...body, status: 'exempt' }); return ok(getBusinessProfile(db)); }

  // ---- לקוחות ----
  if (p === '/api/customers' && m === 'GET') {
    const rows = db.prepare('SELECT id FROM customers ORDER BY name').all() as { id: number }[];
    return ok(rows.map((r) => ({ ...getCustomer(db, r.id), balance: customerLedger(db, r.id).balance })));
  }
  if (p === '/api/customers' && m === 'POST') return ok(createCustomer(db, body));
  let mm = p.match(/^\/api\/customers\/(\d+)$/);
  if (mm && m === 'PUT') { updateCustomer(db, Number(mm[1]), body); return ok(getCustomer(db, Number(mm[1]))); }
  mm = p.match(/^\/api\/customers\/(\d+)\/ledger$/);
  if (mm && m === 'GET') return ok(customerLedger(db, Number(mm[1])));

  // ---- סדרות ----
  if (p === '/api/series' && m === 'GET') return ok(db.prepare('SELECT * FROM series').all());
  mm = p.match(/^\/api\/series\/(\w+)\/start$/);
  if (mm && m === 'POST') { setSeriesStart(db, mm[1] as DocType, Number(body.start)); return ok({ ok: true }); }

  // ---- מסמכים ----
  if (p === '/api/documents' && m === 'GET') {
    const type = q.get('type');
    const rows = (type ? db.prepare('SELECT * FROM documents WHERE doc_type = ? ORDER BY id DESC').all(type)
      : db.prepare('SELECT * FROM documents ORDER BY id DESC').all()) as DocumentRow[];
    return ok(rows.map(docSummary));
  }
  if (p === '/api/documents' && m === 'POST') {
    const { document, warnings } = issueDocument(db, body as IssueInput);
    return ok({ document: docSummary(document), warnings });
  }
  // תצוגה מקדימה של טיוטה – לא נשמרת, מסומנת "טיוטה" (נספח ה(א)(3))
  if (p === '/api/documents/preview' && m === 'POST') {
    const input = body as IssueInput;
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
    return ok({ html: renderDocument(draft, 'טיוטה', relatedOf(draft)), errors: v.errors, warnings: v.warnings, total: v.total });
  }
  mm = p.match(/^\/api\/documents\/(\d+)$/);
  if (mm && m === 'GET') {
    const d = getDocument(db, Number(mm[1])); if (!d) throw new HttpError(404, 'לא נמצא');
    return ok({ ...docSummary(d), related: relatedOf(d).map(docSummary) });
  }
  mm = p.match(/^\/api\/documents\/(\d+)\/cancel$/);
  if (mm && m === 'POST') { cancelDocument(db, Number(mm[1]), body.reason); return ok({ ok: true }); }
  mm = p.match(/^\/api\/documents\/(\d+)\/delivery$/);
  if (mm && m === 'POST') { recordOriginalDelivery(db, Number(mm[1]), body); return ok({ ok: true }); }
  // תצוגה על המסך – "העתק"
  mm = p.match(/^\/api\/documents\/(\d+)\/view$/);
  if (mm && m === 'GET') {
    const d = getDocument(db, Number(mm[1])); if (!d) throw new HttpError(404, 'לא נמצא');
    produceOutput(db, d.id, 'copy', 'view');
    return { status: 200, html: renderDocument(d, 'העתק', relatedOf(d)) };
  }
  // הפקת מסמך להדפסה / PDF: kind=original (פעם אחת) / copy; purpose=print|sent
  mm = p.match(/^\/api\/documents\/(\d+)\/pdf$/);
  if (mm && m === 'POST') {
    const { kind, purpose } = body;
    if (kind !== 'original' && kind !== 'copy') throw new HttpError(400, 'kind לא תקין');
    const id = Number(mm[1]);
    const d = getDocument(db, id); if (!d) throw new HttpError(404, 'לא נמצא');
    if (kind === 'original' && d.original_produced_at) throw new HttpError(409, `המקור הופק כבר ב-${d.original_produced_at}. ניתן להפיק העתק בלבד`);
    if (kind === 'original' && d.status !== 'issued') throw new HttpError(409, 'אי אפשר להפיק מקור למסמך מבוטל');
    const label = kind === 'original' ? 'מקור' : 'העתק';
    return { status: 200, printable: {
      html: renderDocument(d, label, relatedOf(d)),
      filename: `${d.doc_type}-${d.number}-${kind}.pdf`,
      finalize: () => ({ label: produceOutput(db, id, kind, purpose === 'sent' ? 'sent' : 'print').label }),
    } };
  }

  // ---- דוחות (כותרת חובה וסימן סיום – נספח ה(א)(2)) ----
  if (p === '/api/reports/continuity' && m === 'GET') {
    if (q.get('format') !== 'pdf') return ok({ series: continuityReport(db), audit: verifyAuditChain(db) });
    return report('דוח בדיקת רצף מספרים עוקבים', `כל התקופה עד ${todayIL()}`, continuityBody(continuityReport(db)), 'report.continuity', 'continuity.pdf');
  }
  if (p === '/api/reports/journal' && m === 'GET') {
    const from = q.get('from') ?? '0000-01-01';
    const to = q.get('to') ?? '9999-12-31';
    const docs = db.prepare('SELECT * FROM documents WHERE issue_date BETWEEN ? AND ? ORDER BY id').all(from, to) as DocumentRow[];
    return report('יומן רשומות – תיעוד פנים לפי סדר רישומן', `${from} עד ${to}`, journalBody(docs), 'report.journal', 'journal.pdf');
  }
  if (p === '/api/reports/balances' && m === 'GET') {
    const date = q.get('date') ?? todayIL();
    const rows = customerBalancesAt(db, date);
    if (q.get('format') !== 'pdf') return ok(rows);
    return report('רשימת יתרות לקוחות', `נכון ליום ${date}`, balancesBody(rows), 'report.balances', 'balances.pdf');
  }
  if (p === '/api/reports/book' && m === 'GET') {
    const from = q.get('from') ?? `${todayIL().slice(0, 4)}-01-01`;
    const to = q.get('to') ?? todayIL();
    const { rows, totals } = receiptsPaymentsBook(db, from, to);
    if (q.get('format') !== 'pdf') return ok({ rows, totals });
    return report('ספר תקבולים ותשלומים', `${from} עד ${to}`, bookBody(rows, totals), 'report.book', 'book.pdf');
  }
  if (p === '/api/reports/annual' && m === 'GET') {
    const year = Number(q.get('year') ?? todayIL().slice(0, 4));
    const s = annualSummary(db, year);
    if (q.get('format') !== 'pdf') return ok(s);
    return report(`סיכום שנתי ${year}`, `01/01/${year} – 31/12/${year}`, annualSummaryBody(s), 'report.annual', `annual-${year}.pdf`);
  }

  // ---- הוצאות ----
  if (p === '/api/expenses/meta' && m === 'GET')
    return ok({ categories: EXPENSE_CATEGORIES, docKinds: EXPENSE_DOC_KINDS, paymentMethods: EXPENSE_PAYMENT_METHODS });
  if (p === '/api/expenses' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM expenses ORDER BY entry_number DESC').all() as ExpenseRow[];
    const reversed = new Set(rows.filter((r) => r.reverses_id).map((r) => r.reverses_id));
    return ok(rows.map((r) => ({ ...r, attachment: r.attachment ? JSON.parse(r.attachment) : null, reversed: reversed.has(r.id) })));
  }
  if (p === '/api/expenses' && m === 'POST') return ok(recordExpense(db, body, platform.saveAttachment));
  mm = p.match(/^\/api\/expenses\/(\d+)\/reverse$/);
  if (mm && m === 'POST') return ok(reverseExpense(db, Number(mm[1]), body.reason));

  // ---- הכנסות שאינן ממסמכים ----
  if (p === '/api/other-income' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM other_income ORDER BY entry_number DESC').all() as any[];
    const reversed = new Set(rows.filter((r) => r.reverses_id).map((r) => r.reverses_id));
    return ok({ kinds: OTHER_INCOME_KINDS, rows: rows.map((r) => ({ ...r, reversed: reversed.has(r.id) })) });
  }
  if (p === '/api/other-income' && m === 'POST') return ok(recordOtherIncome(db, body));
  mm = p.match(/^\/api\/other-income\/(\d+)\/reverse$/);
  if (mm && m === 'POST') return ok(reverseOtherIncome(db, Number(mm[1]), body.reason));

  // ---- לוח בקרה ----
  if (p === '/api/dashboard' && m === 'GET') {
    const year = todayIL().slice(0, 4);
    const income = db.prepare(`SELECT COALESCE(SUM(total_agorot),0) s FROM documents
      WHERE status='issued' AND doc_type IN ('receipt','invoice_receipt') AND substr(issue_date,1,4)=?`).get(year) as { s: number };
    const notDelivered = db.prepare(`SELECT COUNT(*) c FROM documents WHERE status='issued' AND doc_type IN ('receipt','invoice_receipt','invoice','credit')
      AND original_produced_at IS NULL`).get() as { c: number };
    return ok({
      year, incomeAgorot: income.s, originalsPending: notDelivered.c,
      continuityOk: continuityReport(db).every((s) => s.ok) && verifyExpenses(db).ok && verifyOtherIncome(db).ok,
      backup: { ...quarterlyBackupStatus(db), ...(platform.backupExtras?.(db) ?? {}) },
      ceiling: exemptCeilingStatus(db), deadlines: upcomingDeadlines(),
    });
  }
  return null;
}
