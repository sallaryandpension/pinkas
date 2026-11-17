/**
 * מתאם ל-sql.js (SQLite ב-WebAssembly) שחושף את אותו ממשק כמו node:sqlite (DatabaseSync):
 * prepare(sql).get/all/run, exec, close. כך כל קוד הליבה רץ בדפדפן בלי שינוי.
 * ה-triggers של "הקובץ הקבוע" (schema.sql) פועלים גם כאן – זה אותו מנוע SQLite.
 */
type SqlJsDatabase = {
  prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): void };
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  export(): Uint8Array;
  close(): void;
};

const norm = (params: unknown[]) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

class Statement {
  #db: SqlJsDatabase; #sql: string;
  constructor(db: SqlJsDatabase, sql: string) { this.#db = db; this.#sql = sql; }
  get(...params: unknown[]) {
    const s = this.#db.prepare(this.#sql);
    try { s.bind(norm(params)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); }
  }
  all(...params: unknown[]) {
    const s = this.#db.prepare(this.#sql);
    const rows: Record<string, unknown>[] = [];
    try { s.bind(norm(params)); while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); }
  }
  run(...params: unknown[]) {
    this.#db.run(this.#sql, norm(params));
    const r = this.#db.exec('SELECT changes() AS c, last_insert_rowid() AS id')[0].values[0];
    return { changes: Number(r[0]), lastInsertRowid: Number(r[1]) };
  }
}

export class BrowserDatabase {
  raw: SqlJsDatabase;
  constructor(raw: SqlJsDatabase) { this.raw = raw; }
  prepare(sql: string) { return new Statement(this.raw, sql); }
  exec(sql: string) { this.raw.exec(sql); }
  close() { this.raw.close(); }
  export() { return this.raw.export(); }
  /** מספר השינויים מאז פתיחת החיבור – לזיהוי מתי לשמור. */
  totalChanges(): number { return Number(this.raw.exec('SELECT total_changes()')[0].values[0][0]); }
}
