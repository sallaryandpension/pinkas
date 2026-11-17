/**
 * גיבוי ושחזור – הוראה 25(ו):
 *  (2) "בשבוע הראשון בכל רבעון... ייערך גיבוי", שיישמר "במקום ... השונה מהמקום שבו מוחזקת מערכת החשבונות",
 *      בישראל או באזור בלבד.
 *  (3) "תתאפשר הפקה זמינה של פלט מודפס ופלט חזותי ... וכן מהגיבוי".
 * נספח ה(א)(6): "גיבוי יזום".
 *
 * גיבוי = תיקייה pinkas-backup-<תאריך>: pinkas.db (snapshot עקבי דרך VACUUM INTO),
 * outputs/ (קובצי המקור שהופקו), manifest.json (hash לכל קובץ + נתוני בקרה).
 */
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inTransaction } from '../db/open.ts';
import { appendAudit, verifyAuditChain } from './audit.ts';
import { continuityReport } from './reports.ts';
import { verifyExpenses } from './expenses.ts';
import { verifyOtherIncome } from './otherIncome.ts';
import { todayIL } from './util.ts';

export type BackupKind = 'external' | 'local';
export type Manifest = {
  app: 'pinkas'; formatVersion: 1; createdAt: string; kind: BackupKind;
  docCount: number; lastNumbers: Record<string, number | null>;
  files: { path: string; size: number; sha256: string }[];
};
export type VerifyResult = { ok: boolean; problems: string[]; docCount: number; manifest: Manifest | null };

const fileHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

function stampIL(d = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

/** יוצר גיבוי ומאמת אותו מיד. */
export function createBackup(db: DatabaseSync, opts: { dataDir: string; targetDir: string; kind: BackupKind }):
  { dir: string; verify: VerifyResult } {
  const target = resolve(opts.targetDir);
  if (!existsSync(target)) throw new Error(`תיקיית היעד לא קיימת: ${target}`);
  if (opts.kind === 'external' && resolve(opts.dataDir).slice(0, 2).toLowerCase() === target.slice(0, 2).toLowerCase())
    throw new Error('גיבוי רבעוני חייב להיות במקום נפרד (הוראה 25(ו)(2)) – בחר כונן אחר, למשל כונן חיצוני');

  let dir = join(target, `pinkas-backup-${stampIL()}`);
  for (let i = 2; existsSync(dir); i++) dir = join(target, `pinkas-backup-${stampIL()}-${i}`);
  mkdirSync(dir, { recursive: true });

  // snapshot עקבי של המסד (כולל כל מה שב-WAL)
  db.exec(`VACUUM INTO '${join(dir, 'pinkas.db').replaceAll("'", "''")}'`);
  for (const sub of ['outputs', 'attachments']) {   // מקורות שהופקו + מסמכי ספקים מצורפים
    const src = join(opts.dataDir, sub);
    if (existsSync(src)) cpSync(src, join(dir, sub), { recursive: true });
  }

  const series = continuityReport(db);
  const manifest: Manifest = {
    app: 'pinkas', formatVersion: 1, createdAt: new Date().toISOString(), kind: opts.kind,
    docCount: series.reduce((s, x) => s + x.count, 0),
    lastNumbers: Object.fromEntries(series.map((s) => [s.docType, s.lastNumber])),
    files: listFiles(dir).map((f) => ({ path: relative(dir, f).replaceAll('\\', '/'), size: statSync(f).size, sha256: fileHash(f) })),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const verify = verifyBackup(dir);
  inTransaction(db, () => {
    db.prepare('INSERT INTO backups_log (at, kind, path, doc_count, verified_ok, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(manifest.createdAt, opts.kind, dir, manifest.docCount, verify.ok ? 1 : 0, JSON.stringify({ problems: verify.problems }));
    appendAudit(db, 'backup.create', 'backup', null, { kind: opts.kind, path: dir, ok: verify.ok });
  });
  return { dir, verify };
}

/** פותח גיבוי לקריאה בלבד ובודק: hash של כל קובץ, שלמות המסד, רצף מספרים, שרשרת ה-hash, ספירת מסמכים. */
export function verifyBackup(dir: string): VerifyResult {
  const problems: string[] = [];
  const mPath = join(dir, 'manifest.json');
  if (!existsSync(mPath)) return { ok: false, problems: ['חסר manifest.json – זה לא גיבוי של פנקס'], docCount: 0, manifest: null };
  let manifest: Manifest;
  try { manifest = JSON.parse(readFileSync(mPath, 'utf8')); } catch { return { ok: false, problems: ['manifest.json פגום'], docCount: 0, manifest: null }; }

  for (const f of manifest.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) problems.push(`קובץ חסר: ${f.path}`);
    else if (fileHash(p) !== f.sha256) problems.push(`קובץ שונה מאז הגיבוי: ${f.path}`);
  }

  let docCount = 0;
  const dbPath = join(dir, 'pinkas.db');
  if (!existsSync(dbPath)) problems.push('קובץ המסד חסר');
  else {
    const bdb = openBackupDb(dir);
    try {
      const ic = bdb.prepare('PRAGMA integrity_check').get() as Record<string, string>;
      if (Object.values(ic)[0] !== 'ok') problems.push(`בדיקת שלמות המסד נכשלה: ${Object.values(ic)[0]}`);
      const series = continuityReport(bdb);
      docCount = series.reduce((s, x) => s + x.count, 0);
      for (const s of series) if (!s.ok) problems.push(`רצף/תוכן לא תקין בסדרה ${s.name}`);
      if (!verifyAuditChain(bdb).ok) problems.push('יומן האירועים בגיבוי פגום');
      const hasExpenses = bdb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expenses'").get();
      if (hasExpenses && !verifyExpenses(bdb).ok) problems.push('רישומי ההוצאות בגיבוי פגומים');
      const hasOther = bdb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'other_income'").get();
      if (hasOther && !verifyOtherIncome(bdb).ok) problems.push('רישומי ההכנסות הנוספות בגיבוי פגומים');
      if (docCount !== manifest.docCount) problems.push(`מספר המסמכים (${docCount}) שונה מהרשום ב-manifest (${manifest.docCount})`);
    } finally { bdb.close(); }
  }
  return { ok: problems.length === 0, problems, docCount, manifest };
}

/** פתיחת מסד הגיבוי לקריאה בלבד – להפקת פלט מהגיבוי (25(ו)(3)). */
export function openBackupDb(dir: string): DatabaseSync {
  return new DatabaseSync(join(dir, 'pinkas.db'), { readOnly: true });
}

/** מצב הגיבוי הרבעוני. */
export function backupStatus(db: DatabaseSync, today = todayIL()) {
  const [y, m, d] = today.split('-').map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const quarterStart = `${y}-${String(qStartMonth).padStart(2, '0')}-01`;
  const dayInQuarter = Math.round((Date.parse(today) - Date.parse(quarterStart)) / 86_400_000) + 1;
  const last = (kind: BackupKind) => db.prepare(
    'SELECT at, path, doc_count, verified_ok FROM backups_log WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as any;
  const lastExternal = last('external') ?? null;
  const externalThisQuarter = db.prepare(
    "SELECT COUNT(*) c FROM backups_log WHERE kind = 'external' AND verified_ok = 1 AND at >= ?").get(quarterStart) as { c: number };
  const target = (db.prepare("SELECT value FROM meta WHERE key = 'backup_target'").get() as { value: string } | undefined)?.value ?? null;
  const quarterDone = externalThisQuarter.c > 0;
  return {
    quarterStart, quarter: Math.floor((m - 1) / 3) + 1, year: y, dayInQuarter, inFirstWeek: dayInQuarter <= 7,
    quarterDone, lastExternal, lastLocal: last('local') ?? null, target,
    targetAvailable: target ? existsSync(target) : false,
    // "due" = עכשיו השבוע הראשון ועדיין לא גובה; "overdue" = עבר השבוע הראשון בלי גיבוי
    state: quarterDone ? 'ok' : dayInQuarter <= 7 ? 'due' : 'overdue',
  };
}

export function setBackupTarget(db: DatabaseSync, target: string): void {
  const t = resolve(target);
  if (!existsSync(t)) throw new Error(`התיקייה לא קיימת: ${t}`);
  inTransaction(db, () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('backup_target', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(t);
    appendAudit(db, 'backup.target', 'backup', null, { target: t });
  });
}

/** גיבוי מקומי אוטומטי – פעם ביום; שומר את 14 האחרונים. (אינו מחליף את הגיבוי הרבעוני החיצוני.) */
export function dailyLocalBackup(db: DatabaseSync, dataDir: string): string | null {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const today = todayIL();
  const existing = readdirSync(dir).filter((n) => n.startsWith('pinkas-backup-')).sort();
  if (existing.some((n) => n.startsWith(`pinkas-backup-${today}`))) return null;
  const { dir: created } = createBackup(db, { dataDir, targetDir: dir, kind: 'local' });
  const all = readdirSync(dir).filter((n) => n.startsWith('pinkas-backup-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) rmSync(join(dir, old), { recursive: true, force: true });
  return created;
}

/** כוננים זמינים (להצעה בממשק). */
export function availableDrives(): string[] {
  return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((p) => { try { return existsSync(p); } catch { return false; } });
}
