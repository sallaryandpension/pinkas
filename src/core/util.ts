import { createHash } from 'node:crypto';

/** תאריך היום לפי שעון ישראל, YYYY-MM-DD. */
export function todayIL(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** JSON קנוני (מפתחות ממוינים) – לחישוב hash יציב. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** שקלים (מספר או מחרוזת "1,234.50") → אגורות שלמות. */
export function toAgorot(shekels: number | string): number {
  const n = typeof shekels === 'string' ? Number(shekels.replace(/[,₪\s]/g, '')) : shekels;
  if (!Number.isFinite(n)) throw new Error(`סכום לא תקין: ${shekels}`);
  return Math.round(n * 100);
}

/** אגורות → "1,234.50 ₪" */
export function formatShekels(agorot: number): string {
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(agorot);
  const s = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${s} ₪`;
}

export const isIsoDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
