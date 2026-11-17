import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/open.ts';
import { setBusinessProfile, createCustomer, updateCustomer } from '../src/core/entities.ts';
import {
  issueDocument, produceOutput, cancelDocument, recordOriginalDelivery, setSeriesStart,
  getDocument, ValidationError, type IssueInput,
} from '../src/core/documents.ts';
import { continuityReport, customerLedger } from '../src/core/reports.ts';
import { verifyAuditChain } from '../src/core/audit.ts';
import { todayIL } from '../src/core/util.ts';

const today = todayIL();
let db: DatabaseSync;
let customerId: number;

function setup() {
  db = openDb(':memory:');
  setBusinessProfile(db, { name: 'עסק לדוגמה', idNumber: '123456782', address: 'רחוב הדוגמה 1, תל אביב', status: 'exempt' });
  customerId = createCustomer(db, { name: 'בית ספר אלון', address: 'רחוב האלון 5, חיפה' }).id;
}

const invoiceReceipt = (amount = 50_000): IssueInput => ({
  type: 'invoice_receipt', customerId,
  lines: [{ description: 'ליווי פדגוגי', quantity: 1, unit: 'מפגש', unitPriceAgorot: amount }],
  payments: [{ method: 'transfer', amountAgorot: amount, date: today, transfer: { reference: 'A1' } }],
});

describe('קובץ קבוע – אי-עריכה ואי-מחיקה (הוראה 23(ב), הגדרת קובץ קבוע)', () => {
  beforeEach(setup);

  test('אי אפשר למחוק מסמך, גם ב-SQL ישיר', () => {
    const { document } = issueDocument(db, invoiceReceipt());
    assert.throws(() => db.prepare('DELETE FROM documents WHERE id = ?').run(document.id), /FORBIDDEN/);
  });

  test('אי אפשר לשנות סכום, תוכן או תאריך, גם ב-SQL ישיר', () => {
    const { document } = issueDocument(db, invoiceReceipt());
    assert.throws(() => db.prepare('UPDATE documents SET total_agorot = 1 WHERE id = ?').run(document.id), /FORBIDDEN/);
    assert.throws(() => db.prepare("UPDATE documents SET body = '{}' WHERE id = ?").run(document.id), /FORBIDDEN/);
    assert.throws(() => db.prepare("UPDATE documents SET issue_date = '2000-01-01' WHERE id = ?").run(document.id), /FORBIDDEN/);
  });

  test('אי אפשר למחוק או לשנות את יומן האירועים', () => {
    issueDocument(db, invoiceReceipt());
    assert.throws(() => db.exec('DELETE FROM audit_log'), /FORBIDDEN/);
    assert.throws(() => db.exec("UPDATE audit_log SET action = 'x'"), /FORBIDDEN/);
    assert.equal(verifyAuditChain(db).ok, true);
  });

  test('אי אפשר למחוק לקוח שיש לו מסמכים', () => {
    issueDocument(db, invoiceReceipt());
    assert.throws(() => db.prepare('DELETE FROM customers WHERE id = ?').run(customerId), /FORBIDDEN/);
  });
});

describe('מספור עוקב (18(א)(3), נספח ה(א)(5))', () => {
  beforeEach(setup);

  test('סדרה נפרדת לכל סוג מסמך, מספרים עוקבים', () => {
    const a = issueDocument(db, invoiceReceipt()).document;
    const b = issueDocument(db, invoiceReceipt()).document;
    const r = issueDocument(db, {
      type: 'receipt', customerId, description: 'מקדמה',
      payments: [{ method: 'cash', amountAgorot: 10_000, date: today }],
    }).document;
    assert.deepEqual([a.number, b.number, r.number], [1, 2, 1]);
  });

  test('אי אפשר להכניס מספר שאינו הבא בסדרה', () => {
    issueDocument(db, invoiceReceipt());
    const doc = getDocument(db, 1)!;
    assert.throws(() => db.prepare(`INSERT INTO documents (doc_type, number, issue_date, created_at, customer_snapshot,
      business_snapshot, body, total_agorot, content_hash) VALUES ('invoice_receipt', 5, ?, ?, '{}', '{}', '{}', 1, 'x')`)
      .run(doc.issue_date, doc.created_at), /FORBIDDEN/);
  });

  test('כשל באמצע הפקה לא משאיר חור או מספר אבוד', () => {
    issueDocument(db, invoiceReceipt());
    assert.throws(() => issueDocument(db, { ...invoiceReceipt(), payments: [] }), ValidationError);
    const next = issueDocument(db, invoiceReceipt()).document;
    assert.equal(next.number, 2);
    assert.ok(continuityReport(db).every((s) => s.ok));
  });

  test('מספר התחלה (המשך מפנקס קודם) – רק לפני המסמך הראשון', () => {
    setSeriesStart(db, 'receipt', 501);
    const r = issueDocument(db, {
      type: 'receipt', customerId, description: 'תשלום', payments: [{ method: 'cash', amountAgorot: 5_000, date: today }],
    }).document;
    assert.equal(r.number, 501);
    assert.throws(() => setSeriesStart(db, 'receipt', 900), /FORBIDDEN/);
  });

  test('דוח רציפות מזהה שינוי שנעשה מחוץ לתוכנה (אחרי עקיפת ה-triggers)', () => {
    issueDocument(db, invoiceReceipt());
    issueDocument(db, invoiceReceipt());
    db.exec('DROP TRIGGER documents_immutable');                  // סימולציה של התערבות חיצונית
    db.exec("UPDATE documents SET total_agorot = 1 WHERE number = 1 AND doc_type = 'invoice_receipt'");
    const s = continuityReport(db).find((x) => x.docType === 'invoice_receipt')!;
    assert.equal(s.ok, false);
    assert.deepEqual(s.hashErrors, [1]);
  });
});

describe('מקור / העתק (נספח ה(א)(4), 18(ב)(2))', () => {
  beforeEach(setup);

  test('"מקור" מופק פעם אחת בלבד, כל השאר "העתק"', () => {
    const { document } = issueDocument(db, invoiceReceipt());
    assert.equal(produceOutput(db, document.id, 'copy', 'sent').label, 'העתק');
    assert.equal(produceOutput(db, document.id, 'original').label, 'מקור');
    assert.throws(() => produceOutput(db, document.id, 'original'), /הופק כבר/);
    assert.throws(() => db.prepare('UPDATE documents SET original_produced_at = NULL WHERE id = ?').run(document.id), /FORBIDDEN/);
  });

  test('ההעתק מציג את פרטי הלקוח כפי שהיו בעת ההפקה', () => {
    const { document } = issueDocument(db, invoiceReceipt());
    updateCustomer(db, customerId, { name: 'בית ספר אלון', address: 'כתובת חדשה' });
    const copy = produceOutput(db, document.id, 'copy').document;
    assert.match(copy.customer_snapshot, /רחוב האלון 5/);
  });

  test('רישום מסירת המקור – פעם אחת, אחרי הפקתו', () => {
    const { document } = issueDocument(db, invoiceReceipt());
    assert.throws(() => recordOriginalDelivery(db, document.id, { method: 'mail', date: today }), /FORBIDDEN/);
    produceOutput(db, document.id, 'original');
    recordOriginalDelivery(db, document.id, { method: 'mail', date: today });
    assert.throws(() => recordOriginalDelivery(db, document.id, { method: 'hand', date: today }), /FORBIDDEN/);
  });
});

describe('ביטול וזיכוי (23א)', () => {
  beforeEach(setup);

  test('ביטול מותר לפני שהמסמך יצא; המספר נשרף ולא חוזר', () => {
    const { document } = issueDocument(db, invoiceReceipt());
    cancelDocument(db, document.id, 'טעות בסכום');
    assert.equal(getDocument(db, document.id)!.status, 'cancelled');
    assert.equal(issueDocument(db, invoiceReceipt()).document.number, 2);
    assert.deepEqual(continuityReport(db).find((s) => s.docType === 'invoice_receipt')!.cancelledNumbers, [1]);
  });

  test('אסור לבטל אחרי הפקת מקור או שליחת העתק – רק זיכוי', () => {
    const a = issueDocument(db, invoiceReceipt()).document;
    produceOutput(db, a.id, 'original');
    assert.throws(() => cancelDocument(db, a.id, 'x'), /הודעת זיכוי/);
    const b = issueDocument(db, invoiceReceipt()).document;
    produceOutput(db, b.id, 'copy', 'sent');
    assert.throws(() => cancelDocument(db, b.id, 'x'), /הודעת זיכוי/);
  });

  test('הודעת זיכוי: חייבת חשבונית וסיבה, ולא יותר מיתרת החשבונית', () => {
    const inv = issueDocument(db, invoiceReceipt(50_000)).document;
    const credit = (amount: number, reason?: string): IssueInput => ({
      type: 'credit', customerId, relatedDocumentIds: [inv.id], reason,
      lines: [{ description: 'החזר חלקי', quantity: 1, unit: 'יחידה', unitPriceAgorot: amount }],
    });
    assert.throws(() => issueDocument(db, credit(10_000)), /הסיבה/);
    issueDocument(db, credit(30_000, 'מפגש בוטל'));
    assert.throws(() => issueDocument(db, credit(30_000, 'עוד')), /עולה על יתרת/);
  });
});

describe('כללי עוסק פטור ונותן שירותים', () => {
  beforeEach(setup);

  test('אין סוג מסמך "חשבונית מס"', () => {
    assert.throws(() => issueDocument(db, { ...invoiceReceipt(), type: 'tax_invoice' as any }), ValidationError);
  });

  test('קבלה מ-210 ₪ בלי חשבונית – אזהרה שדורשת אישור', () => {
    const input: IssueInput = { type: 'receipt', customerId, description: 'תשלום על ליווי',
      payments: [{ method: 'transfer', amountAgorot: 30_000, date: today, transfer: {} }] };
    assert.throws(() => issueDocument(db, input), (e: any) => e instanceof ValidationError && e.warnings.length === 1);
    assert.equal(issueDocument(db, { ...input, acknowledgeWarnings: true }).document.number, 1);
  });

  test('שיק בלי מספר / בנק / סניף / פירעון – נחסם (5(ב))', () => {
    assert.throws(() => issueDocument(db, { type: 'receipt', customerId, description: 'x',
      payments: [{ method: 'cheque', amountAgorot: 10_000, date: today, cheque: { number: '1', bank: '', branch: '', dueDate: today } }] }),
      /5\(ב\)/);
  });

  test('חוק המזומן – מזומן מעל המותר בעסקה גדולה מקבל אזהרה', () => {
    const big = 1_000_000; // 10,000 ₪ → מותר במזומן 1,000 ₪
    const input: IssueInput = { type: 'invoice_receipt', customerId,
      lines: [{ description: 'סדרת מפגשים', quantity: 1, unit: 'חבילה', unitPriceAgorot: big }],
      payments: [{ method: 'cash', amountAgorot: big, date: today }] };
    assert.throws(() => issueDocument(db, input), (e: any) => e.warnings?.some((w: string) => w.includes('מזומן')));
  });

  test('חשבונית-קבלה: התשלומים חייבים להתאים לסכום', () => {
    assert.throws(() => issueDocument(db, { ...invoiceReceipt(50_000),
      payments: [{ method: 'transfer', amountAgorot: 40_000, date: today, transfer: {} }] }), /חייב להיות שווה/);
  });

  test('אסור תאריך עתידי', () => {
    assert.throws(() => issueDocument(db, { ...invoiceReceipt(), issueDate: '2999-01-01' }), /עתידי/);
  });

  test('כרטסת לקוח: חשבונית מחייבת, קבלה מזכה', () => {
    const inv = issueDocument(db, { type: 'invoice', customerId,
      lines: [{ description: 'סדנה', quantity: 2, unit: 'סדנה', unitPriceAgorot: 40_000 }] }).document;
    issueDocument(db, { type: 'receipt', customerId, description: 'תשלום חשבונית 1', relatedDocumentIds: [inv.id],
      payments: [{ method: 'transfer', amountAgorot: 50_000, date: today, transfer: {} }] });
    assert.equal(customerLedger(db, customerId).balance, 30_000);
  });
});
