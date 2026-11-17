/** טרנזקציה – הכל או כלום. משותף ל-Node ולדפדפן (כל אובייקט עם exec()). */
export function inTransaction<T>(db: { exec(sql: string): unknown }, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
