/**
 * נתוני דוגמה לגרסת הדמו: עסק, לקוחות, מסמכים, הוצאות והכנסה נוספת – הכול בדוי.
 * רץ פעם אחת, כשמסד הדמו ריק. משתמש באותן פונקציות ליבה כמו המערכת האמיתית.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createCustomer, setBusinessProfile } from '../src/core/entities.ts';
import { issueDocument, produceOutput } from '../src/core/documents.ts';
import { recordExpense } from '../src/core/expenses.ts';
import { recordOtherIncome } from '../src/core/otherIncome.ts';
import { todayIL } from '../src/core/util.ts';

const daysAgo = (n: number) => {
  const d = new Date(`${todayIL()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export function seedDemo(db: DatabaseSync): void {
  setBusinessProfile(db, {
    name: 'עסק לדוגמה (דמו)', idNumber: '000000018', address: 'רחוב הדוגמה 1, עיר לדוגמה',
    phone: '050-0000000', email: 'demo@example.com', status: 'exempt',
  });
  const school = createCustomer(db, { name: 'בית ספר "הדוגמה"', idNumber: '580000003', address: 'רחוב החינוך 5, עיר לדוגמה' }).id;
  const parent = createCustomer(db, { name: 'הורה לדוגמה', address: 'רחוב הפרחים 3, עיר לדוגמה', phone: '052-0000000' }).id;
  const npo = createCustomer(db, { name: 'עמותה לדוגמה', idNumber: '580000011', address: 'שדרות הדוגמה 10, עיר לדוגמה' }).id;

  // 1. חשבונית עסקה/קבלה – שולמה בהעברה, "מקור" הופק
  const d1 = issueDocument(db, {
    type: 'invoice_receipt', customerId: parent, issueDate: daysAgo(20), acknowledgeWarnings: true,
    lines: [{ description: 'שיעור פרטי – הכנה למבחן', quantity: 4, unit: 'שעה', unitPriceAgorot: 15_000 }],
    payments: [{ method: 'transfer', amountAgorot: 60_000, date: daysAgo(20), transfer: { reference: '1234', bank: 'בנק לדוגמה' } }],
  }).document;
  produceOutput(db, d1.id, 'original');

  // 2. חשבונית עסקה (עוד לא שולמה) ← 3. קבלה עליה
  const inv = issueDocument(db, {
    type: 'invoice', customerId: npo, issueDate: daysAgo(12), acknowledgeWarnings: true,
    lines: [{ description: 'ליווי צוות מורים – חודש', quantity: 1, unit: 'יחידה', unitPriceAgorot: 120_000 }],
  }).document;
  produceOutput(db, inv.id, 'original');
  const rc = issueDocument(db, {
    type: 'receipt', customerId: npo, issueDate: daysAgo(5), relatedDocumentIds: [inv.id], acknowledgeWarnings: true,
    description: 'תשלום עבור ליווי צוות מורים',
    payments: [{ method: 'transfer', amountAgorot: 120_000, date: daysAgo(5), transfer: { reference: '5678' } }],
  }).document;
  produceOutput(db, rc.id, 'original');

  // 4. חשבונית עסקה/קבלה – מזומן, היום (עוד בלי "מקור": אפשר לנסות להפיק)
  issueDocument(db, {
    type: 'invoice_receipt', customerId: school, issueDate: todayIL(), acknowledgeWarnings: true,
    lines: [{ description: 'סדנה למורים', quantity: 1, unit: 'יחידה', unitPriceAgorot: 18_000 }],
    payments: [{ method: 'cash', amountAgorot: 18_000, date: todayIL() }],
  });

  // הוצאות
  recordExpense(db, {
    expenseDate: daysAgo(15), supplierName: 'חנות ספרים לדוגמה', docKind: 'tax_invoice_receipt', docNumber: '10045',
    description: 'חוברות עבודה', category: 'ציוד וחומרים', amountAgorot: 24_000, paymentMethod: 'credit_card', acknowledgeWarnings: true,
  });
  recordExpense(db, {
    expenseDate: daysAgo(3), supplierName: 'ספק תקשורת לדוגמה', docKind: 'tax_invoice', docNumber: 'A-778',
    description: 'אינטרנט וטלפון – חודשי', category: 'טלפון ואינטרנט', amountAgorot: 9_900, paymentMethod: 'standing_order', acknowledgeWarnings: true,
  });

  // הכנסה נוספת (לא נכנסת למחזור)
  recordOtherIncome(db, {
    incomeDate: daysAgo(10), kind: 'nii_reserve', payer: 'ביטוח לאומי', description: 'דמי מילואים (דוגמה)', amountAgorot: 150_000,
  });
}
