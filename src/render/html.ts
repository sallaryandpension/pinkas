/**
 * רינדור מסמכים ודוחות ל-HTML (להדפסה / PDF).
 * נספח ה(א)(2): בכל פלט – שם הנישום, התקופה, מהות הפלט, תאריך הפקה, מספור עמודים וסימן סיום.
 * נספח ה(א)(3)-(4): "טיוטה" / "מקור" / "העתק".
 */
import { DOC_TYPE_NAMES, type DocType, type DocumentRow, type Line, type Payment } from '../core/documents.ts';
import type { SeriesContinuity } from '../core/reports.ts';
import { formatShekels } from '../core/util.ts';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

const PAYMENT_NAMES: Record<Payment['method'], string> = {
  cash: 'מזומן', cheque: 'שיק', transfer: 'העברה בנקאית', credit_card: 'כרטיס אשראי', app: 'אפליקציית תשלום', other: 'אחר',
};

function paymentDetails(p: Payment): string {
  switch (p.method) {
    case 'cheque': {
      const c = p.cheque;
      let s = `שיק מס' ${c.number}, בנק ${c.bank}, סניף ${c.branch}${c.account ? `, חשבון ${c.account}` : ''}, לפירעון ${fmtDate(c.dueDate)}`;
      if (c.endorser) s += ` (הוסב ע"י ${c.endorser.name}, ת"ז ${c.endorser.idNumber})`;
      return s;
    }
    case 'transfer': return [p.transfer.bank && `בנק ${p.transfer.bank}`, p.transfer.reference && `אסמכתה ${p.transfer.reference}`].filter(Boolean).join(', ');
    case 'credit_card': return `כרטיס המסתיים ב-${p.card.last4}${p.card.approval ? `, אישור ${p.card.approval}` : ''}${p.card.installments && p.card.installments > 1 ? `, ${p.card.installments} תשלומים` : ''}`;
    case 'app': return `${p.app.name}${p.app.reference ? `, אסמכתה ${p.app.reference}` : ''}`;
    case 'other': return p.other.description;
    default: return '';
  }
}

const BASE_CSS = `
  @page { size: A4; margin: 16mm 14mm 20mm;
    @bottom-center { content: "עמוד " counter(page) " מתוך " counter(pages); font: 9pt Arial, sans-serif; color: #555; } }
  * { box-sizing: border-box; }
  body { direction: rtl; font-family: Arial, "Segoe UI", sans-serif; font-size: 10.5pt; color: #111; margin: 0; }
  h1 { font-size: 17pt; margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #999; padding: 5px 7px; text-align: right; vertical-align: top; }
  th { background: #eee; font-weight: bold; }
  td.num, th.num { text-align: left; direction: ltr; white-space: nowrap; }
  .muted { color: #555; }
  .end { text-align: center; margin-top: 18px; font-weight: bold; }
`;

type Label = 'מקור' | 'העתק' | 'טיוטה';

export type DraftLike = Pick<DocumentRow, 'doc_type' | 'issue_date' | 'customer_snapshot' | 'business_snapshot' | 'body' | 'total_agorot'>
  & Partial<Pick<DocumentRow, 'number' | 'status' | 'cancel_reason' | 'created_at'>>;

/** HTML של מסמך. relatedDocs – לתצוגת "מתייחס לחשבונית מס' X מיום Y". */
export function renderDocument(doc: DraftLike, label: Label, relatedDocs: DocumentRow[] = []): string {
  const business = JSON.parse(doc.business_snapshot);
  const customer = JSON.parse(doc.customer_snapshot) ?? {};
  const body = JSON.parse(doc.body);
  const lines: Line[] = body.lines ?? [];
  const payments: Payment[] = body.payments ?? [];
  const t = doc.doc_type as DocType;
  const title = DOC_TYPE_NAMES[t];
  const numberText = label === 'טיוטה' ? 'ללא מספר' : `מס' ${doc.number}`;
  const isCancelled = doc.status === 'cancelled';

  const linesTable = lines.length ? `
    <table>
      <thead><tr><th style="width:46%">תיאור השירות</th><th>יחידה</th><th class="num">כמות</th><th class="num">מחיר ליחידה</th><th class="num">סה"כ</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.unit)}</td>
        <td class="num">${esc(l.quantity)}</td><td class="num">${formatShekels(l.unitPriceAgorot)}</td>
        <td class="num">${formatShekels(Math.round(l.quantity * l.unitPriceAgorot))}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const withholding = body.withholdingAgorot ?? 0;
  const paymentsTable = payments.length ? `
    <h3 style="margin:14px 0 0;font-size:11.5pt">פרטי התקבול</h3>
    <table>
      <thead><tr><th>אמצעי תשלום</th><th>פרטים</th><th>תאריך</th><th class="num">סכום</th></tr></thead>
      <tbody>${payments.map((p) => `<tr><td>${PAYMENT_NAMES[p.method]}</td><td>${esc(paymentDetails(p))}</td>
        <td>${fmtDate(p.date)}</td><td class="num">${formatShekels(p.amountAgorot)}</td></tr>`).join('')}
        ${withholding ? `<tr><td colspan="3">ניכוי במקור</td><td class="num">${formatShekels(withholding)}</td></tr>` : ''}
      </tbody>
    </table>` : '';

  const related = relatedDocs.length
    ? `<p><b>${t === 'credit' ? 'מתייחסת ל' : 'בהתייחס ל'}:</b> ${relatedDocs.map((r) =>
        `${esc(DOC_TYPE_NAMES[r.doc_type])} מס' ${r.number} מיום ${fmtDate(r.issue_date)}`).join('; ')}</p>` : '';

  const totalLabel = t === 'receipt' ? 'סה"כ התקבל' : t === 'credit' ? 'סה"כ זיכוי' : t === 'order' ? 'סה"כ משוער' : 'סה"כ לתשלום';
  const watermark = label === 'טיוטה' || isCancelled
    ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:90pt;color:rgba(200,0,0,.13);transform:rotate(-25deg);font-weight:bold">${isCancelled ? 'מבוטל' : 'טיוטה'}</div>` : '';

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)} ${esc(numberText)}</title>
  <style>${BASE_CSS}
    .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #222; padding-bottom:8px; }
    .label { border:2.5px solid #222; padding:4px 18px; font-size:20pt; font-weight:bold; }
    .label.copy { color:#555; border-color:#777; } .label.draft { color:#b00; border-color:#b00; }
    .doctitle { margin:14px 0 6px; display:flex; justify-content:space-between; align-items:baseline; }
    .total { margin-top:10px; font-size:13pt; font-weight:bold; text-align:left; }
    .paid { display:inline-block; border:2px solid #0a6; color:#0a6; padding:2px 14px; font-weight:bold; font-size:14pt; transform:rotate(-4deg); }
    .sign { margin-top:36px; display:flex; justify-content:space-between; }
  </style></head><body>${watermark}
  <div class="head">
    <div>
      <h1>${esc(business.name)}</h1>
      <div>עוסק פטור מס' ${esc(business.idNumber)}</div>
      <div>${esc(business.address)}</div>
      ${business.phone ? `<div>טל' ${esc(business.phone)}</div>` : ''}${business.email ? `<div>${esc(business.email)}</div>` : ''}
    </div>
    <div class="label ${label === 'העתק' ? 'copy' : label === 'טיוטה' ? 'draft' : ''}">${label}</div>
  </div>
  <div class="doctitle"><h1>${esc(title)} ${esc(numberText)}</h1><div>תאריך: <b>${fmtDate(doc.issue_date)}</b></div></div>
  ${isCancelled ? `<p style="color:#b00"><b>מסמך מבוטל.</b> סיבה: ${esc(doc.cancel_reason)}</p>` : ''}
  <p><b>${t === 'receipt' ? 'התקבל מאת' : 'לכבוד'}:</b> ${esc(customer.name)}
    ${customer.idNumber ? ` | מזהה: ${esc(customer.idNumber)}` : ''}${customer.address ? ` | ${esc(customer.address)}` : ''}</p>
  ${body.description ? `<p><b>${t === 'receipt' ? 'עבור' : 'תיאור'}:</b> ${esc(body.description)}</p>` : ''}
  ${related}
  ${t === 'credit' ? `<p><b>סיבת הזיכוי:</b> ${esc(body.reason)}</p>` : ''}
  ${linesTable}
  <div class="total">${totalLabel}: ${formatShekels(doc.total_agorot)}</div>
  ${paymentsTable}
  ${t === 'invoice_receipt' ? '<p style="margin-top:14px"><span class="paid">נפרע</span></p>' : ''}
  <p class="muted" style="margin-top:14px">עוסק פטור – המסמך אינו חשבונית מס ואינו כולל מע"מ.</p>
  ${body.notes ? `<p class="muted">הערות: ${esc(body.notes)}</p>` : ''}
  ${t === 'receipt' || t === 'invoice_receipt' || t === 'credit'
    ? `<div class="sign"><div>חתימת ${t === 'credit' ? 'העוסק' : 'המקבל'}: ____________________</div>${t === 'credit' ? '<div>אישור קבלה ע"י הלקוח: ____________________</div>' : ''}</div>` : ''}
  </body></html>`;
}

/** מעטפת לדוח: כותרת חובה (נספח ה(א)(2)) + סימן סיום. */
export function renderReport(opts: { businessName: string; title: string; period: string; producedAt: string; bodyHtml: string }): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
  <style>${BASE_CSS} .rh { border-bottom:2px solid #222; padding-bottom:6px; margin-bottom:10px; } .rh div { margin:2px 0; }</style></head><body>
  <div class="rh">
    <h1>${esc(opts.title)}</h1>
    <div><b>שם הנישום:</b> ${esc(opts.businessName)}</div>
    <div><b>התקופה:</b> ${esc(opts.period)}</div>
    <div><b>תאריך הפקת הדוח:</b> ${fmtDateTime(opts.producedAt)}</div>
  </div>
  ${opts.bodyHtml}
  <div class="end">*** סוף הדוח ***</div>
  </body></html>`;
}

export function continuityBody(rows: SeriesContinuity[]): string {
  return `<table><thead><tr><th>סוג מסמך</th><th class="num">ממספר</th><th class="num">עד מספר</th><th class="num">כמות</th>
    <th>מספרים חסרים</th><th>מבוטלים</th><th>שלמות תוכן</th><th>תקין</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.count ? r.startNumber : '-'}</td><td class="num">${r.lastNumber ?? '-'}</td>
      <td class="num">${r.count}</td><td>${r.missingNumbers.length ? r.missingNumbers.join(', ') : 'אין'}</td>
      <td>${r.cancelledNumbers.length ? r.cancelledNumbers.join(', ') : 'אין'}</td>
      <td>${r.hashErrors.length ? `<b style="color:#b00">שגיאה במסמכים ${r.hashErrors.join(', ')}</b>` : 'תקינה'}</td>
      <td>${r.ok ? '✔' : '<b style="color:#b00">✘</b>'}</td></tr>`).join('')}
    </tbody></table>`;
}

/** יומן רשומות (נספח ה(א)(1)): כל רשומות הקובץ הקבוע לפי סדר רישומן, עם המספר העוקב. */
export function journalBody(docs: DocumentRow[]): string {
  return `<table><thead><tr><th class="num">#</th><th>סוג</th><th class="num">מספר</th><th>תאריך</th><th>לקוח</th>
    <th class="num">סכום</th><th>סטטוס</th><th>מקור הופק</th></tr></thead><tbody>
    ${docs.map((d) => `<tr><td class="num">${d.id}</td><td>${esc(DOC_TYPE_NAMES[d.doc_type])}</td><td class="num">${d.number}</td>
      <td>${fmtDate(d.issue_date)}</td><td>${esc(JSON.parse(d.customer_snapshot)?.name)}</td>
      <td class="num">${formatShekels(d.total_agorot)}</td><td>${d.status === 'cancelled' ? 'מבוטל' : 'הופק'}</td>
      <td>${d.original_produced_at ? fmtDate(d.original_produced_at) : '-'}</td></tr>`).join('')}
    </tbody></table>`;
}

type BookRowLike = { date: string; ref: string; name: string; description: string; receipt: number; withholding: number; payment: number; asset: number; deposit: number };
const cell = (v: number) => (v ? formatShekels(v) : '');

/** ספר תקבולים ותשלומים (הוראה 12), עם סיכום חודשי. */
export function bookBody(rows: BookRowLike[], totals: Omit<BookRowLike, 'date' | 'ref' | 'name' | 'description'>): string {
  const months = new Map<string, BookRowLike[]>();
  for (const r of rows) { const k = r.date.slice(0, 7); months.set(k, [...(months.get(k) ?? []), r]); }
  const head = `<tr><th>תאריך</th><th>אסמכתה</th><th>לקוח / ספק</th><th>פרטים</th><th class="num">תקבולים</th>
    <th class="num">מזה ניכוי במקור</th><th class="num">תשלומים</th><th class="num">רכישת נכסים</th><th class="num">פיקדונות</th></tr>`;
  const sumRow = (label: string, rs: BookRowLike[]) => {
    const s = (k: keyof typeof totals) => rs.reduce((a, r) => a + r[k], 0);
    return `<tr><th colspan="4">${label}</th><th class="num">${cell(s('receipt'))}</th><th class="num">${cell(s('withholding'))}</th>
      <th class="num">${cell(s('payment'))}</th><th class="num">${cell(s('asset'))}</th><th class="num">${cell(s('deposit'))}</th></tr>`;
  };
  let body = '';
  for (const [month, rs] of months) {
    body += rs.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.ref)}</td><td>${esc(r.name)}</td><td>${esc(r.description)}</td>
      <td class="num">${cell(r.receipt)}</td><td class="num">${cell(r.withholding)}</td><td class="num">${cell(r.payment)}</td>
      <td class="num">${cell(r.asset)}</td><td class="num">${cell(r.deposit)}</td></tr>`).join('');
    body += sumRow(`סה"כ ${month.slice(5)}/${month.slice(0, 4)}`, rs);
  }
  if (!rows.length) return '<p>אין תקבולים או תשלומים בתקופה.</p>';
  return `<table style="font-size:9pt"><thead>${head}</thead><tbody>${body}
    <tr><th colspan="4">סה"כ לתקופה</th><th class="num">${cell(totals.receipt)}</th><th class="num">${cell(totals.withholding)}</th>
    <th class="num">${cell(totals.payment)}</th><th class="num">${cell(totals.asset)}</th><th class="num">${cell(totals.deposit)}</th></tr></tbody></table>`;
}

export function annualSummaryBody(s: {
  year: number; receipts: number; withholding: number; invoicedNet: number; expensesRegular: number; assets: number; deposits: number;
  byCategory: { category: string; total: number }[]; assetList: { expense_date: string; supplier_name: string; description: string; amount_agorot: number }[];
  netBeforeAdjustments: number;
}): string {
  return `<table><tbody>
    <tr><td>תקבולים (ברוטו, כולל ניכוי במקור)</td><td class="num">${formatShekels(s.receipts)}</td></tr>
    <tr><td>מזה ניכוי במקור (ניתן לקיזוז מהמס)</td><td class="num">${formatShekels(s.withholding)}</td></tr>
    <tr><td>חשבוניות שהוצאו (נטו אחרי זיכויים)</td><td class="num">${formatShekels(s.invoicedNet)}</td></tr>
    <tr><td>הוצאות שוטפות</td><td class="num">${formatShekels(s.expensesRegular)}</td></tr>
    <tr><th>הפרש תקבולים פחות הוצאות שוטפות</th><th class="num">${formatShekels(s.netBeforeAdjustments)}</th></tr>
  </tbody></table>
  <h3>הוצאות שוטפות לפי קטגוריה</h3>
  ${s.byCategory.length ? `<table><tbody>${s.byCategory.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${formatShekels(c.total)}</td></tr>`).join('')}</tbody></table>` : '<p>אין.</p>'}
  <h3>רכישת נכסים (פחת – לא נכלל בהוצאות השוטפות)</h3>
  ${s.assetList.length ? `<table><tbody>${s.assetList.map((a) => `<tr><td>${fmtDate(a.expense_date)}</td><td>${esc(a.supplier_name)}</td><td>${esc(a.description)}</td><td class="num">${formatShekels(a.amount_agorot)}</td></tr>`).join('')}</tbody></table>` : '<p>אין.</p>'}
  <p class="muted" style="margin-top:14px">הסיכום מבוסס על רישומי פנקס בלבד ואינו חישוב מס. הכרה בהוצאות, פחת על נכסים ובסיס הדיווח – לפי כללי מס הכנסה; מומלץ לבדוק מול מקור מוסמך.</p>`;
}

export function balancesBody(rows: { name: string; balance: number }[]): string {
  if (!rows.length) return '<p>אין יתרות פתוחות.</p>';
  return `<table><thead><tr><th>לקוח</th><th class="num">יתרה (חוב הלקוח)</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${formatShekels(r.balance)}</td></tr>`).join('')}
    <tr><th>סה"כ</th><th class="num">${formatShekels(rows.reduce((s, r) => s + r.balance, 0))}</th></tr></tbody></table>`;
}
