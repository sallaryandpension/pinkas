/** מצב הגיבוי הרבעוני (הוראה 25(ו)(2)) – חישוב משותף ל-Node ולדפדפן. */
import type { DatabaseSync } from 'node:sqlite';
import { todayIL } from './util.ts';

export type BackupKind = 'external' | 'local';

export function quarterlyBackupStatus(db: DatabaseSync, today = todayIL()) {
  const [y, m] = today.split('-').map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const quarterStart = `${y}-${String(qStartMonth).padStart(2, '0')}-01`;
  const dayInQuarter = Math.round((Date.parse(today) - Date.parse(quarterStart)) / 86_400_000) + 1;
  const last = (kind: BackupKind) => (db.prepare(
    'SELECT at, path, doc_count, verified_ok FROM backups_log WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as any) ?? null;
  const externalThisQuarter = db.prepare(
    "SELECT COUNT(*) c FROM backups_log WHERE kind = 'external' AND verified_ok = 1 AND at >= ?").get(quarterStart) as { c: number };
  const quarterDone = externalThisQuarter.c > 0;
  return {
    quarterStart, quarter: Math.floor((m - 1) / 3) + 1, year: y, dayInQuarter, inFirstWeek: dayInQuarter <= 7,
    quarterDone, lastExternal: last('external'), lastLocal: last('local'),
    // "due" = עכשיו השבוע הראשון ועדיין לא גובה; "overdue" = עבר השבוע הראשון בלי גיבוי
    state: quarterDone ? 'ok' : dayInQuarter <= 7 ? 'due' : 'overdue',
  };
}
