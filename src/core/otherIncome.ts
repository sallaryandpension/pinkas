/**
 * הכנסות שאינן ממסמכים שהעסק הפיק.
 * - תקנות מס הכנסה (קביעת סוגי עסקאות, הכנסות או מכירות שיוספו או יוחרגו ממחזור העסקאות של בעל עסק זעיר),
 *   התשפ"ו-2025 (ס' 87ז לפקודה): פיצויים בעד נזק עקיף ומענקי רשות המסים על פגיעה במחזור – **נכללים במחזור**.
 * - דמי מילואים ודמי לידה מביטוח לאומי – **אינם** חלק מהמחזור, ומדווחים בשדה ייעודי בדיווח המקוצר
 *   (ש"ות "כל זכות" על עסק זעיר). אם התקבלו מהמעסיק – הם שכר, לא כאן.
 */
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/open.ts';
import { appendAudit } from './audit.ts';
import { ValidationError } from './documents.ts';
import { canonicalJson, isIsoDate, nowIso, sha256, todayIL } from './util.ts';

export const OTHER_INCOME_KINDS = {
  compensation: { name: 'פיצוי על נזק עקיף (מס רכוש)', inTurnover: true },
  grant: { name: 'מענק רשות המסים על פגיעה במחזור', inTurnover: true },
  nii_reserve: { name: 'דמי מילואים מביטוח לאומי', inTurnover: false },
  nii_maternity: { name: 'דמי לידה מביטוח לאומי', inTurnover: false },
} as const;
export type OtherIncomeKind = keyof typeof OTHER_INCOME_KINDS;

export type OtherIncomeRow = {
  id: number; entry_number: number; recorded_at: string; income_date: string; kind: OtherIncomeKind; payer: string;
  description: string; amount_agorot: number; reference: string | null; reverses_id: number | null; reverse_reason: string | null;
  content_hash: string; prev_hash: string | null;
};

const hashOf = (r: Omit<OtherIncomeRow, 'id' | 'content_hash'>) => sha256(canonicalJson(r));

function insert(db: DatabaseSync, data: Omit<OtherIncomeRow, 'id' | 'entry_number' | 'recorded_at' | 'content_hash' | 'prev_hash'>): OtherIncomeRow {
  const last = db.prepare('SELECT entry_number, content_hash FROM other_income ORDER BY entry_number DESC LIMIT 1').get() as
    { entry_number: number; content_hash: string } | undefined;
  const row = { ...data, entry_number: (last?.entry_number ?? 0) + 1, recorded_at: nowIso(), prev_hash: last?.content_hash ?? null };
  const r = db.prepare(`INSERT INTO other_income (entry_number, recorded_at, income_date, kind, payer, description, amount_agorot,
    reference, reverses_id, reverse_reason, content_hash, prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.entry_number, row.recorded_at, row.income_date, row.kind, row.payer, row.description, row.amount_agorot,
    row.reference, row.reverses_id, row.reverse_reason, hashOf(row), row.prev_hash);
  return db.prepare('SELECT * FROM other_income WHERE id = ?').get(Number(r.lastInsertRowid)) as OtherIncomeRow;
}

export function recordOtherIncome(db: DatabaseSync, input: {
  incomeDate: string; kind: OtherIncomeKind; payer: string; description: string; amountAgorot: number; reference?: string;
}): OtherIncomeRow {
  const errors: string[] = [];
  if (!isIsoDate(input.incomeDate) || input.incomeDate > todayIL()) errors.push('תאריך לא תקין');
  if (!(input.kind in OTHER_INCOME_KINDS)) errors.push('סוג הכנסה לא תקין');
  if (!input.payer?.trim()) errors.push('המשלם חובה');
  if (!input.description?.trim()) errors.push('תיאור חובה');
  if (!Number.isInteger(input.amountAgorot) || input.amountAgorot <= 0) errors.push('סכום חייב להיות חיובי');
  if (errors.length) throw new ValidationError(errors, []);
  return inTransaction(db, () => {
    const row = insert(db, {
      income_date: input.incomeDate, kind: input.kind, payer: input.payer.trim(), description: input.description.trim(),
      amount_agorot: input.amountAgorot, reference: input.reference?.trim() || null, reverses_id: null, reverse_reason: null,
    });
    appendAudit(db, 'other_income.record', 'other_income', row.id, { kind: row.kind, amount: row.amount_agorot });
    return row;
  });
}

export function reverseOtherIncome(db: DatabaseSync, id: number, reason: string): OtherIncomeRow {
  if (!reason?.trim()) throw new Error('חובה לציין סיבה');
  return inTransaction(db, () => {
    const o = db.prepare('SELECT * FROM other_income WHERE id = ?').get(id) as OtherIncomeRow | undefined;
    if (!o) throw new Error('רישום לא נמצא');
    if (o.reverses_id || db.prepare('SELECT 1 FROM other_income WHERE reverses_id = ?').get(id)) throw new Error('אי אפשר לבטל רישום זה');
    const row = insert(db, {
      income_date: todayIL(), kind: o.kind, payer: o.payer, description: `ביטול רישום ${o.entry_number}: ${o.description}`,
      amount_agorot: -o.amount_agorot, reference: o.reference, reverses_id: o.id, reverse_reason: reason.trim(),
    });
    appendAudit(db, 'other_income.reverse', 'other_income', row.id, { reverses: o.entry_number, reason });
    return row;
  });
}

export function otherIncomeTotals(db: DatabaseSync, from: string, to: string) {
  const rows = db.prepare('SELECT kind, SUM(amount_agorot) s FROM other_income WHERE income_date BETWEEN ? AND ? GROUP BY kind')
    .all(from, to) as { kind: OtherIncomeKind; s: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.s])) as Partial<Record<OtherIncomeKind, number>>;
  return {
    inTurnover: (by.compensation ?? 0) + (by.grant ?? 0),
    niiReserve: by.nii_reserve ?? 0,
    niiMaternity: by.nii_maternity ?? 0,
  };
}

export function verifyOtherIncome(db: DatabaseSync): { ok: boolean; badEntries: number[] } {
  const rows = db.prepare('SELECT * FROM other_income ORDER BY entry_number').all() as OtherIncomeRow[];
  const bad: number[] = [];
  let prev: string | null = null;
  rows.forEach((r, i) => {
    const { id, content_hash, ...rest } = r;
    if (r.entry_number !== i + 1 || r.prev_hash !== prev || hashOf(rest) !== content_hash) bad.push(r.entry_number);
    prev = r.content_hash;
  });
  return { ok: bad.length === 0, badEntries: bad };
}
