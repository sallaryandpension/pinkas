import type { DatabaseSync } from 'node:sqlite';
import { contentHashOf, DOC_TYPE_NAMES, type DocType, type DocumentRow } from './documents.ts';

export type SeriesContinuity = {
  docType: DocType;
  name: string;
  startNumber: number;
  lastNumber: number | null;
  count: number;
  missingNumbers: number[];        // חורים ברצף – חייב להיות ריק
  cancelledNumbers: number[];
  hashErrors: number[];            // מסמכים שתוכנם או שרשורם אינו תואם
  ok: boolean;
};

/** בדיקת רצף המספרים העוקבים (נספח ה(א)(5)) + אימות שרשרת ה-hash. */
export function continuityReport(db: DatabaseSync): SeriesContinuity[] {
  const series = db.prepare('SELECT doc_type, start_number, next_number FROM series ORDER BY doc_type').all() as any[];
  return series.map((s) => {
    const docs = db.prepare('SELECT * FROM documents WHERE doc_type = ? ORDER BY number').all(s.doc_type) as DocumentRow[];
    const present = new Set(docs.map((d) => d.number));
    const missing: number[] = [];
    for (let n = s.start_number; n < s.next_number; n++) if (!present.has(n)) missing.push(n);
    const hashErrors: number[] = [];
    let prevHash: string | null = null;
    for (const d of docs) {
      if (d.prev_hash !== prevHash || contentHashOf(d) !== d.content_hash) hashErrors.push(d.number);
      prevHash = d.content_hash;
    }
    return {
      docType: s.doc_type,
      name: DOC_TYPE_NAMES[s.doc_type as DocType],
      startNumber: s.start_number,
      lastNumber: docs.length ? docs[docs.length - 1].number : null,
      count: docs.length,
      missingNumbers: missing,
      cancelledNumbers: docs.filter((d) => d.status === 'cancelled').map((d) => d.number),
      hashErrors,
      ok: missing.length === 0 && hashErrors.length === 0,
    };
  });
}

export type LedgerEntry = { date: string; docType: DocType; number: number; debit: number; credit: number; balance: number };

/**
 * כרטסת לקוח: חיוב = חשבונית; זיכוי = קבלה / הודעת זיכוי; חשבונית-קבלה = חיוב וזיכוי באותו סכום.
 * הזמנות אינן תנועה כספית. מסמכים מבוטלים אינם נכללים.
 */
export function customerLedger(db: DatabaseSync, customerId: number): { entries: LedgerEntry[]; balance: number } {
  const docs = db.prepare(
    "SELECT * FROM documents WHERE customer_id = ? AND status = 'issued' AND doc_type <> 'order' ORDER BY issue_date, id",
  ).all(customerId) as DocumentRow[];
  let balance = 0;
  const entries: LedgerEntry[] = [];
  for (const d of docs) {
    const debit = d.doc_type === 'invoice' || d.doc_type === 'invoice_receipt' ? d.total_agorot : 0;
    const credit = d.doc_type === 'receipt' || d.doc_type === 'invoice_receipt' || d.doc_type === 'credit' ? d.total_agorot : 0;
    balance += debit - credit;
    entries.push({ date: d.issue_date, docType: d.doc_type, number: d.number, debit, credit, balance });
  }
  return { entries, balance };
}

/** רשימת יתרות לקוחות לסוף שנת מס (תוספת י"א 2(ג)(7)). */
export function customerBalancesAt(db: DatabaseSync, date: string): { customerId: number; name: string; balance: number }[] {
  const customers = db.prepare('SELECT id, name FROM customers ORDER BY name').all() as any[];
  return customers
    .map((c) => {
      const { entries } = customerLedger(db, c.id);
      const upto = entries.filter((e) => e.date <= date);
      return { customerId: c.id, name: c.name, balance: upto.length ? upto[upto.length - 1].balance : 0 };
    })
    .filter((r) => r.balance !== 0);
}
