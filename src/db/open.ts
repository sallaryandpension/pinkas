import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** פותח (או יוצר) את מסד הנתונים ומחיל את הסכמה. path=':memory:' לבדיקות. */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');   // עמידות בקריסה / הפסקת חשמל (נספח ה(ב))
    db.exec('PRAGMA synchronous = FULL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export { inTransaction } from './tx.ts';
