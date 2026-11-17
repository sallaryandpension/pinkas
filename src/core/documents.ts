/**
 * הפקת מסמכים – הליבה הרגולטורית.
 * מקורות: הוראות מס הכנסה (ניהול פנקסי חשבונות) 1973 – ס' 5 (קבלה), 9 (חשבונית, זיכוי),
 * 18 (מספור, העתק), 23–23א (תיקון/ביטול), נספח ה' (מקור/העתק/טיוטה, רציפות), תוספת י"א.
 */
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/tx.ts';
import { appendAudit } from './audit.ts';
import { getBusinessProfile, getCustomer } from './entities.ts';
import { PARAMS, paramAt } from './params.ts';
import { canonicalJson, formatShekels, isIsoDate, nowIso, sha256, todayIL } from './util.ts';

export type DocType = 'order' | 'invoice' | 'invoice_receipt' | 'receipt' | 'credit';

export const DOC_TYPE_NAMES: Record<DocType, string> = {
  order: 'הזמנה',
  invoice: 'חשבונית עסקה',
  invoice_receipt: 'חשבונית עסקה/קבלה',
  receipt: 'קבלה',
  credit: 'הודעת זיכוי',
};

export type Line = {
  description: string;       // תיאור השירות (9(א)(5))
  quantity: number;          // כמות (9(א)(7))
  unit: string;              // יחידת מידה (9(א)(6)) – "שעה", "יחידה", "סדנה"...
  unitPriceAgorot: number;   // מחיר ליחידה (9(א)(8))
};

export type Payment =
  | { method: 'cash'; amountAgorot: number; date: string }
  | { method: 'cheque'; amountAgorot: number; date: string;
      cheque: { number: string; bank: string; branch: string; account?: string; dueDate: string;
                endorser?: { name: string; idNumber: string } } }
  | { method: 'transfer'; amountAgorot: number; date: string; transfer: { reference?: string; bank?: string } }
  | { method: 'credit_card'; amountAgorot: number; date: string;
      card: { last4: string; approval?: string; installments?: number } }
  | { method: 'app'; amountAgorot: number; date: string; app: { name: string; reference?: string } }
  | { method: 'other'; amountAgorot: number; date: string; other: { description: string } };

export type CustomerSnapshot = { name: string; idNumber?: string | null; address?: string | null };

export type IssueInput = {
  type: DocType;
  customerId?: number;              // לקוח מהרשימה, או
  customer?: CustomerSnapshot;      // לקוח מזדמן
  issueDate?: string;               // ברירת מחדל: היום (שעון ישראל)
  lines?: Line[];
  payments?: Payment[];
  withholdingAgorot?: number;       // ניכוי במקור (12(ג)) – הקבלה נרשמת בסכום הכולל
  description?: string;            // מהות התקבול (5(א)(6)) / תיאור ההזמנה
  relatedDocumentIds?: number[];    // הזמנה→חשבונית, חשבונית→קבלה, חשבונית→זיכוי
  reason?: string;                  // סיבת הזיכוי (9(ה)(5))
  notes?: string;
  acknowledgeWarnings?: boolean;
};

export type DocumentRow = {
  id: number; doc_type: DocType; number: number; issue_date: string; created_at: string;
  customer_id: number | null; customer_snapshot: string; business_snapshot: string; body: string;
  total_agorot: number; content_hash: string; prev_hash: string | null; status: 'issued' | 'cancelled';
  cancelled_at: string | null; cancel_reason: string | null;
  original_produced_at: string | null; original_delivery: string | null;
};

export class ValidationError extends Error {
  errors: string[];
  warnings: string[];
  constructor(errors: string[], warnings: string[]) {
    super(errors.length ? errors.join('; ') : `נדרש אישור לאזהרות: ${warnings.join('; ')}`);
    this.errors = errors;
    this.warnings = warnings;
  }
}

const sumLines = (lines: Line[]) => lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPriceAgorot), 0);
const sumPayments = (p: Payment[]) => p.reduce((s, x) => s + x.amountAgorot, 0);

function getDoc(db: DatabaseSync, id: number): DocumentRow | null {
  return (db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined) ?? null;
}
export { getDoc as getDocument };

/** בדיקת תקינות. מחזיר שגיאות (חוסמות) ואזהרות (דורשות אישור). */
export function validateIssue(db: DatabaseSync, input: IssueInput, customer: CustomerSnapshot | null) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = input.type;
  const issueDate = input.issueDate ?? todayIL();
  const lines = input.lines ?? [];
  const payments = input.payments ?? [];
  const withholding = input.withholdingAgorot ?? 0;

  if (!(t in DOC_TYPE_NAMES)) errors.push(`סוג מסמך לא מוכר: ${t}. (חשבונית מס אסורה לעוסק פטור – חוק מע"מ 50(א))`);
  if (!isIsoDate(issueDate)) errors.push('תאריך לא תקין');
  else if (issueDate > todayIL()) errors.push('אי אפשר להפיק מסמך בתאריך עתידי (הוראה 17(א))');

  if (!customer?.name?.trim()) errors.push('שם הלקוח / המשלם חובה (5(א)(4), 9(א)(4))');
  if (customer && !customer.address?.trim() && t !== 'credit')
    warnings.push('לא צוין מען הלקוח. מותר רק אם המען ידוע לך (5(א)(4), 9(א)(4))');

  // שורות – חשבונית / חשבונית-קבלה (חובה), הזמנה (רשות)
  const needsLines = t === 'invoice' || t === 'invoice_receipt';
  if (needsLines && lines.length === 0) errors.push('חשבונית חייבת לפחות שורת שירות אחת');
  lines.forEach((l, i) => {
    if (!l.description?.trim()) errors.push(`שורה ${i + 1}: תיאור השירות חובה (9(א)(5))`);
    if (!(l.quantity > 0)) errors.push(`שורה ${i + 1}: כמות חייבת להיות חיובית`);
    if (!l.unit?.trim()) errors.push(`שורה ${i + 1}: יחידת מידה חובה (9(א)(6))`);
    if (!Number.isInteger(l.unitPriceAgorot) || l.unitPriceAgorot < 0) errors.push(`שורה ${i + 1}: מחיר ליחידה לא תקין`);
  });

  // תשלומים – קבלה וחשבונית-קבלה
  const needsPayments = t === 'receipt' || t === 'invoice_receipt';
  if (needsPayments && payments.length === 0) errors.push('יש לפרט לפחות אמצעי תשלום אחד');
  if (!needsPayments && payments.length > 0) errors.push(`למסמך מסוג ${DOC_TYPE_NAMES[t]} לא מצרפים תשלומים`);
  if (!Number.isInteger(withholding) || withholding < 0) errors.push('ניכוי במקור לא תקין');
  if (withholding > 0 && !needsPayments) errors.push('ניכוי במקור רלוונטי רק לקבלה / חשבונית-קבלה');
  payments.forEach((p, i) => {
    const n = `תשלום ${i + 1}`;
    if (!Number.isInteger(p.amountAgorot) || p.amountAgorot <= 0) errors.push(`${n}: סכום לא תקין`);
    if (!isIsoDate(p.date)) errors.push(`${n}: תאריך לא תקין`);
    if (p.method === 'cheque') {
      const c = p.cheque;
      if (!c?.number?.trim() || !c?.bank?.trim() || !c?.branch?.trim() || !isIsoDate(c?.dueDate))
        errors.push(`${n}: בשיק חובה מספר שיק, בנק, סניף ותאריך פירעון (5(ב))`);
      if (c?.endorser && (!c.endorser.name?.trim() || !c.endorser.idNumber?.trim()))
        errors.push(`${n}: בשיק מוסב חובה שם ות"ז המסב (חוק המזומן)`);
    }
    if (p.method === 'credit_card' && !/^\d{4}$/.test(p.card?.last4 ?? '')) errors.push(`${n}: 4 ספרות אחרונות של הכרטיס`);
    if (p.method === 'app' && !p.app?.name?.trim()) errors.push(`${n}: שם האפליקציה (Bit / PayBox...)`);
    if (p.method === 'other' && !p.other?.description?.trim()) errors.push(`${n}: תיאור אמצעי התשלום`);
  });

  // מהות התקבול / תיאור
  if (t === 'receipt' && !input.description?.trim())
    errors.push('בקבלה חובה לציין את מהות התקבול (5(א)(6))');
  if (t === 'order' && !input.description?.trim() && lines.length === 0)
    errors.push('בהזמנה חובה לתאר את השירות המוזמן (תוספת י"א 2(ג)(4))');

  // סכומים
  let total = 0;
  if (t === 'invoice' || t === 'invoice_receipt' || t === 'order') total = sumLines(lines);
  if (t === 'receipt') total = sumPayments(payments) + withholding;
  if (t === 'invoice_receipt' && sumPayments(payments) + withholding !== total)
    errors.push(`בחשבונית-קבלה סכום התשלומים (${formatShekels(sumPayments(payments) + withholding)}) חייב להיות שווה לסכום החשבונית (${formatShekels(total)})`);
  if ((t === 'invoice' || t === 'invoice_receipt' || t === 'receipt') && total <= 0) errors.push('סכום המסמך חייב להיות חיובי');

  // מסמכים קשורים
  const related = (input.relatedDocumentIds ?? []).map((id) => ({ id, doc: getDoc(db, id) }));
  for (const r of related) {
    if (!r.doc) errors.push(`מסמך קשור ${r.id} לא נמצא`);
    else if (r.doc.status !== 'issued') errors.push(`מסמך קשור ${r.id} מבוטל`);
  }

  // הודעת זיכוי
  if (t === 'credit') {
    const invoices = related.filter((r) => r.doc && ['invoice', 'invoice_receipt'].includes(r.doc.doc_type));
    if (invoices.length === 0 || invoices.length !== related.length)
      errors.push('הודעת זיכוי חייבת להתייחס לחשבונית אחת או יותר (9(ה)(4))');
    if (!input.reason?.trim()) errors.push('בהודעת זיכוי חובה לציין את הסיבה (9(ה)(5))');
    if (!input.lines?.length && !input.description) errors.push('יש לפרט את סכום הזיכוי (שורות)');
    total = sumLines(lines);
    if (total <= 0) errors.push('סכום הזיכוי חייב להיות חיובי');
    const invoicedTotal = invoices.reduce((s, r) => s + r.doc!.total_agorot, 0);
    const alreadyCredited = invoices.reduce((s, r) => s + creditedAgainst(db, r.id), 0);
    if (total > invoicedTotal - alreadyCredited)
      errors.push(`סכום הזיכוי עולה על יתרת החשבוניות (${formatShekels(invoicedTotal - alreadyCredited)}) (23א)`);
  }

  // תוספת י"א 2(ג)(5): חשבונית לכל שירות מ-210 ₪
  if (t === 'receipt' && isIsoDate(issueDate)) {
    const threshold = paramAt(PARAMS.invoiceRequiredFromAgorot, issueDate);
    const hasInvoice = related.some((r) => r.doc?.doc_type === 'invoice');
    if (total >= threshold && !hasInvoice)
      warnings.push(`תקבול של ${formatShekels(total)} ללא חשבונית מקושרת. לשירות מ-${formatShekels(threshold)} נדרשת חשבונית (תוספת י"א) – שקול "חשבונית עסקה/קבלה"`);
  }

  // חוק לצמצום השימוש במזומן
  const cash = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amountAgorot, 0);
  if (cash > 0 && isIsoDate(issueDate)) {
    const limit = paramAt(PARAMS.cashLimitBusinessAgorot, issueDate);
    const pct = paramAt(PARAMS.cashLimitPercent, issueDate);
    const txTotal = t === 'receipt' ? total : total;
    if (txTotal > limit) {
      const allowed = Math.min(limit, Math.floor((txTotal * pct) / 100));
      if (cash > allowed)
        warnings.push(`מזומן ${formatShekels(cash)} בעסקה של ${formatShekels(txTotal)} – מעל המותר (${formatShekels(allowed)}) לפי חוק לצמצום השימוש במזומן`);
    }
  }

  return { errors, warnings, total, issueDate };
}

function creditedAgainst(db: DatabaseSync, invoiceId: number): number {
  const rows = db.prepare("SELECT body, total_agorot FROM documents WHERE doc_type = 'credit' AND status = 'issued'").all() as any[];
  return rows
    .filter((r) => (JSON.parse(r.body).relatedDocumentIds ?? []).includes(invoiceId))
    .reduce((s, r) => s + r.total_agorot, 0);
}

export function contentHashOf(row: Pick<DocumentRow,
  'doc_type' | 'number' | 'issue_date' | 'created_at' | 'customer_snapshot' | 'business_snapshot' | 'body' | 'total_agorot' | 'prev_hash'>): string {
  return sha256(canonicalJson({
    doc_type: row.doc_type, number: row.number, issue_date: row.issue_date, created_at: row.created_at,
    customer_snapshot: row.customer_snapshot, business_snapshot: row.business_snapshot,
    body: row.body, total_agorot: row.total_agorot, prev_hash: row.prev_hash,
  }));
}

/** הפקת מסמך לקובץ הקבוע. בלתי הפיך. */
export function issueDocument(db: DatabaseSync, input: IssueInput): { document: DocumentRow; warnings: string[] } {
  const business = getBusinessProfile(db);
  if (!business) throw new ValidationError(['יש להגדיר את פרטי העסק לפני הפקת מסמכים'], []);

  let customer: CustomerSnapshot | null = null;
  if (input.customerId != null) {
    const c = getCustomer(db, input.customerId);
    if (!c) throw new ValidationError([`לקוח ${input.customerId} לא נמצא`], []);
    customer = { name: c.name, idNumber: c.idNumber ?? null, address: c.address ?? null };
  } else if (input.customer) {
    customer = { name: input.customer.name, idNumber: input.customer.idNumber ?? null, address: input.customer.address ?? null };
  }

  const v = validateIssue(db, input, customer);
  if (v.errors.length) throw new ValidationError(v.errors, v.warnings);
  if (v.warnings.length && !input.acknowledgeWarnings) throw new ValidationError([], v.warnings);

  const body = canonicalJson({
    lines: input.lines ?? [],
    payments: input.payments ?? [],
    withholdingAgorot: input.withholdingAgorot ?? 0,
    description: input.description ?? null,
    relatedDocumentIds: input.relatedDocumentIds ?? [],
    reason: input.reason ?? null,
    notes: input.notes ?? null,
    acknowledgedWarnings: v.warnings,
  });

  return inTransaction(db, () => {
    const series = db.prepare('SELECT next_number FROM series WHERE doc_type = ?').get(input.type) as { next_number: number };
    const prev = db.prepare('SELECT content_hash FROM documents WHERE doc_type = ? ORDER BY number DESC LIMIT 1')
      .get(input.type) as { content_hash: string } | undefined;
    const row = {
      doc_type: input.type,
      number: series.next_number,
      issue_date: v.issueDate,
      created_at: nowIso(),
      customer_snapshot: canonicalJson(customer),
      business_snapshot: canonicalJson(business),
      body,
      total_agorot: v.total,
      prev_hash: prev?.content_hash ?? null,
    };
    const content_hash = contentHashOf(row);
    const r = db.prepare(`INSERT INTO documents
      (doc_type, number, issue_date, created_at, customer_id, customer_snapshot, business_snapshot, body, total_agorot, content_hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.doc_type, row.number, row.issue_date, row.created_at, input.customerId ?? null,
      row.customer_snapshot, row.business_snapshot, row.body, row.total_agorot, content_hash, row.prev_hash);
    const id = Number(r.lastInsertRowid);
    appendAudit(db, 'document.issue', 'document', id, {
      type: row.doc_type, number: row.number, total: row.total_agorot, warnings: v.warnings,
    });
    return { document: getDoc(db, id)!, warnings: v.warnings };
  });
}

/**
 * הפקת פלט של מסמך.
 *  - 'original': "מקור" – פעם אחת בלבד בחיי המסמך (נספח ה(א)(4)). להדפסה, חתימה ידנית ומשלוח בדואר.
 *  - 'copy':     "העתק" – בכל זמן (18(ב)(2)). purpose='sent' מסמן שהמסמך יצא ללקוח.
 * מחזיר את הכיתוב שיש להטביע על המסמך.
 */
export function produceOutput(
  db: DatabaseSync, id: number, kind: 'original' | 'copy', purpose: 'print' | 'sent' | 'view' = 'print',
): { label: 'מקור' | 'העתק'; document: DocumentRow } {
  return inTransaction(db, () => {
    const doc = getDoc(db, id);
    if (!doc) throw new Error(`מסמך ${id} לא נמצא`);
    if (kind === 'original') {
      if (doc.status === 'cancelled') throw new Error('אי אפשר להפיק מקור למסמך מבוטל');
      if (doc.original_produced_at) throw new Error(`המקור הופק כבר ב-${doc.original_produced_at}. ניתן להפיק העתק בלבד`);
      db.prepare('UPDATE documents SET original_produced_at = ? WHERE id = ?').run(nowIso(), id);
      appendAudit(db, 'document.original', 'document', id, { purpose });
      return { label: 'מקור', document: getDoc(db, id)! };
    }
    appendAudit(db, 'document.copy', 'document', id, { purpose });
    return { label: 'העתק', document: doc };
  });
}

/** רישום אופן מסירת המקור ללקוח (דואר / ביד). */
export function recordOriginalDelivery(
  db: DatabaseSync, id: number, delivery: { method: 'mail' | 'hand' | 'registered_mail'; date: string; note?: string },
): void {
  if (!isIsoDate(delivery.date)) throw new Error('תאריך מסירה לא תקין');
  inTransaction(db, () => {
    db.prepare('UPDATE documents SET original_delivery = ? WHERE id = ?').run(canonicalJson(delivery), id);
    appendAudit(db, 'document.delivery', 'document', id, delivery);
  });
}

/** ביטול – רק לפני שהמסמך יצא (מקור לא הופק, העתק לא נשלח). אחרת: הודעת זיכוי (23א). */
export function cancelDocument(db: DatabaseSync, id: number, reason: string): void {
  if (!reason?.trim()) throw new Error('חובה לציין סיבת ביטול');
  inTransaction(db, () => {
    const doc = getDoc(db, id);
    if (!doc) throw new Error(`מסמך ${id} לא נמצא`);
    const sent = db.prepare(
      "SELECT 1 FROM audit_log WHERE action = 'document.copy' AND entity_id = ? AND json_extract(details, '$.purpose') = 'sent' LIMIT 1",
    ).get(id);
    if (doc.original_produced_at || sent)
      throw new Error('המסמך כבר יצא ללקוח – אין לבטל. יש להפיק הודעת זיכוי (הוראה 23א(2))');
    db.prepare("UPDATE documents SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?")
      .run(nowIso(), reason.trim(), id);
    appendAudit(db, 'document.cancel', 'document', id, { reason });
  });
}

/** קביעת מספר התחלתי לסדרה (המשך מפנקס קודם) – רק לפני המסמך הראשון בסדרה. */
export function setSeriesStart(db: DatabaseSync, type: DocType, start: number): void {
  if (!Number.isInteger(start) || start < 1) throw new Error('מספר התחלה לא תקין');
  inTransaction(db, () => {
    db.prepare('UPDATE series SET start_number = ?, next_number = ? WHERE doc_type = ?').run(start, start, type);
    appendAudit(db, 'series.start', 'series', null, { type, start });
  });
}
