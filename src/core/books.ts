/**
 * ספר תקבולים ותשלומים (הוראה 12) – נבנה אוטומטית מהקבלות/חשבוניות-קבלה ומההוצאות.
 * "יירשמו בו כל התקבולים והתשלומים ... תוך ציון התיעוד והתאריך", בטורים נפרדים לרכישה/מכירה של נכסים ולפיקדונות.
 */
import type { DatabaseSync } from 'node:sqlite';
import { DOC_TYPE_NAMES, type DocumentRow } from './documents.ts';
import { EXPENSE_DOC_KINDS, type ExpenseRow } from './expenses.ts';
import { PARAMS, paramAt } from './params.ts';
import { todayIL } from './util.ts';

export type BookRow = {
  date: string;
  ref: string;              // סימול לאיתור התיעוד
  name: string;             // לקוח / ספק
  description: string;
  receipt: number;          // תקבול (ברוטו, כולל ניכוי במקור – הוראה 12(ג))
  withholding: number;      // מתוכו ניכוי במקור
  payment: number;          // תשלום שוטף
  asset: number;            // רכישת נכסים
  deposit: number;          // פיקדונות
  source: 'document' | 'expense';
  sourceId: number;
};

export function receiptsPaymentsBook(db: DatabaseSync, from: string, to: string): { rows: BookRow[]; totals: Omit<BookRow, 'date' | 'ref' | 'name' | 'description' | 'source' | 'sourceId'> } {
  const docs = db.prepare(`SELECT * FROM documents WHERE status = 'issued' AND doc_type IN ('receipt', 'invoice_receipt')
    AND issue_date BETWEEN ? AND ? ORDER BY issue_date, id`).all(from, to) as DocumentRow[];
  const exps = db.prepare('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date, entry_number')
    .all(from, to) as ExpenseRow[];

  const rows: BookRow[] = [
    ...docs.map((d) => {
      const body = JSON.parse(d.body);
      return {
        date: d.issue_date, ref: `${DOC_TYPE_NAMES[d.doc_type]} ${d.number}`, name: JSON.parse(d.customer_snapshot)?.name ?? '',
        description: body.description ?? body.lines?.[0]?.description ?? '',
        receipt: d.total_agorot, withholding: body.withholdingAgorot ?? 0, payment: 0, asset: 0, deposit: 0,
        source: 'document' as const, sourceId: d.id,
      };
    }),
    ...exps.map((e) => ({
      date: e.expense_date,
      ref: `רישום ${e.entry_number}${e.doc_number ? ` · ${EXPENSE_DOC_KINDS[e.doc_kind]} ${e.doc_number}` : ''}`,
      name: e.supplier_name, description: e.description,
      receipt: 0, withholding: 0,
      payment: e.column_kind === 'regular' ? e.amount_agorot : 0,
      asset: e.column_kind === 'asset' ? e.amount_agorot : 0,
      deposit: e.column_kind === 'deposit' ? e.amount_agorot : 0,
      source: 'expense' as const, sourceId: e.id,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.source === b.source ? a.sourceId - b.sourceId : a.source === 'document' ? -1 : 1));

  const sum = (k: 'receipt' | 'withholding' | 'payment' | 'asset' | 'deposit') => rows.reduce((s, r) => s + r[k], 0);
  return { rows, totals: { receipt: sum('receipt'), withholding: sum('withholding'), payment: sum('payment'), asset: sum('asset'), deposit: sum('deposit') } };
}

/** סיכום שנתי – נתונים להכנת הדוחות השנתיים (לא חישוב מס). */
export function annualSummary(db: DatabaseSync, year: number) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const { totals } = receiptsPaymentsBook(db, from, to);
  const byCategory = db.prepare(`SELECT category, SUM(amount_agorot) total FROM expenses
    WHERE column_kind = 'regular' AND expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`).all(from, to) as
    { category: string; total: number }[];
  const assets = db.prepare(`SELECT expense_date, supplier_name, description, amount_agorot FROM expenses
    WHERE column_kind = 'asset' AND expense_date BETWEEN ? AND ? ORDER BY expense_date`).all(from, to) as any[];
  const invoiced = db.prepare(`SELECT COALESCE(SUM(CASE WHEN doc_type = 'credit' THEN -total_agorot ELSE total_agorot END), 0) s
    FROM documents WHERE status = 'issued' AND doc_type IN ('invoice', 'invoice_receipt', 'credit') AND issue_date BETWEEN ? AND ?`).get(from, to) as { s: number };
  return {
    year, receipts: totals.receipt, withholding: totals.withholding, invoicedNet: invoiced.s,
    expensesRegular: totals.payment, assets: totals.asset, deposits: totals.deposit,
    byCategory, assetList: assets,
    netBeforeAdjustments: totals.receipt - totals.payment,
  };
}

/** מחזור מצטבר לעומת תקרת עוסק פטור. מחזור = חשבוניות (נטו אחרי זיכויים) + קבלות שאינן מקושרות לחשבונית. */
export function exemptCeilingStatus(db: DatabaseSync, today = todayIL()) {
  const year = today.slice(0, 4);
  const from = `${year}-01-01`;
  const invoiced = db.prepare(`SELECT COALESCE(SUM(CASE WHEN doc_type = 'credit' THEN -total_agorot ELSE total_agorot END), 0) s
    FROM documents WHERE status = 'issued' AND doc_type IN ('invoice', 'invoice_receipt', 'credit') AND issue_date BETWEEN ? AND ?`).get(from, today) as { s: number };
  const receiptsNoInvoice = (db.prepare(`SELECT body, total_agorot FROM documents WHERE status = 'issued' AND doc_type = 'receipt'
    AND issue_date BETWEEN ? AND ?`).all(from, today) as { body: string; total_agorot: number }[])
    .filter((r) => !(JSON.parse(r.body).relatedDocumentIds ?? []).length)
    .reduce((s, r) => s + r.total_agorot, 0);
  const turnover = invoiced.s + receiptsNoInvoice;
  const ceiling = paramAt(PARAMS.exemptDealerCeilingAgorot, `${year}-01-01`);
  return { year: Number(year), turnover, ceiling, percent: Math.round((turnover / ceiling) * 1000) / 10 };
}
