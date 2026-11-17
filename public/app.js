// פנקס – ממשק משתמש (Vanilla JS). כל הסכומים בשרת באגורות; בממשק בשקלים.
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shekels = (ag) => (ag / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₪';
const toAg = (v) => Math.round(Number(String(v).replace(/[,₪\s]/g, '')) * 100);
const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

const TYPES = { order: 'הזמנה', invoice: 'חשבונית עסקה', invoice_receipt: 'חשבונית עסקה/קבלה', receipt: 'קבלה', credit: 'הודעת זיכוי' };
const METHODS = { transfer: 'העברה בנקאית', cash: 'מזומן', cheque: 'שיק', credit_card: 'כרטיס אשראי', app: 'אפליקציה (Bit/PayBox)', other: 'אחר' };

// גרסת הדפדפן (GitHub Pages): כל ה-API רץ מקומית בדפדפן דרך window.pinkasLocal.
const LOCAL = () => window.pinkasLocal;

async function api(path, opts = {}) {
  if (LOCAL()) return LOCAL().api(path, opts);
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Pinkas': '1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/pdf')) {
    if (!res.ok) throw new Error('יצירת PDF נכשלה');
    return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] };
  }
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data?.error ?? 'שגיאה'); Object.assign(e, data, { status: res.status }); throw e; }
  return data;
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }

function dialog(html, buttons) {
  return new Promise((resolve) => {
    const d = $('#dialog'); const f = $('#dialog-form');
    f.innerHTML = `${html}<div class="actions">${buttons.map((b, i) => `<button type="button" class="btn ${b.cls ?? ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
    let done = false;
    const finish = (value) => { if (done) return; done = true; if (d.open) d.close(); resolve(value); };
    f.querySelectorAll('button[data-i]').forEach((btn) => (btn.onclick = () => finish(buttons[Number(btn.dataset.i)].value)));
    f.onsubmit = (e) => { e.preventDefault(); finish(buttons[0].value); };   // Enter = הכפתור הראשי
    d.oncancel = () => finish(null);                                            // Esc
    d.showModal();
  });
}

function download(result) {
  if (result.printable) return LOCAL().print(result.printable.html, result.printable.filename);   // דפדפן: חלון הדפסה → "שמירה כ-PDF"
  const { blob, filename } = result;
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename ?? 'pinkas.pdf'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const openPdfGet = (url) => (LOCAL() ? api(url).then(download).catch((e) => toast(e.message)) : window.open(url, '_blank'));

function errorBox(e) {
  const list = [...(e.errors ?? []), ...(e.warnings ?? [])];
  return `<div class="msg err">${esc(e.message)}${list.length > 1 ? `<ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
}

// ---------------------------------------------------------------- ניווט
const views = { dashboard, new: newDocument, documents, expenses, customers, reports, backup, settings };
let current = 'dashboard';
async function go(view, arg) {
  current = view;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  app.innerHTML = '<p class="muted">טוען…</p>';
  try { await views[view](arg); } catch (e) { app.innerHTML = errorBox(e); }
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

// ---------------------------------------------------------------- לוח
async function dashboard() {
  const business = await api('/api/business');
  if (!business) { await go('settings', { first: true }); return; }
  const d = await api('/api/dashboard');
  const b = d.backup;
  const backupAlert = b.state === 'ok' ? ''
    : `<div class="msg ${b.state === 'overdue' ? 'err' : 'warn'}"><b>${b.state === 'overdue' ? 'לא בוצע גיבוי רבעוני' : 'השבוע מגבים!'}</b> –
       רבעון ${b.quarter}/${b.year}: יש לבצע גיבוי לכונן נפרד ${b.state === 'overdue' ? '(היה צריך בשבוע הראשון של הרבעון)' : '(השבוע הראשון ברבעון)'}.
       <button class="btn small" id="go-backup">לגיבוי</button></div>`;
  app.innerHTML = `${backupAlert}<h2>שלום, ${esc(business.name)}</h2>
    <div class="grid">
      <div class="card"><div class="muted">תקבולים ${d.year}</div><div class="stat">${shekels(d.incomeAgorot)}</div></div>
      <div class="card"><div class="muted">מסמכים שטרם הופק להם מקור</div><div class="stat">${d.originalsPending}</div></div>
      <div class="card"><div class="muted">רציפות מספרים ושלמות רישומים</div><div class="stat">${d.continuityOk ? '<span class="tag ok">תקינה</span>' : '<span class="tag bad">יש בעיה</span>'}</div></div>
      <div class="card"><div class="muted">מחזור ${d.ceiling.year} מול תקרת עוסק פטור</div>
        <div class="stat">${d.ceiling.percent}%</div>
        <div style="height:8px;background:#eef1f5;border-radius:6px;margin:6px 0"><div style="height:8px;border-radius:6px;width:${Math.min(100, d.ceiling.percent)}%;background:${d.ceiling.percent >= 95 ? 'var(--bad)' : d.ceiling.percent >= 80 ? 'var(--warn)' : 'var(--ok)'}"></div></div>
        <div class="muted" style="font-size:12px">${shekels(d.ceiling.turnover)} מתוך ${shekels(d.ceiling.ceiling)}${d.ceiling.percent >= 80 ? ' – <b>מתקרב לתקרה: מעבר לעוסק מורשה</b>' : ''}</div></div>
    </div>
    <div class="actions">
      <button class="btn primary" data-new="invoice_receipt">+ חשבונית עסקה/קבלה</button>
      <button class="btn" data-new="invoice">+ חשבונית עסקה</button>
      <button class="btn" data-new="receipt">+ קבלה</button>
      <button class="btn" data-new="order">+ הזמנה</button>
    </div>
    <div class="card" style="margin-top:16px"><b>מועדי דיווח קרובים</b>
      <table style="margin-top:6px"><tbody>${d.deadlines.map((x) => {
        const days = Math.round((Date.parse(x.date) - Date.parse(today())) / 86400000);
        return `<tr><td style="white-space:nowrap">${fmtDate(x.date)}</td><td><b>${esc(x.title)}</b> <span class="muted">– ${esc(x.detail)}</span></td>
          <td>${days <= 14 ? `<span class="tag ${days <= 7 ? 'bad' : 'warn'}">בעוד ${days} ימים</span>` : `<span class="muted">בעוד ${days} ימים</span>`}</td>
          <td><a href="${esc(x.url)}" target="_blank" rel="noopener">לאתר</a></td></tr>`;
      }).join('')}</tbody></table>
      <p class="muted" style="margin:6px 0 0">בהנחה שאתה "בעל עסק זעיר". הפירוט: חובות_דיווח_שנתיות_עוסק_פטור.md</p></div>
    <div class="card"><b>תזכורות</b><ul class="muted">
      <li>גיבוי בשבוע הראשון של כל רבעון, למקום נפרד בישראל (הוראה 25(ו)).</li>
      <li>לשירות מ-210 ₪ נדרשת חשבונית – בדרך כלל "חשבונית עסקה/קבלה".</li>
      <li>את ה"מקור" מדפיסים פעם אחת, חותמים ביד ושולחים/מוסרים ללקוח. במייל – רק "העתק".</li></ul></div>`;
  app.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => go('new', { type: b.dataset.new })));
  $('#go-backup') && ($('#go-backup').onclick = () => go('backup'));
}

// ---------------------------------------------------------------- גיבוי
async function backup() {
  const s = await api('/api/backup/status');
  if (s.mode === 'browser') return backupBrowser(s);
  const fmtAt = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  const stateTag = s.state === 'ok' ? '<span class="tag ok">בוצע ברבעון הנוכחי</span>'
    : s.state === 'due' ? '<span class="tag warn">יש לגבות השבוע</span>' : '<span class="tag bad">באיחור</span>';
  app.innerHTML = `<h2>גיבוי</h2>
  <div class="card"><h3>גיבוי רבעוני לכונן נפרד (הוראה 25(ו)(2))</h3>
    <p>מצב רבעון ${s.quarter}/${s.year}: ${stateTag}
      ${s.lastExternal ? `<span class="muted"> · אחרון: ${fmtAt(s.lastExternal.at)} (${s.lastExternal.doc_count} מסמכים${s.lastExternal.verified_ok ? ', אומת' : ', <b>לא אומת</b>'})</span>` : '<span class="muted"> · עדיין לא בוצע גיבוי חיצוני</span>'}</p>
    <p class="muted">ההוראה: גיבוי <b>בשבוע הראשון של כל רבעון</b>, שנשמר <b>במקום אחר</b> מהמחשב (למשל כונן חיצוני שנשמר מחוץ לבית), <b>בישראל</b>. מומלץ לגבות גם אחרי כל יום עבודה משמעותי. חשוב: להודיע בכתב לפקיד השומה היכן נשמר הגיבוי.</p>
    <div class="grid">
      <label>תיקיית יעד (על הכונן החיצוני)<input id="bk-target" value="${esc(s.target ?? '')}" placeholder="E:\\PinkasBackup" dir="ltr"></label>
    </div>
    ${s.drives.length ? `<p class="muted">כוננים שזוהו: ${s.drives.map((d) => `<button class="btn small" data-drive="${esc(d)}">${esc(d)}</button>`).join(' ')}</p>` : '<p class="muted">לא זוהה כונן נוסף. חבר כונן חיצוני ורענן.</p>'}
    ${s.target && !s.targetAvailable ? '<div class="msg warn">תיקיית היעד אינה זמינה כרגע – חבר את הכונן החיצוני.</div>' : ''}
    <div class="actions"><button class="btn" id="bk-save">שמור יעד</button>
      <button class="btn primary" id="bk-run" ${s.target && s.targetAvailable ? '' : 'disabled'}>גבה עכשיו לכונן החיצוני</button></div>
    <div id="bk-msg"></div></div>

  <div class="card"><h3>גיבוי מקומי אוטומטי</h3>
    <p class="muted">בכל יום שבו פנקס פועל נוצר גיבוי אוטומטי בתיקייה <span dir="ltr">${esc(s.dataDir)}\\backups</span> (נשמרים 14 אחרונים).
      זו הגנה מפני תקלות – <b>לא</b> תחליף לגיבוי הרבעוני החיצוני, כי הוא באותו מחשב.</p>
    ${s.lastLocal ? `<p>אחרון: ${fmtAt(s.lastLocal.at)}</p>` : ''}
    <div class="actions"><button class="btn" id="bk-local">גיבוי מקומי עכשיו</button></div></div>

  <div class="card"><h3>היסטוריית גיבויים ובדיקת שחזור</h3>
    <p class="muted">"בדוק" פותח את הגיבוי לקריאה בלבד ומוודא שכל הקבצים שלמים ושהמספור תקין. "דוח מהגיבוי" מפיק יומן רשומות ישירות מהגיבוי – הוכחה שאפשר להפיק פלט מהגיבוי (25(ו)(3)).</p>
    <table><thead><tr><th>מתי</th><th>סוג</th><th>מיקום</th><th class="num">מסמכים</th><th>אומת</th><th></th></tr></thead><tbody>
    ${s.log.map((r) => `<tr><td>${fmtAt(r.at)}</td><td>${r.kind === 'external' ? 'חיצוני' : 'מקומי'}</td><td dir="ltr" style="font-size:12px">${esc(r.path)}</td>
      <td class="num">${r.doc_count}</td><td>${r.verified_ok ? '<span class="tag ok">כן</span>' : '<span class="tag bad">לא</span>'}</td>
      <td><div class="actions" style="margin:0"><button class="btn small" data-verify="${esc(r.path)}">בדוק</button><button class="btn small" data-report="${esc(r.path)}">דוח מהגיבוי</button></div></td></tr>`).join('')}
    </tbody></table>${s.log.length ? '' : '<p class="muted">אין עדיין גיבויים.</p>'}</div>`;

  const showResult = (r) => {
    $('#bk-msg').innerHTML = r.verify.ok
      ? `<div class="msg info">✔ הגיבוי נוצר ואומת: ${r.verify.docCount} מסמכים.<br><span dir="ltr">${esc(r.dir)}</span></div>`
      : `<div class="msg err">הגיבוי נוצר אך האימות נכשל:<ul>${r.verify.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  };
  app.querySelectorAll('[data-drive]').forEach((b) => (b.onclick = () => ($('#bk-target').value = `${b.dataset.drive}PinkasBackup`)));
  $('#bk-save').onclick = async () => {
    try { await api('/api/backup/target', { method: 'POST', body: { target: $('#bk-target').value } }); toast('היעד נשמר'); backup(); }
    catch (e) { toast(e.message); }
  };
  $('#bk-run').onclick = async () => {
    $('#bk-run').disabled = true;
    try { const r = await api('/api/backup/run', { method: 'POST', body: { kind: 'external' } }); await backup(); showResult(r); }
    catch (e) { $('#bk-msg').innerHTML = errorBox(e); $('#bk-run').disabled = false; }
  };
  $('#bk-local').onclick = async () => {
    try { const r = await api('/api/backup/run', { method: 'POST', body: { kind: 'local' } }); await backup(); showResult(r); }
    catch (e) { toast(e.message); }
  };
  app.querySelectorAll('[data-verify]').forEach((b) => (b.onclick = async () => {
    try {
      const v = await api('/api/backup/verify', { method: 'POST', body: { path: b.dataset.verify } });
      await dialog(v.ok ? `<h3>✔ הגיבוי תקין</h3><p>${v.docCount} מסמכים, כל הקבצים שלמים והמספור רציף.</p>`
        : `<h3>בעיות בגיבוי</h3><ul>${v.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, [{ label: 'סגור', value: true, cls: 'primary' }]);
    } catch (e) { toast(e.message); }
  }));
  app.querySelectorAll('[data-report]').forEach((b) => (b.onclick = () => openPdfGet(`/api/backup/report?path=${encodeURIComponent(b.dataset.report)}`)));
}

// גיבוי בגרסת הדפדפן: קובץ גיבוי שמורידים ושומרים בכונן חיצוני.
function pickFile() {
  return new Promise((resolve) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json';
    i.onchange = () => resolve(i.files[0] ?? null); i.click();
  });
}

async function backupBrowser(s) {
  const fmtAt = (iso) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  const stateTag = s.state === 'ok' ? '<span class="tag ok">בוצע ברבעון הנוכחי</span>'
    : s.state === 'due' ? '<span class="tag warn">יש לגבות השבוע</span>' : '<span class="tag bad">באיחור</span>';
  app.innerHTML = `<h2>גיבוי</h2>
  <div class="msg warn"><b>חשוב:</b> בגרסת הדפדפן הספרים שמורים <b>בתוך הדפדפן הזה במחשב הזה</b>.
    ניקוי נתוני גלישה, מחיקת פרופיל או החלפת מחשב – ימחקו אותם. <b>קובץ הגיבוי הוא העותק היחיד מחוץ לדפדפן.</b>
    ${s.persisted ? '' : '<br>הדפדפן לא אישר אחסון קבוע לאתר – גבה לעתים קרובות.'}</div>
  <div class="card"><h3>גיבוי לקובץ (הוראה 25(ו)(2))</h3>
    <p>מצב רבעון ${s.quarter}/${s.year}: ${stateTag}
      ${s.lastExternal ? `<span class="muted"> · אחרון: ${fmtAt(s.lastExternal.at)} (${s.lastExternal.doc_count} מסמכים${s.lastExternal.verified_ok ? ', אומת' : ', <b>לא אומת</b>'})</span>` : '<span class="muted"> · עדיין לא בוצע גיבוי</span>'}</p>
    <p class="muted">"הורד גיבוי" יוצר קובץ אחד עם כל הספרים, המסמכים המצורפים והמקורות שהופקו, ומאמת אותו.
      <b>העתק את הקובץ לכונן חיצוני</b> ששמור במקום אחר, בישראל – לפחות בשבוע הראשון של כל רבעון, ומומלץ אחרי כל יום עבודה.
      חשוב: להודיע בכתב לפקיד השומה היכן נשמר הגיבוי.</p>
    <div class="actions"><button class="btn primary" id="bkb-export">הורד גיבוי עכשיו</button></div>
    <div id="bk-msg"></div></div>
  <div class="card"><h3>בדיקה ושחזור</h3>
    <p class="muted">"בדוק קובץ" מוודא שהקובץ שלם והמספור רציף. "דוח מקובץ" מפיק יומן רשומות ישירות מהגיבוי (25(ו)(3)).
      "שחזר" טוען גיבוי לדפדפן ריק – למשל במחשב חדש. (אסור לשחזר מעל ספרים קיימים, כדי לא לדרוס אותם.)</p>
    <div class="actions"><button class="btn" id="bkb-verify">בדוק קובץ גיבוי…</button><button class="btn" id="bkb-report">דוח מקובץ גיבוי…</button>
      <button class="btn danger" id="bkb-restore">שחזר מקובץ…</button></div></div>
  <div class="card"><h3>היסטוריה</h3>
    <p class="muted">בנוסף, כל יום נשמר עותק אוטומטי בתוך הדפדפן (14 אחרונים) – הגנה מתקלות, לא תחליף לגיבוי לקובץ.</p>
    <table><thead><tr><th>מתי</th><th>סוג</th><th>קובץ</th><th class="num">מסמכים</th><th>אומת</th></tr></thead><tbody>
    ${s.log.map((r) => `<tr><td>${fmtAt(r.at)}</td><td>${r.kind === 'external' ? 'קובץ גיבוי' : 'עותק בדפדפן'}</td><td dir="ltr" style="font-size:12px">${esc(r.path)}</td>
      <td class="num">${r.doc_count}</td><td>${r.verified_ok ? '<span class="tag ok">כן</span>' : '<span class="tag bad">לא</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
  $('#bkb-export').onclick = async () => {
    $('#bkb-export').disabled = true;
    try {
      const r = await LOCAL().exportBackup();
      await backup();
      $('#bk-msg').innerHTML = r.verify.ok
        ? `<div class="msg info">✔ הקובץ <b dir="ltr">${esc(r.name)}</b> הורד ואומת (${r.verify.docCount} מסמכים). עכשיו העתק אותו לכונן החיצוני.</div>`
        : `<div class="msg err">הקובץ הורד אך האימות נכשל:<ul>${r.verify.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    } catch (e) { $('#bk-msg').innerHTML = errorBox(e); $('#bkb-export').disabled = false; }
  };
  $('#bkb-verify').onclick = async () => {
    const f = await pickFile(); if (!f) return;
    try {
      const v = await LOCAL().verifyBackupFile(f);
      await dialog(v.ok ? `<h3>✔ הגיבוי תקין</h3><p>${v.docCount} מסמכים, נוצר ${fmtAt(v.createdAt)}. כל הקבצים שלמים והמספור רציף.</p>`
        : `<h3>בעיות בגיבוי</h3><ul>${v.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, [{ label: 'סגור', value: true, cls: 'primary' }]);
    } catch (e) { toast(e.message); }
  };
  $('#bkb-report').onclick = async () => { const f = await pickFile(); if (f) LOCAL().reportFromBackupFile(f).catch((e) => toast(e.message)); };
  $('#bkb-restore').onclick = async () => {
    const ok = await dialog('<h3>שחזור מגיבוי</h3><p>הספרים מהקובץ ייטענו לדפדפן הזה. אפשרי רק אם עדיין אין כאן מסמכים, הוצאות או הכנסות.</p>',
      [{ label: 'בחר קובץ ושחזר', value: true, cls: 'primary' }, { label: 'ביטול', value: false }]);
    if (!ok) return;
    const f = await pickFile(); if (!f) return;
    try { const r = await LOCAL().restoreFromFile(f); toast(`שוחזר: ${r.docCount} מסמכים`); go('dashboard'); }
    catch (e) { await dialog(`<h3>השחזור לא בוצע</h3><p>${esc(e.message)}</p>`, [{ label: 'סגור', value: true }]); }
  };
}

// ---------------------------------------------------------------- מסמך חדש
async function newDocument(init = {}) {
  const customers = await api('/api/customers');
  const allDocs = await api('/api/documents');
  const state = {
    type: init.type ?? 'invoice_receipt', customerId: init.customerId ?? '', issueDate: today(),
    description: '', reason: '', notes: '', withholding: '', related: init.related ?? [],
    lines: init.lines ?? [{ description: '', unit: 'מפגש', quantity: 1, price: '' }],
    payments: [{ method: 'transfer', amount: '', date: today() }],
  };

  const needsLines = () => ['invoice', 'invoice_receipt', 'order', 'credit'].includes(state.type);
  const needsPayments = () => ['receipt', 'invoice_receipt'].includes(state.type);
  const relatedCandidates = () => {
    const wanted = state.type === 'invoice' || state.type === 'invoice_receipt' ? ['order']
      : state.type === 'receipt' || state.type === 'credit' ? ['invoice', 'invoice_receipt'].filter((t) => state.type === 'credit' || t === 'invoice') : [];
    return allDocs.filter((d) => wanted.includes(d.type) && d.status === 'issued' && (!state.customerId || d.customerId === Number(state.customerId)));
  };

  function buildInput() {
    const input = { type: state.type, issueDate: state.issueDate, notes: state.notes || undefined };
    if (state.customerId) input.customerId = Number(state.customerId);
    if (state.description) input.description = state.description;
    if (state.type === 'credit') input.reason = state.reason;
    if (state.related.length) input.relatedDocumentIds = state.related.map(Number);
    if (needsLines()) input.lines = state.lines.map((l) => ({ description: l.description, unit: l.unit, quantity: Number(l.quantity), unitPriceAgorot: toAg(l.price || 0) }));
    if (needsPayments()) {
      input.payments = state.payments.map((p) => {
        const base = { method: p.method, amountAgorot: toAg(p.amount || 0), date: p.date };
        if (p.method === 'cheque') base.cheque = { number: p.chNumber ?? '', bank: p.chBank ?? '', branch: p.chBranch ?? '', account: p.chAccount || undefined, dueDate: p.chDue ?? '' };
        if (p.method === 'transfer') base.transfer = { reference: p.ref || undefined, bank: p.bank || undefined };
        if (p.method === 'credit_card') base.card = { last4: p.last4 ?? '', approval: p.approval || undefined, installments: p.installments ? Number(p.installments) : undefined };
        if (p.method === 'app') base.app = { name: p.appName ?? 'Bit', reference: p.ref || undefined };
        if (p.method === 'other') base.other = { description: p.otherDesc ?? '' };
        return base;
      });
      if (state.withholding) input.withholdingAgorot = toAg(state.withholding);
    }
    return input;
  }

  const linesTotal = () => state.lines.reduce((s, l) => s + Math.round(Number(l.quantity || 0) * toAg(l.price || 0)), 0);

  function paymentSubfields(p, i) {
    const f = (key, label, extra = '') => `<label>${label}<input data-p="${i}" data-k="${key}" value="${esc(p[key] ?? '')}" ${extra}></label>`;
    switch (p.method) {
      case 'cheque': return f('chNumber', 'מס\' שיק') + f('chBank', 'בנק') + f('chBranch', 'סניף') + f('chAccount', 'חשבון') + f('chDue', 'פירעון', 'type="date"');
      case 'transfer': return f('ref', 'אסמכתה') + f('bank', 'בנק');
      case 'credit_card': return f('last4', '4 ספרות', 'maxlength="4" class="num"') + f('approval', 'אישור') + f('installments', 'תשלומים', 'class="num"');
      case 'app': return f('appName', 'אפליקציה') + f('ref', 'אסמכתה');
      case 'other': return f('otherDesc', 'תיאור');
      default: return '<span class="muted" style="align-self:center">—</span>';
    }
  }

  function render() {
    const cands = relatedCandidates();
    app.innerHTML = `<h2>מסמך חדש</h2>
    <div class="card"><div class="grid">
      <label>סוג מסמך<select id="f-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === state.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>לקוח<select id="f-customer"><option value="">— בחר לקוח —</option>${customers.map((c) => `<option value="${c.id}" ${String(c.id) === String(state.customerId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>תאריך<input type="date" id="f-date" value="${state.issueDate}" max="${today()}"></label>
    </div>
    <div class="actions"><button class="btn small" id="f-newcust">+ לקוח חדש</button></div>
    ${state.type === 'receipt' || state.type === 'order' ? `<label style="margin-top:10px">${state.type === 'receipt' ? 'מהות התקבול (חובה)' : 'תיאור השירות המוזמן'}<input id="f-desc" value="${esc(state.description)}"></label>` : ''}
    ${state.type === 'credit' ? `<label style="margin-top:10px">סיבת הזיכוי (חובה)<input id="f-reason" value="${esc(state.reason)}"></label>` : ''}
    ${cands.length ? `<label style="margin-top:10px">${state.type === 'credit' ? 'חשבוניות שהזיכוי מתייחס אליהן (חובה)' : state.type === 'receipt' ? 'חשבוניות שהקבלה משלמת' : 'הזמנה קשורה'}
      <select id="f-related" multiple size="${Math.min(4, cands.length)}">${cands.map((d) => `<option value="${d.id}" ${state.related.map(String).includes(String(d.id)) ? 'selected' : ''}>${esc(d.typeName)} ${d.number} – ${fmtDate(d.issueDate)} – ${esc(d.customer)} – ${shekels(d.total)}</option>`).join('')}</select></label>` : ''}
    </div>

    ${needsLines() ? `<div class="card lines"><h3>${state.type === 'credit' ? 'פירוט הזיכוי' : 'שירותים'}</h3>
      ${state.lines.map((l, i) => `<div class="row-editor">
        <label>תיאור<input data-l="${i}" data-k="description" value="${esc(l.description)}"></label>
        <label>יחידה<input data-l="${i}" data-k="unit" value="${esc(l.unit)}"></label>
        <label>כמות<input data-l="${i}" data-k="quantity" class="num" value="${esc(l.quantity)}"></label>
        <label>מחיר ליחידה ₪<input data-l="${i}" data-k="price" class="num" value="${esc(l.price)}"></label>
        <button class="btn small danger" data-dell="${i}" ${state.lines.length < 2 ? 'disabled' : ''}>✕</button></div>`).join('')}
      <button class="btn small" id="f-addline">+ שורה</button>
      <div class="total-line">סה"כ: <span id="f-ltotal">${shekels(linesTotal())}</span></div></div>` : ''}

    ${needsPayments() ? `<div class="card payments"><h3>אמצעי תשלום</h3>
      ${state.payments.map((p, i) => `<div class="row-editor">
        <label>אמצעי<select data-p="${i}" data-k="method">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}" ${k === p.method ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>סכום ₪<input data-p="${i}" data-k="amount" class="num" value="${esc(p.amount)}"></label>
        <label>תאריך<input type="date" data-p="${i}" data-k="date" value="${esc(p.date)}"></label>
        <div class="subfields">${paymentSubfields(p, i)}</div>
        <button class="btn small danger" data-delp="${i}" ${state.payments.length < 2 ? 'disabled' : ''}>✕</button></div>`).join('')}
      <div class="actions"><button class="btn small" id="f-addpay">+ אמצעי תשלום</button>
        ${state.type === 'invoice_receipt' ? '<button class="btn small" id="f-fillpay">מלא סכום לפי החשבונית</button>' : ''}</div>
      <label style="max-width:220px;margin-top:8px">ניכוי במקור ₪ (אם נוכה)<input id="f-wh" class="num" value="${esc(state.withholding)}"></label></div>` : ''}

    <div class="card"><label>הערות (יודפסו על המסמך)<input id="f-notes" value="${esc(state.notes)}"></label>
      <div id="f-msg"></div>
      <div class="actions"><button class="btn" id="f-preview">תצוגה מקדימה (טיוטה)</button><button class="btn primary" id="f-issue">הפק מסמך</button></div>
      <p class="muted" style="margin:8px 0 0">הפקה היא סופית: מסמך שהופק לא ניתן לעריכה או למחיקה. תיקון – בביטול (לפני שיצא) או בהודעת זיכוי.</p></div>
    <div id="f-prev"></div>`;
    bind();
  }

  function bind() {
    $('#f-type').onchange = (e) => { state.type = e.target.value; state.related = []; render(); };
    $('#f-customer').onchange = (e) => { state.customerId = e.target.value; state.related = []; render(); };
    $('#f-date').onchange = (e) => (state.issueDate = e.target.value);
    $('#f-desc') && ($('#f-desc').oninput = (e) => (state.description = e.target.value));
    $('#f-reason') && ($('#f-reason').oninput = (e) => (state.reason = e.target.value));
    $('#f-notes').oninput = (e) => (state.notes = e.target.value);
    $('#f-wh') && ($('#f-wh').oninput = (e) => (state.withholding = e.target.value));
    $('#f-related') && ($('#f-related').onchange = (e) => (state.related = [...e.target.selectedOptions].map((o) => o.value)));
    app.querySelectorAll('[data-l]').forEach((el) => (el.oninput = () => {
      state.lines[el.dataset.l][el.dataset.k] = el.value; const t = $('#f-ltotal'); if (t) t.textContent = shekels(linesTotal());
    }));
    app.querySelectorAll('[data-p]').forEach((el) => {
      const h = () => { state.payments[el.dataset.p][el.dataset.k] = el.value; if (el.dataset.k === 'method') render(); };
      el.tagName === 'SELECT' ? (el.onchange = h) : (el.oninput = h);
    });
    app.querySelectorAll('[data-dell]').forEach((b) => (b.onclick = () => { state.lines.splice(b.dataset.dell, 1); render(); }));
    app.querySelectorAll('[data-delp]').forEach((b) => (b.onclick = () => { state.payments.splice(b.dataset.delp, 1); render(); }));
    $('#f-addline') && ($('#f-addline').onclick = () => { state.lines.push({ description: '', unit: 'מפגש', quantity: 1, price: '' }); render(); });
    $('#f-addpay') && ($('#f-addpay').onclick = () => { state.payments.push({ method: 'transfer', amount: '', date: today() }); render(); });
    $('#f-fillpay') && ($('#f-fillpay').onclick = () => {
      const rest = linesTotal() - toAg(state.withholding || 0) - state.payments.slice(1).reduce((s, p) => s + toAg(p.amount || 0), 0);
      state.payments[0].amount = (rest / 100).toFixed(2); render();
    });
    $('#f-newcust').onclick = async () => {
      const c = await customerDialog();
      if (c) { customers.push(c); state.customerId = c.id; render(); }
    };
    $('#f-preview').onclick = async () => {
      try {
        const r = await api('/api/documents/preview', { method: 'POST', body: buildInput() });
        $('#f-msg').innerHTML = (r.errors.length ? `<div class="msg err">שגיאות:<ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '')
          + (r.warnings.length ? `<div class="msg warn">אזהרות:<ul>${r.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
        $('#f-prev').innerHTML = '<iframe class="preview" sandbox></iframe>';
        $('#f-prev iframe').srcdoc = r.html;
      } catch (e) { $('#f-msg').innerHTML = errorBox(e); }
    };
    $('#f-issue').onclick = () => issue(false);
  }

  async function issue(ack) {
    const btn = $('#f-issue'); btn.disabled = true;
    try {
      const r = await api('/api/documents', { method: 'POST', body: { ...buildInput(), acknowledgeWarnings: ack } });
      toast(`הופק: ${r.document.typeName} מס' ${r.document.number}`);
      await go('documents', { highlight: r.document.id });
    } catch (e) {
      btn.disabled = false;
      if (e.status === 422 && !e.errors?.length && e.warnings?.length) {
        const ok = await dialog(`<h3>אזהרות לפני הפקה</h3><ul>${e.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p>להפיק בכל זאת? האזהרות יירשמו עם המסמך.</p>`,
          [{ label: 'הפק בכל זאת', value: true, cls: 'primary' }, { label: 'חזור לתיקון', value: false }]);
        if (ok) return issue(true);
      } else $('#f-msg').innerHTML = errorBox(e);
    }
  }
  render();
}

// ---------------------------------------------------------------- רשימת מסמכים
async function documents(opts = {}) {
  const docs = await api('/api/documents');
  app.innerHTML = `<h2>מסמכים</h2><div class="card">
    <div class="actions" style="margin:0 0 10px"><select id="d-filter"><option value="">כל הסוגים</option>${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    <table><thead><tr><th>סוג</th><th class="num">מס'</th><th>תאריך</th><th>לקוח</th><th class="num">סכום</th><th>מצב</th><th>פעולות</th></tr></thead>
    <tbody id="d-body"></tbody></table>${docs.length ? '' : '<p class="muted">עדיין אין מסמכים.</p>'}</div>`;
  const body = $('#d-body');
  const draw = (filter) => {
    body.innerHTML = docs.filter((d) => !filter || d.type === filter).map((d) => `<tr ${opts.highlight === d.id ? 'style="background:var(--accent-weak)"' : ''}>
      <td>${esc(d.typeName)}</td><td class="num">${d.number}</td><td>${fmtDate(d.issueDate)}</td><td>${esc(d.customer)}</td>
      <td class="num">${shekels(d.total)}</td>
      <td>${d.status === 'cancelled' ? '<span class="tag bad">מבוטל</span>'
        : d.originalProducedAt ? `<span class="tag ok">מקור הופק</span>${d.originalDelivery ? ' <span class="tag">נמסר</span>' : ''}` : '<span class="tag warn">טרם הופק מקור</span>'}</td>
      <td><div class="actions" style="margin:0">
        <button class="btn small" data-a="view" data-id="${d.id}">צפייה</button>
        ${d.status === 'issued' && !d.originalProducedAt ? `<button class="btn small primary" data-a="original" data-id="${d.id}">הפק מקור</button>` : ''}
        ${d.status === 'issued' ? `<button class="btn small" data-a="copy" data-id="${d.id}">העתק PDF</button>` : ''}
        ${d.originalProducedAt && !d.originalDelivery ? `<button class="btn small" data-a="delivery" data-id="${d.id}">רשום מסירה</button>` : ''}
        ${d.status === 'issued' && ['invoice', 'invoice_receipt'].includes(d.type) ? `<button class="btn small" data-a="credit" data-id="${d.id}">זיכוי</button>` : ''}
        ${d.type === 'invoice' && d.status === 'issued' ? `<button class="btn small" data-a="receipt" data-id="${d.id}">קבלה</button>` : ''}
        ${d.status === 'issued' && !d.originalProducedAt ? `<button class="btn small danger" data-a="cancel" data-id="${d.id}">ביטול</button>` : ''}
      </div></td></tr>`).join('');
    body.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => docAction(b.dataset.a, docs.find((x) => x.id === Number(b.dataset.id)))));
  };
  $('#d-filter').onchange = (e) => draw(e.target.value);
  draw('');
}

async function docAction(action, d) {
  const name = `${d.typeName} מס' ${d.number}`;
  try {
    if (action === 'view') {
      if (!LOCAL()) return window.open(`/api/documents/${d.id}/view`, '_blank');
      const win = window.open('', '_blank');                 // נפתח מיד (בתוך הלחיצה) כדי שלא ייחסם
      return LOCAL().showHtmlInWindow(win, (await api(`/api/documents/${d.id}/view`)).html);
    }
    if (action === 'original') {
      const ok = await dialog(`<h3>הפקת מקור – ${esc(name)}</h3><p>ה"מקור" מופק <b>פעם אחת בלבד</b>. אחרי ההפקה: להדפיס, לחתום ביד ולמסור/לשלוח ללקוח. כל הפקה נוספת תסומן "העתק".</p><p>אחרי הפקת מקור אי אפשר לבטל את המסמך – רק להוציא הודעת זיכוי.</p>`,
        [{ label: 'הפק מקור', value: true, cls: 'primary' }, { label: 'ביטול', value: false }]);
      if (!ok) return;
      download(await api(`/api/documents/${d.id}/pdf`, { method: 'POST', body: { kind: 'original', purpose: 'print' } }));
      toast('המקור הופק ונשמר גם בארכיון (data/outputs)');
    }
    if (action === 'copy') {
      const purpose = await dialog(`<h3>העתק – ${esc(name)}</h3><p>למה ההעתק?</p>`,
        [{ label: 'לשליחה ללקוח (מייל)', value: 'sent', cls: 'primary' }, { label: 'להדפסה / לתיק שלי', value: 'print' }]);
      if (!purpose) return;
      download(await api(`/api/documents/${d.id}/pdf`, { method: 'POST', body: { kind: 'copy', purpose } }));
      if (purpose === 'sent') toast('נרשם שהמסמך נשלח ללקוח – מעתה אי אפשר לבטל אותו, רק לזכות');
    }
    if (action === 'delivery') {
      const method = await dialog(`<h3>מסירת המקור – ${esc(name)}</h3><label>תאריך<input type="date" id="dl-date" value="${today()}"></label>`,
        [{ label: 'נשלח בדואר', value: 'mail', cls: 'primary' }, { label: 'נמסר ביד', value: 'hand' }, { label: 'דואר רשום', value: 'registered_mail' }]);
      if (!method) return;
      await api(`/api/documents/${d.id}/delivery`, { method: 'POST', body: { method, date: $('#dl-date')?.value || today() } });
      toast('המסירה נרשמה');
    }
    if (action === 'cancel') {
      const ok = await dialog(`<h3>ביטול ${esc(name)}</h3><p>מותר רק אם המסמך עוד לא יצא ממך. המספר "נשרף" ולא ישמש שוב.</p><label>סיבת הביטול<input id="cx-reason"></label>`,
        [{ label: 'בטל מסמך', value: true, cls: 'danger' }, { label: 'חזור', value: false }]);
      if (!ok) return;
      await api(`/api/documents/${d.id}/cancel`, { method: 'POST', body: { reason: $('#cx-reason').value } });
      toast('המסמך בוטל');
    }
    if (action === 'credit') return go('new', { type: 'credit', customerId: d.customerId, related: [d.id], lines: [{ description: '', unit: 'יחידה', quantity: 1, price: (d.total / 100).toFixed(2) }] });
    if (action === 'receipt') return go('new', { type: 'receipt', customerId: d.customerId, related: [d.id] });
    await go('documents');
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- הוצאות
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file);
});

async function expenses() {
  const meta = await api('/api/expenses/meta');
  const list = await api('/api/expenses');
  const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  app.innerHTML = `<h2>הוצאות</h2>
  <div class="card"><h3>רישום הוצאה</h3><div class="grid">
    <label>תאריך המסמך<input type="date" id="e-date" value="${today()}" max="${today()}"></label>
    <label>ספק (חובה)<input id="e-supplier" list="e-suppliers"></label>
    <label>מס' עוסק / ח"פ של הספק<input id="e-supid"></label>
    <label>סוג מסמך הספק<select id="e-kind">${opt(meta.docKinds, 'tax_invoice_receipt')}</select></label>
    <label>מס' מסמך הספק<input id="e-docno"></label>
    <label>סכום כולל ₪ (חובה)<input id="e-amount" class="num"></label>
    <label>אמצעי תשלום<select id="e-method">${opt(meta.paymentMethods, 'credit_card')}</select></label>
    <label>קטגוריה<select id="e-cat">${meta.categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
    <label>סוג רישום<select id="e-col"><option value="regular">הוצאה שוטפת</option><option value="asset">רכישת נכס (ציוד לשנים – מחשב וכד')</option><option value="deposit">פיקדון</option></select></label>
  </div>
  <datalist id="e-suppliers">${[...new Set(list.map((e) => e.supplier_name))].map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
  <label style="margin-top:10px">תיאור (חובה)<input id="e-desc"></label>
  <label style="margin-top:10px">צילום / סריקה של המסמך (PDF או תמונה, עד 10MB)<input type="file" id="e-file" accept="application/pdf,image/*"></label>
  <p class="muted" style="margin:6px 0 0">⚠️ <b>שמור את מסמך הנייר המקורי</b> בתיק ההוצאות. הצילום כאן הוא עותק לנוחות בלבד (ביעור המקור מותר רק בתנאים של נספח ו').</p>
  <div id="e-msg"></div>
  <div class="actions"><button class="btn primary" id="e-save">רשום הוצאה</button></div>
  <p class="muted" style="margin:8px 0 0">רישום הוא סופי. תיקון – ב"רישום נגדי". יש לרשום עד 30 יום מתום החודש (הוראה 20).</p></div>

  <div class="card"><h3>רישומים</h3>
  <table><thead><tr><th class="num">#</th><th>תאריך</th><th>ספק</th><th>תיאור</th><th>קטגוריה</th><th class="num">סכום</th><th>מסמך</th><th></th></tr></thead><tbody>
  ${list.map((e) => `<tr ${e.reverses_id || e.reversed ? 'style="color:var(--muted)"' : ''}>
    <td class="num">${e.entry_number}</td><td>${fmtDate(e.expense_date)}</td><td>${esc(e.supplier_name)}</td>
    <td>${esc(e.description)}${e.column_kind !== 'regular' ? ` <span class="tag">${e.column_kind === 'asset' ? 'נכס' : 'פיקדון'}</span>` : ''}${e.reversed ? ' <span class="tag bad">בוטל</span>' : ''}</td>
    <td>${esc(e.category)}</td><td class="num">${shekels(e.amount_agorot)}</td>
    <td>${esc(meta.docKinds[e.doc_kind])} ${esc(e.doc_number ?? '')}${e.attachment ? ` <a href="/api/expenses/${e.id}/attachment" target="_blank" data-att="${e.id}">📎</a>` : ''}</td>
    <td>${!e.reverses_id && !e.reversed ? `<button class="btn small danger" data-rev="${e.id}">רישום נגדי</button>` : ''}</td></tr>`).join('')}
  </tbody></table>${list.length ? '' : '<p class="muted">עדיין אין הוצאות.</p>'}</div>`;

  const save = async (ack) => {
    const btn = $('#e-save'); btn.disabled = true;
    try {
      const f = $('#e-file').files[0];
      const body = {
        expenseDate: $('#e-date').value, supplierName: $('#e-supplier').value, supplierIdNumber: $('#e-supid').value || undefined,
        docKind: $('#e-kind').value, docNumber: $('#e-docno').value || undefined, description: $('#e-desc').value,
        category: $('#e-cat').value, amountAgorot: toAg($('#e-amount').value || 0), paymentMethod: $('#e-method').value,
        columnKind: $('#e-col').value, acknowledgeWarnings: ack,
        attachment: f ? { name: f.name, type: f.type, base64: await fileToBase64(f) } : undefined,
      };
      const r = await api('/api/expenses', { method: 'POST', body });
      toast(`נרשמה הוצאה מס' ${r.expense.entry_number}`); expenses();
    } catch (e) {
      btn.disabled = false;
      if (e.status === 422 && !e.errors?.length && e.warnings?.length) {
        const ok = await dialog(`<h3>לפני רישום</h3><ul>${e.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p>לרשום בכל זאת?</p>`,
          [{ label: 'רשום', value: true, cls: 'primary' }, { label: 'חזור', value: false }]);
        if (ok) return save(true);
      } else $('#e-msg').innerHTML = errorBox(e);
    }
  };
  $('#e-save').onclick = () => save(false);
  if (LOCAL()) app.querySelectorAll('[data-att]').forEach((a) => (a.onclick = (ev) => {
    ev.preventDefault();
    const win = window.open('', '_blank');
    LOCAL().openAttachment(win, Number(a.dataset.att)).catch((e) => { win?.close(); toast(e.message); });
  }));
  await otherIncomeSection();
  app.querySelectorAll('[data-rev]').forEach((b) => (b.onclick = async () => {
    const e = list.find((x) => x.id === Number(b.dataset.rev));
    const ok = await dialog(`<h3>רישום נגדי להוצאה ${e.entry_number}</h3><p>${esc(e.supplier_name)} – ${shekels(e.amount_agorot)}. הרישום המקורי יישאר, ויתווסף רישום בסכום שלילי.</p>
      <label>סיבה<input id="rv-reason"></label>`, [{ label: 'בצע רישום נגדי', value: true, cls: 'danger' }, { label: 'חזור', value: false }]);
    if (!ok) return;
    try { await api(`/api/expenses/${e.id}/reverse`, { method: 'POST', body: { reason: $('#rv-reason').value } }); toast('נרשם רישום נגדי'); expenses(); }
    catch (err) { toast(err.message); }
  }));
}

// הכנסות שאינן ממסמכים: פיצויים/מענקים (במחזור) ותשלומי ביטוח לאומי (לא במחזור)
async function otherIncomeSection() {
  const { kinds, rows } = await api('/api/other-income');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h3>הכנסות נוספות (פיצויים, מענקים, תשלומי ביטוח לאומי)</h3>
    <p class="muted">פיצוי על נזק עקיף ומענקי רשות המסים <b>נכללים במחזור</b> (תקנות התשפ"ו-2025). דמי מילואים ודמי לידה <b>מביטוח לאומי</b>
      אינם במחזור – נרשמים כאן רק כדי שיופיעו בשדה הייעודי בדיווח המקוצר. (אם שולמו ע"י מעסיק – זה שכר, לא כאן.)</p>
    <div class="grid">
      <label>תאריך<input type="date" id="oi-date" value="${today()}" max="${today()}"></label>
      <label>סוג<select id="oi-kind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select></label>
      <label>משלם<input id="oi-payer" value="מס רכוש"></label>
      <label>סכום ₪<input id="oi-amount" class="num"></label>
      <label>אסמכתה<input id="oi-ref"></label>
    </div>
    <label style="margin-top:10px">תיאור<input id="oi-desc"></label>
    <div class="actions"><button class="btn" id="oi-save">רשום</button></div>
    ${rows.length ? `<table style="margin-top:10px"><thead><tr><th class="num">#</th><th>תאריך</th><th>סוג</th><th>משלם</th><th>תיאור</th><th class="num">סכום</th><th>במחזור</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr ${r.reverses_id || r.reversed ? 'style="color:var(--muted)"' : ''}><td class="num">${r.entry_number}</td><td>${fmtDate(r.income_date)}</td>
        <td>${esc(kinds[r.kind].name)}</td><td>${esc(r.payer)}</td><td>${esc(r.description)}${r.reversed ? ' <span class="tag bad">בוטל</span>' : ''}</td>
        <td class="num">${shekels(r.amount_agorot)}</td><td>${kinds[r.kind].inTurnover ? 'כן' : 'לא'}</td>
        <td>${!r.reverses_id && !r.reversed ? `<button class="btn small danger" data-oirev="${r.id}">רישום נגדי</button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : ''}`;
  app.appendChild(card);
  $('#oi-kind').onchange = (e) => ($('#oi-payer').value = e.target.value.startsWith('nii') ? 'ביטוח לאומי' : e.target.value === 'grant' ? 'רשות המסים' : 'מס רכוש');
  $('#oi-save').onclick = async () => {
    try {
      await api('/api/other-income', { method: 'POST', body: { incomeDate: $('#oi-date').value, kind: $('#oi-kind').value,
        payer: $('#oi-payer').value, description: $('#oi-desc').value, amountAgorot: toAg($('#oi-amount').value || 0), reference: $('#oi-ref').value || undefined } });
      toast('נרשם'); expenses();
    } catch (e) { toast(e.message); }
  };
  card.querySelectorAll('[data-oirev]').forEach((b) => (b.onclick = async () => {
    const ok = await dialog('<h3>רישום נגדי</h3><label>סיבה<input id="oir-reason"></label>', [{ label: 'בצע', value: true, cls: 'danger' }, { label: 'חזור', value: false }]);
    if (!ok) return;
    try { await api(`/api/other-income/${b.dataset.oirev}/reverse`, { method: 'POST', body: { reason: $('#oir-reason').value } }); toast('נרשם רישום נגדי'); expenses(); }
    catch (e) { toast(e.message); }
  }));
}

// ---------------------------------------------------------------- לקוחות
async function customerDialog(c = {}) {
  const ok = await dialog(`<h3>${c.id ? 'עריכת לקוח' : 'לקוח חדש'}</h3><div class="grid">
    <label>שם (חובה)<input id="c-name" value="${esc(c.name)}"></label>
    <label>ת"ז / ח"פ / מס' עוסק<input id="c-id" value="${esc(c.idNumber)}"></label>
    <label>מען<input id="c-address" value="${esc(c.address)}"></label>
    <label>דוא"ל<input id="c-email" value="${esc(c.email)}"></label>
    <label>טלפון<input id="c-phone" value="${esc(c.phone)}"></label></div>
    <p class="muted">שינוי פרטים לא משנה מסמכים שכבר הופקו.</p>`, [{ label: 'שמור', value: true, cls: 'primary' }, { label: 'ביטול', value: false }]);
  if (!ok) return null;
  const body = { name: $('#c-name').value, idNumber: $('#c-id').value || null, address: $('#c-address').value || null, email: $('#c-email').value || null, phone: $('#c-phone').value || null };
  try { return c.id ? await api(`/api/customers/${c.id}`, { method: 'PUT', body }) : await api('/api/customers', { method: 'POST', body }); }
  catch (e) { toast(e.message); return null; }
}

async function customers() {
  const list = await api('/api/customers');
  app.innerHTML = `<h2>לקוחות</h2><div class="card"><div class="actions" style="margin:0 0 10px"><button class="btn primary" id="c-add">+ לקוח חדש</button></div>
    <table><thead><tr><th>שם</th><th>מזהה</th><th>מען</th><th class="num">יתרה</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.idNumber)}</td><td>${esc(c.address)}</td><td class="num">${shekels(c.balance)}</td>
      <td><div class="actions" style="margin:0"><button class="btn small" data-edit="${c.id}">עריכה</button><button class="btn small" data-ledger="${c.id}">כרטסת</button></div></td></tr>`).join('')}
    </tbody></table>${list.length ? '' : '<p class="muted">עדיין אין לקוחות.</p>'}</div><div id="c-ledger"></div>`;
  $('#c-add').onclick = async () => { if (await customerDialog()) customers(); };
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => { if (await customerDialog(list.find((c) => c.id === Number(b.dataset.edit)))) customers(); }));
  app.querySelectorAll('[data-ledger]').forEach((b) => (b.onclick = async () => {
    const c = list.find((x) => x.id === Number(b.dataset.ledger));
    const l = await api(`/api/customers/${c.id}/ledger`);
    $('#c-ledger').innerHTML = `<div class="card"><h3>כרטסת – ${esc(c.name)}</h3><table><thead><tr><th>תאריך</th><th>מסמך</th><th class="num">חובה</th><th class="num">זכות</th><th class="num">יתרה</th></tr></thead><tbody>
      ${l.entries.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${TYPES[e.docType]} ${e.number}</td><td class="num">${e.debit ? shekels(e.debit) : ''}</td><td class="num">${e.credit ? shekels(e.credit) : ''}</td><td class="num">${shekels(e.balance)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }));
}

// ---------------------------------------------------------------- דוחות
async function reports() {
  const r = await api('/api/reports/continuity');
  const year = today().slice(0, 4);
  app.innerHTML = `<h2>דוחות</h2>
  <div class="card"><h3>בדיקת רצף מספרים (נספח ה(א)(5))</h3>
    <table><thead><tr><th>סוג</th><th class="num">כמות</th><th class="num">אחרון</th><th>חסרים</th><th>מבוטלים</th><th>תקין</th></tr></thead><tbody>
    ${r.series.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.count}</td><td class="num">${s.lastNumber ?? '-'}</td>
      <td>${s.missingNumbers.join(', ') || 'אין'}</td><td>${s.cancelledNumbers.join(', ') || 'אין'}</td>
      <td>${s.ok ? '<span class="tag ok">תקין</span>' : `<span class="tag bad">בעיה${s.hashErrors.length ? ` (תוכן שונה: ${s.hashErrors.join(', ')})` : ''}</span>`}</td></tr>`).join('')}
    </tbody></table>
    <p>יומן אירועים: ${r.audit.ok ? '<span class="tag ok">שלם</span>' : '<span class="tag bad">פגום</span>'}</p>
    <div class="actions"><button class="btn" id="r-cont">PDF</button></div></div>
  <div class="card"><h3>ספר תקבולים ותשלומים (הוראה 12)</h3><div class="grid">
    <label>מתאריך<input type="date" id="r-bfrom" value="${year}-01-01"></label><label>עד תאריך<input type="date" id="r-bto" value="${today()}"></label></div>
    <div class="actions"><button class="btn" id="r-book">PDF</button></div></div>
  <div class="card"><h3>סיכום שנתי (נתונים לדוחות השנתיים)</h3><label style="max-width:160px">שנה<input id="r-year" class="num" value="${year}"></label>
    <div class="actions"><button class="btn" id="r-annual">PDF</button></div></div>
  <div class="card"><h3>יומן רשומות (נספח ה(א)(1))</h3><div class="grid">
    <label>מתאריך<input type="date" id="r-from" value="${year}-01-01"></label><label>עד תאריך<input type="date" id="r-to" value="${today()}"></label></div>
    <div class="actions"><button class="btn" id="r-journal">PDF</button></div></div>
  <div class="card"><h3>רשימת יתרות לקוחות (תוספת י"א)</h3><label style="max-width:220px">נכון ליום<input type="date" id="r-bal" value="${year}-12-31"></label>
    <div class="actions"><button class="btn" id="r-balances">PDF</button></div></div>`;
  $('#r-cont').onclick = () => openPdfGet('/api/reports/continuity?format=pdf');
  $('#r-book').onclick = () => openPdfGet(`/api/reports/book?format=pdf&from=${$('#r-bfrom').value}&to=${$('#r-bto').value}`);
  $('#r-annual').onclick = () => openPdfGet(`/api/reports/annual?format=pdf&year=${$('#r-year').value}`);
  $('#r-journal').onclick = () => openPdfGet(`/api/reports/journal?from=${$('#r-from').value}&to=${$('#r-to').value}`);
  $('#r-balances').onclick = () => openPdfGet(`/api/reports/balances?format=pdf&date=${$('#r-bal').value}`);
}

// ---------------------------------------------------------------- הגדרות
async function settings(opts = {}) {
  const b = (await api('/api/business')) ?? {};
  const series = await api('/api/series');
  const docs = await api('/api/documents');
  app.innerHTML = `<h2>הגדרות</h2>
  ${opts.first ? '<div class="msg info">ברוך הבא! לפני הפקת מסמכים יש להזין את פרטי העסק.</div>' : ''}
  <div class="card"><h3>פרטי העסק (מודפסים על כל מסמך)</h3><div class="grid">
    <label>שם העסק / שמך<input id="b-name" value="${esc(b.name)}"></label>
    <label>מספר עוסק פטור (ת"ז)<input id="b-id" value="${esc(b.idNumber)}"></label>
    <label>מען העסק<input id="b-address" value="${esc(b.address)}"></label>
    <label>טלפון<input id="b-phone" value="${esc(b.phone)}"></label>
    <label>דוא"ל<input id="b-email" value="${esc(b.email)}"></label></div>
    <div class="actions"><button class="btn primary" id="b-save">שמור</button></div>
    <p class="muted">שינוי פרטים יחול על מסמכים חדשים בלבד.</p></div>
  <div class="card"><h3>מספר התחלתי לכל סוג מסמך</h3>
    <p class="muted">אם עד היום הוצאת קבלות מפנקס, קבע כאן את המספר הבא, כדי שהמספור יימשך ולא יחזור על עצמו באותה שנת מס (הוראה 18(א)(3)). אפשרי רק לפני המסמך הראשון מכל סוג.</p>
    <table><tbody>${series.map((s) => {
      const used = docs.some((d) => d.type === s.doc_type);
      return `<tr><td>${TYPES[s.doc_type]}</td><td class="num">הבא: ${s.next_number}</td><td>${used ? '<span class="muted">נעול</span>'
        : `<input class="num" style="width:110px" id="s-${s.doc_type}" value="${s.next_number}"> <button class="btn small" data-series="${s.doc_type}">קבע</button>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  $('#b-save').onclick = async () => {
    try {
      await api('/api/business', { method: 'POST', body: { name: $('#b-name').value, idNumber: $('#b-id').value, address: $('#b-address').value, phone: $('#b-phone').value || undefined, email: $('#b-email').value || undefined } });
      toast('נשמר'); if (opts.first) go('dashboard');
    } catch (e) { toast(e.message); }
  };
  app.querySelectorAll('[data-series]').forEach((btn) => (btn.onclick = async () => {
    const t = btn.dataset.series;
    try { await api(`/api/series/${t}/start`, { method: 'POST', body: { start: Number($(`#s-${t}`).value) } }); toast('נקבע'); settings(); }
    catch (e) { toast(e.message); }
  }));
}

// בגרסת הדפדפן מחכים שהמסד המקומי ייטען
Promise.resolve(window.pinkasReady).then(() => go('dashboard')).catch(() => {});
