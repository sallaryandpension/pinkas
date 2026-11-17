/**
 * הוצאות ותשלומים.
 * - הוראה 12: ספר תקבולים ותשלומים – כל תשלום עם התיעוד והתאריך; טורים נפרדים לרכישת/מכירת נכסים ולפיקדונות.
 * - תוספת י"א 2(ג)(6): תיק תיעוד חוץ – מסמכי הספקים. **המקור מנייר נשמר** (ביעור אחרי סריקה מחייב
 *   חתימה מאושרת שלך ושל אדם נוסף – נספח ו'); הקובץ המצורף כאן הוא עותק לנוחות בלבד.
 * - הוראה 20: רישום בספר תקבולים ותשלומים "לא יאוחר מ-30 ימים מתום החודש".
 * - הוראה 23(א)(2): תיקון רק ברישום נגדי.
 */
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/tx.ts';
import { appendAudit } from './audit.ts';
import { base64ToBytes, canonicalJson, isIsoDate, nowIso, sha256, sha256Bytes, todayIL } from './util.ts';

/** שמירת קובץ מצורף לפי שמו (hash.ext). Node: לדיסק; דפדפן: ל-IndexedDB. התוכן לעולם לא נדרס. */
export type SaveAttachment = (file: string, bytes: Uint8Array) => void;
import { ValidationError } from './documents.ts';

export const EXPENSE_CATEGORIES = [
  'ציוד וחומרים', 'מחשב, תוכנה ומנויים', 'טלפון ואינטרנט', 'נסיעות וחניה', 'רכב', 'ספרות והשתלמויות',
  'פרסום ושיווק', 'שכירות ואחזקת משרד', 'ביטוחים', 'עמלות בנק וסליקה', 'שירותים מקצועיים', 'כיבוד ואירוח', 'אחר',
] as const;

export const EXPENSE_DOC_KINDS: Record<string, string> = {
  receipt: 'קבלה', invoice: 'חשבונית עסקה', tax_invoice: 'חשבונית מס', tax_invoice_receipt: 'חשבונית מס/קבלה',
  cash_slip: 'תלוש קופה', other: 'מסמך אחר',
};
export const EXPENSE_PAYMENT_METHODS: Record<string, string> = {
  credit_card: 'כרטיס אשראי', transfer: 'העברה בנקאית', cash: 'מזומן', cheque: 'שיק', app: 'אפליקציה', standing_order: 'הוראת קבע', other: 'אחר',
};

export type ExpenseInput = {
  expenseDate: string;
  supplierName: string;
  supplierIdNumber?: string;
  docKind: string;
  docNumber?: string;
  description: string;
  category: string;
  amountAgorot: number;
  paymentMethod: string;
  columnKind?: 'regular' | 'asset' | 'deposit';
  notes?: string;
  attachment?: { name: string; type: string; base64: string };
  acknowledgeWarnings?: boolean;
};

export type ExpenseRow = {
  id: number; entry_number: number; recorded_at: string; expense_date: string; supplier_name: string;
  supplier_id_number: string | null; doc_kind: string; doc_number: string | null; description: string; category: string;
  amount_agorot: number; payment_method: string; column_kind: 'regular' | 'asset' | 'deposit'; attachment: string | null;
  reverses_id: number | null; reverse_reason: string | null; notes: string | null; content_hash: string; prev_hash: string | null;
};

const ALLOWED_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
const MAX_ATTACHMENT = 10 * 1024 * 1024;

/** תאריך אחרון לרישום לפי הוראה 20: 30 יום מתום החודש של ההוצאה. */
export function recordingDeadline(expenseDate: string): string {
  const [y, m] = expenseDate.split('-').map(Number);
  const endOfMonth = new Date(Date.UTC(y, m, 0));
  return new Date(endOfMonth.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
}

function hashOf(r: Omit<ExpenseRow, 'id' | 'content_hash'>): string {
  const { recorded_at, ...rest } = r;
  return sha256(canonicalJson({ ...rest, recorded_at }));
}

function insertExpense(db: DatabaseSync, data: Omit<ExpenseRow, 'id' | 'entry_number' | 'recorded_at' | 'content_hash' | 'prev_hash'>): ExpenseRow {
  const last = db.prepare('SELECT entry_number, content_hash FROM expenses ORDER BY entry_number DESC LIMIT 1').get() as
    { entry_number: number; content_hash: string } | undefined;
  const row = { ...data, entry_number: (last?.entry_number ?? 0) + 1, recorded_at: nowIso(), prev_hash: last?.content_hash ?? null };
  const content_hash = hashOf(row);
  const r = db.prepare(`INSERT INTO expenses (entry_number, recorded_at, expense_date, supplier_name, supplier_id_number, doc_kind,
      doc_number, description, category, amount_agorot, payment_method, column_kind, attachment, reverses_id, reverse_reason, notes,
      content_hash, prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.entry_number, row.recorded_at, row.expense_date, row.supplier_name, row.supplier_id_number, row.doc_kind, row.doc_number,
    row.description, row.category, row.amount_agorot, row.payment_method, row.column_kind, row.attachment, row.reverses_id,
    row.reverse_reason, row.notes, content_hash, row.prev_hash);
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(r.lastInsertRowid)) as ExpenseRow;
}

/** רישום הוצאה. מחזיר את הרשומה ואזהרות (אם אושרו). */
export function recordExpense(db: DatabaseSync, input: ExpenseInput, saveAttachment?: SaveAttachment): { expense: ExpenseRow; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isIsoDate(input.expenseDate)) errors.push('תאריך ההוצאה לא תקין');
  else if (input.expenseDate > todayIL()) errors.push('תאריך ההוצאה בעתיד');
  if (!input.supplierName?.trim()) errors.push('שם הספק חובה');
  if (!(input.docKind in EXPENSE_DOC_KINDS)) errors.push('סוג מסמך הספק לא תקין');
  if (!input.description?.trim()) errors.push('תיאור ההוצאה חובה');
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) errors.push('קטגוריה לא תקינה');
  if (!Number.isInteger(input.amountAgorot) || input.amountAgorot <= 0) errors.push('סכום חייב להיות חיובי');
  if (!(input.paymentMethod in EXPENSE_PAYMENT_METHODS)) errors.push('אמצעי תשלום לא תקין');
  const columnKind = input.columnKind ?? 'regular';
  if (!['regular', 'asset', 'deposit'].includes(columnKind)) errors.push('סוג טור לא תקין');
  if (!input.docNumber?.trim()) warnings.push('לא צוין מספר מסמך הספק – מומלץ לציין לצורך איתור התיעוד (הוראה 24)');
  if (isIsoDate(input.expenseDate) && todayIL() > recordingDeadline(input.expenseDate))
    warnings.push(`רישום באיחור: הוצאה מ-${input.expenseDate} הייתה צריכה להירשם עד ${recordingDeadline(input.expenseDate)} (הוראה 20)`);
  let buf: Uint8Array | null = null;
  if (input.attachment) {
    if (!(input.attachment.type in ALLOWED_TYPES)) errors.push('סוג קובץ לא נתמך (PDF / JPG / PNG / WEBP / HEIC)');
    try { buf = base64ToBytes(input.attachment.base64 ?? ''); } catch { buf = new Uint8Array(0); }
    if (buf.length === 0 || buf.length > MAX_ATTACHMENT) errors.push('קובץ מצורף ריק או גדול מ-10MB');
    if (!saveAttachment) errors.push('שמירת קבצים מצורפים אינה זמינה');
  }
  if (errors.length) throw new ValidationError(errors, warnings);
  if (warnings.length && !input.acknowledgeWarnings) throw new ValidationError([], warnings);

  // שמירת הקובץ לפי ה-hash שלו (תוכן לעולם לא נדרס)
  let attachment: string | null = null;
  if (input.attachment && buf && saveAttachment) {
    const hash = sha256Bytes(buf);
    const file = `${hash}.${ALLOWED_TYPES[input.attachment.type]}`;
    saveAttachment(file, buf);
    attachment = canonicalJson({ file, sha256: hash, name: input.attachment.name, type: input.attachment.type });
  }

  return inTransaction(db, () => {
    const expense = insertExpense(db, {
      expense_date: input.expenseDate, supplier_name: input.supplierName.trim(), supplier_id_number: input.supplierIdNumber?.trim() || null,
      doc_kind: input.docKind, doc_number: input.docNumber?.trim() || null, description: input.description.trim(), category: input.category,
      amount_agorot: input.amountAgorot, payment_method: input.paymentMethod, column_kind: columnKind, attachment,
      reverses_id: null, reverse_reason: null, notes: input.notes?.trim() || null,
    });
    appendAudit(db, 'expense.record', 'expense', expense.id, { entry: expense.entry_number, amount: expense.amount_agorot, warnings });
    return { expense, warnings };
  });
}

/** רישום נגדי (ביטול רישום שגוי). הרשומה המקורית נשארת. */
export function reverseExpense(db: DatabaseSync, id: number, reason: string): ExpenseRow {
  if (!reason?.trim()) throw new Error('חובה לציין סיבה לרישום הנגדי');
  return inTransaction(db, () => {
    const orig = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseRow | undefined;
    if (!orig) throw new Error(`רישום ${id} לא נמצא`);
    if (orig.reverses_id) throw new Error('אי אפשר לבטל רישום נגדי');
    if (db.prepare('SELECT 1 FROM expenses WHERE reverses_id = ?').get(id)) throw new Error('הרישום כבר בוטל');
    const { id: _id, entry_number: _n, recorded_at: _r, content_hash: _h, prev_hash: _p, ...base } = orig;
    const rev = insertExpense(db, {
      ...base, amount_agorot: -orig.amount_agorot, reverses_id: orig.id, reverse_reason: reason.trim(),
      expense_date: todayIL(), description: `ביטול רישום ${orig.entry_number}: ${orig.description}`, notes: null,
    });
    appendAudit(db, 'expense.reverse', 'expense', rev.id, { reverses: orig.entry_number, reason });
    return rev;
  });
}

/** אימות שרשרת ה-hash של ההוצאות. */
export function verifyExpenses(db: DatabaseSync): { ok: boolean; badEntries: number[] } {
  const rows = db.prepare('SELECT * FROM expenses ORDER BY entry_number').all() as ExpenseRow[];
  const bad: number[] = [];
  let prev: string | null = null;
  rows.forEach((r, i) => {
    const { id, content_hash, ...rest } = r;
    if (r.entry_number !== i + 1 || r.prev_hash !== prev || hashOf(rest) !== content_hash) bad.push(r.entry_number);
    prev = r.content_hash;
  });
  return { ok: bad.length === 0, badEntries: bad };
}
