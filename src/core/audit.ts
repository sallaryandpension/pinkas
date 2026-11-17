import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, nowIso, sha256 } from './util.ts';

/** רושם אירוע ביומן (append-only, משורשר ב-hash). יש לקרוא בתוך הטרנזקציה של הפעולה. */
export function appendAudit(
  db: DatabaseSync,
  action: string,
  entity: string | null,
  entityId: number | null,
  details: Record<string, unknown> = {},
): void {
  const prev = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
  const at = nowIso();
  const prevHash = prev?.hash ?? null;
  const hash = sha256(canonicalJson({ at, action, entity, entityId, details, prevHash }));
  db.prepare(
    'INSERT INTO audit_log (at, action, entity, entity_id, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(at, action, entity, entityId, canonicalJson(details), prevHash, hash);
}

/** בודק את שלמות שרשרת היומן. מחזיר את מזהי הרשומות הפגומות. */
export function verifyAuditChain(db: DatabaseSync): { ok: boolean; brokenIds: number[] } {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as any[];
  const broken: number[] = [];
  let prevHash: string | null = null;
  for (const r of rows) {
    const expected = sha256(canonicalJson({
      at: r.at, action: r.action, entity: r.entity, entityId: r.entity_id,
      details: JSON.parse(r.details), prevHash,
    }));
    if (r.prev_hash !== prevHash || r.hash !== expected) broken.push(r.id);
    prevHash = r.hash;
  }
  return { ok: broken.length === 0, brokenIds: broken };
}
