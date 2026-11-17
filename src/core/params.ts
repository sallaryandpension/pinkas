/**
 * פרמטרים רגולטוריים מתוארכים. סכומים באגורות.
 * עדכון סכום אינו "שינוי תוכנה" (נספח ה(ג)(2)) – לכן הם מופרדים מהקוד.
 * כל ערך: { from: 'YYYY-MM-DD', value, source }
 */
type Dated<T> = { from: string; value: T; source: string }[];

export const PARAMS = {
  /** תוספת י"א 2(ג)(5): חשבונית לכל שירות בסכום זה ומעלה. ערכי תשע"ה – [לאמת הצמדה]. */
  invoiceRequiredFromAgorot: [
    { from: '2015-01-01', value: 21_000, source: 'הוראות 1973, תוספת י"א 2(ג)(5)' },
  ] as Dated<number>,

  /** חוק לצמצום השימוש במזומן: עסקה מעל התקרה – מזומן עד min(10%, התקרה). */
  cashLimitBusinessAgorot: [
    { from: '2022-08-01', value: 600_000, source: 'חוק לצמצום השימוש במזומן, ס\' 2' },
  ] as Dated<number>,
  cashLimitPercent: [
    { from: '2019-01-01', value: 10, source: 'חוק לצמצום השימוש במזומן, ס\' 2' },
  ] as Dated<number>,

  /** תקרת מחזור לעוסק פטור (חוק מע"מ ס' 1) – [לאמת מול רשות המסים]. */
  exemptDealerCeilingAgorot: [
    { from: '2026-01-01', value: 12_283_300, source: 'notes_C §13 (חוק מע"מ ס\' 1) – לאמת' },
  ] as Dated<number>,
};

export function paramAt<T>(series: Dated<T>, date: string): T {
  const applicable = series.filter((p) => p.from <= date).sort((a, b) => (a.from < b.from ? 1 : -1));
  if (applicable.length === 0) throw new Error(`אין ערך פרמטר בתוקף לתאריך ${date}`);
  return applicable[0].value;
}
