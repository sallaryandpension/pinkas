import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/open.ts';
import { setBusinessProfile, createCustomer } from '../src/core/entities.ts';
import { issueDocument, produceOutput } from '../src/core/documents.ts';
import { createBackup, verifyBackup, backupStatus, openBackupDb, dailyLocalBackup } from '../src/core/backup.ts';
import { todayIL } from '../src/core/util.ts';

let root: string, dataDir: string, target: string, db: DatabaseSync;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pinkas-bk-'));
  dataDir = join(root, 'data'); target = join(root, 'usb');
  mkdirSync(join(dataDir, 'outputs'), { recursive: true }); mkdirSync(target);
  db = openDb(join(dataDir, 'pinkas.db'));
  setBusinessProfile(db, { name: 'עסק', idNumber: '123456782', address: 'כתובת 1', status: 'exempt' });
  const c = createCustomer(db, { name: 'לקוח', address: 'כתובת' }).id;
  for (let i = 0; i < 3; i++) {
    const { document } = issueDocument(db, { type: 'invoice_receipt', customerId: c,
      lines: [{ description: 'שירות', quantity: 1, unit: 'יחידה', unitPriceAgorot: 30_000 }],
      payments: [{ method: 'transfer', amountAgorot: 30_000, date: todayIL(), transfer: {} }] });
    produceOutput(db, document.id, 'original');
  }
  writeFileSync(join(dataDir, 'outputs', 'invoice_receipt-1-original.pdf'), '%PDF-fake');
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('גיבוי (הוראה 25(ו))', () => {
  test('גיבוי נוצר, מכיל את כל המסמכים והקבצים, ומאומת', () => {
    const { dir, verify } = createBackup(db, { dataDir, targetDir: target, kind: 'local' });
    assert.equal(verify.ok, true, verify.problems.join('; '));
    assert.equal(verify.docCount, 3);
    assert.ok(readdirSync(join(dir, 'outputs')).includes('invoice_receipt-1-original.pdf'));
    const bdb = openBackupDb(dir);
    assert.equal((bdb.prepare('SELECT COUNT(*) c FROM documents').get() as any).c, 3);
    bdb.close();
  });

  test('אפשר להפיק פלט מהגיבוי, והגיבוי פתוח לקריאה בלבד', () => {
    const { dir } = createBackup(db, { dataDir, targetDir: target, kind: 'local' });
    const bdb = openBackupDb(dir);
    assert.throws(() => bdb.exec("INSERT INTO meta VALUES ('x','y')"), /readonly/i);
    bdb.close();
  });

  test('שינוי בקובץ בתוך הגיבוי מתגלה בבדיקה', () => {
    const { dir } = createBackup(db, { dataDir, targetDir: target, kind: 'local' });
    appendFileSync(join(dir, 'outputs', 'invoice_receipt-1-original.pdf'), 'x');
    const v = verifyBackup(dir);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(), /שונה מאז הגיבוי/);
  });

  test('גיבוי "חיצוני" לאותו כונן של הנתונים – נחסם', () => {
    assert.throws(() => createBackup(db, { dataDir, targetDir: target, kind: 'external' }), /מקום נפרד/);
  });

  test('יומן הגיבויים append-only', () => {
    createBackup(db, { dataDir, targetDir: target, kind: 'local' });
    assert.throws(() => db.exec('DELETE FROM backups_log'), /FORBIDDEN/);
  });

  test('גיבוי יומי מקומי – פעם אחת ביום', () => {
    assert.ok(dailyLocalBackup(db, dataDir));
    assert.equal(dailyLocalBackup(db, dataDir), null);
  });

  test('מצב רבעוני: שבוע ראשון = "due", אחריו = "overdue"', () => {
    assert.equal(backupStatus(db, '2026-10-03').state, 'due');
    assert.equal(backupStatus(db, '2026-10-03').quarter, 4);
    assert.equal(backupStatus(db, '2026-11-17').state, 'overdue');
    assert.equal(backupStatus(db, '2026-01-07').inFirstWeek, true);
    assert.equal(backupStatus(db, '2026-01-08').inFirstWeek, false);
  });
});
