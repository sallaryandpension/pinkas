import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/open.ts';
import { setBusinessProfile, createCustomer } from '../src/core/entities.ts';
import { issueDocument, ValidationError } from '../src/core/documents.ts';
import { recordExpense, reverseExpense, verifyExpenses, recordingDeadline, type ExpenseInput } from '../src/core/expenses.ts';
import { receiptsPaymentsBook, annualSummary, exemptCeilingStatus } from '../src/core/books.ts';
import { createBackup, fsAttachmentSaver } from '../src/core/backup.ts';
import { todayIL } from '../src/core/util.ts';

let dir: string, db: DatabaseSync, customerId: number;
const today = todayIL();
const exp = (over: Partial<ExpenseInput> = {}): ExpenseInput => ({
  expenseDate: today, supplierName: 'סטימצקי', docKind: 'tax_invoice_receipt', docNumber: '1001',
  description: 'ספרי הדרכה', category: 'ספרות והשתלמויות', amountAgorot: 25_000, paymentMethod: 'credit_card', ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinkas-exp-'));
  db = openDb(join(dir, 'pinkas.db'));
  setBusinessProfile(db, { name: 'עסק', idNumber: '123456782', address: 'כתובת', status: 'exempt' });
  customerId = createCustomer(db, { name: 'בית ספר', address: 'כתובת' }).id;
});
const rec = (i: ExpenseInput) => recordExpense(db, i, fsAttachmentSaver(dir));
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('הוצאות (הוראות 12, 20, 23(א)(2))', () => {
  test('מספור עוקב; אין עריכה ואין מחיקה גם ב-SQL', () => {
    const a = rec(exp()).expense;
    const b = rec(exp({ docNumber: '1002' })).expense;
    assert.deepEqual([a.entry_number, b.entry_number], [1, 2]);
    assert.throws(() => db.exec('UPDATE expenses SET amount_agorot = 1'), /FORBIDDEN/);
    assert.throws(() => db.exec('DELETE FROM expenses'), /FORBIDDEN/);
  });

  test('רישום נגדי: המקור נשאר, נוסף רישום שלילי, ואי אפשר לבטל פעמיים', () => {
    const a = rec(exp()).expense;
    const r = reverseExpense(db, a.id, 'נרשם פעמיים');
    assert.equal(r.amount_agorot, -25_000);
    assert.equal(r.reverses_id, a.id);
    assert.throws(() => reverseExpense(db, a.id, 'שוב'), /כבר בוטל/);
    assert.equal(verifyExpenses(db).ok, true);
    assert.equal(receiptsPaymentsBook(db, '2000-01-01', today).totals.payment, 0);
  });

  test('ולידציה: ספק, תיאור, סכום חובה; בלי מספר מסמך – אזהרה', () => {
    assert.throws(() => rec(exp({ supplierName: '' })), /שם הספק/);
    assert.throws(() => rec(exp({ amountAgorot: 0 })), /חיובי/);
    assert.throws(() => rec(exp({ docNumber: undefined })), (e: any) => e instanceof ValidationError && e.warnings.length === 1);
    assert.ok(rec(exp({ docNumber: undefined, acknowledgeWarnings: true })).expense);
  });

  test('רישום באיחור (מעבר ל-30 יום מתום החודש) – אזהרה', () => {
    assert.equal(recordingDeadline('2026-01-15'), '2026-03-02');
    assert.throws(() => rec(exp({ expenseDate: '2025-01-10' })), (e: any) => e.warnings?.some((w: string) => w.includes('באיחור')));
  });

  test('קובץ מצורף נשמר לפי hash ונכלל בגיבוי', () => {
    const base64 = Buffer.from('%PDF-1.4 receipt').toString('base64');
    const { expense } = rec(exp({ attachment: { name: 'r.pdf', type: 'application/pdf', base64 } }));
    const a = JSON.parse(expense.attachment!);
    assert.ok(existsSync(join(dir, 'attachments', a.file)));
    const usb = join(dir, 'usb'); require_mkdir(usb);
    const { dir: bk, verify } = createBackup(db, { dataDir: dir, targetDir: usb, kind: 'local' });
    assert.equal(verify.ok, true, verify.problems.join());
    assert.ok(readdirSync(join(bk, 'attachments')).includes(a.file));
  });

  test('קובץ מצורף נבדק לפי התוכן: HTML/SVG שמוצהר כ-PDF נדחה; סוג נקבע לפי התוכן', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    assert.throws(() => rec(exp({ attachment: { name: 'r.pdf', type: 'application/pdf', base64: html } })),
      (e: any) => e.errors?.some((x: string) => x.includes('סוג קובץ')));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
    assert.throws(() => rec(exp({ attachment: { name: 'x.png', type: 'image/png', base64: svg } })));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const { expense } = rec(exp({ attachment: { name: 'r.bin', type: 'text/html', base64: png } }));
    const a = JSON.parse(expense.attachment!);
    assert.equal(a.type, 'image/png');
    assert.match(a.file, /\.png$/);
  });

  test('ספר תקבולים ותשלומים: תקבולים מהקבלות, תשלומים / נכסים בטורים נפרדים', () => {
    issueDocument(db, { type: 'invoice_receipt', customerId,
      lines: [{ description: 'ליווי', quantity: 2, unit: 'מפגש', unitPriceAgorot: 40_000 }],
      payments: [{ method: 'transfer', amountAgorot: 70_000, date: today, transfer: {} }], withholdingAgorot: 10_000 });
    rec(exp());
    rec(exp({ description: 'מחשב נייד', category: 'מחשב, תוכנה ומנויים', amountAgorot: 400_000, columnKind: 'asset', docNumber: '77' }));
    const { rows, totals } = receiptsPaymentsBook(db, '2000-01-01', today);
    assert.equal(rows.length, 3);
    assert.deepEqual(totals, { receipt: 80_000, withholding: 10_000, payment: 25_000, asset: 400_000, deposit: 0 });
    const s = annualSummary(db, Number(today.slice(0, 4)));
    assert.equal(s.netBeforeAdjustments, 55_000);
    assert.equal(s.byCategory[0].category, 'ספרות והשתלמויות');
  });

  test('מחזור מול תקרת עוסק פטור: חשבוניות נטו + קבלות לא מקושרות', () => {
    const inv = issueDocument(db, { type: 'invoice', customerId, lines: [{ description: 'סדנה', quantity: 1, unit: 'סדנה', unitPriceAgorot: 100_000 }] }).document;
    issueDocument(db, { type: 'receipt', customerId, description: 'תשלום', relatedDocumentIds: [inv.id],
      payments: [{ method: 'transfer', amountAgorot: 100_000, date: today, transfer: {} }] });
    issueDocument(db, { type: 'receipt', customerId, description: 'מקדמה', acknowledgeWarnings: true,
      payments: [{ method: 'cash', amountAgorot: 30_000, date: today }] });
    assert.equal(exemptCeilingStatus(db).turnover, 130_000);   // לא סופר פעמיים את הקבלה על החשבונית
  });
});

describe('דיווחים שנתיים (עוסק פטור / עסק זעיר)', () => {
  test('מועדים קרובים: תיאום מס, הצהרת מע"מ, דיווח מקוצר – לפי הסדר', () => {
    assert.deepEqual(upcomingDeadlines('2026-11-17').map((d) => d.date), ['2026-12-31', '2027-01-31', '2027-03-31']);
    assert.equal(upcomingDeadlines('2026-02-01')[0].date, '2026-08-31');   // אורכה לשנת 2025
  });
  test('סיכום שנתי: מחזור והכנסה חייבת 70% לעסק זעיר', () => {
    issueDocument(db, { type: 'invoice_receipt', customerId,
      lines: [{ description: 'ליווי', quantity: 1, unit: 'מפגש', unitPriceAgorot: 100_000 }],
      payments: [{ method: 'transfer', amountAgorot: 100_000, date: today, transfer: {} }] });
    const s = annualSummary(db, Number(today.slice(0, 4)));
    assert.equal(s.turnover, 100_000);
    assert.equal(s.smallBusinessTaxable, 70_000);
  });
});

describe('הכנסות נוספות (תקנות התשפ"ו-2025)', () => {
  test('פיצוי נזק עקיף נכנס למחזור ולספר; דמי לידה/מילואים לא', () => {
    recordOtherIncome(db, { incomeDate: today, kind: 'compensation', payer: 'מס רכוש', description: 'פיצוי מלחמה', amountAgorot: 50_000 });
    recordOtherIncome(db, { incomeDate: today, kind: 'nii_maternity', payer: 'ביטוח לאומי', description: 'דמי לידה', amountAgorot: 900_000 });
    const s = annualSummary(db, Number(today.slice(0, 4)));
    assert.equal(s.turnover, 50_000);
    assert.equal(s.niiMaternity, 900_000);
    assert.equal(receiptsPaymentsBook(db, '2000-01-01', today).totals.receipt, 50_000);
  });
  test('append-only + רישום נגדי מאפס מהמחזור', () => {
    const r = recordOtherIncome(db, { incomeDate: today, kind: 'grant', payer: 'רשות המסים', description: 'מענק', amountAgorot: 20_000 });
    assert.throws(() => db.exec('DELETE FROM other_income'), /FORBIDDEN/);
    reverseOtherIncome(db, r.id, 'נרשם בטעות');
    assert.equal(annualSummary(db, Number(today.slice(0, 4))).turnover, 0);
    assert.equal(verifyOtherIncome(db).ok, true);
  });
});

import { recordOtherIncome, reverseOtherIncome, verifyOtherIncome } from '../src/core/otherIncome.ts';
import { upcomingDeadlines } from '../src/core/books.ts';
import { mkdirSync } from 'node:fs';
function require_mkdir(p: string) { mkdirSync(p, { recursive: true }); }
