// דף הכניסה והגדרת הכניסה הראשונית (סיסמה + קוד משתנה).
const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of ['login', 'setup1', 'setup2']) $(s).hidden = s !== id; };
const msg = (text, ok = false) => { const m = $('msg'); m.textContent = text; m.className = `msg ${ok ? 'ok' : 'err'}`; m.hidden = !text; };

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pinkas': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'שגיאה');
  return data;
}

let token = '';

async function init() {
  const s = await fetch('/api/auth/status').then((r) => r.json());
  if (s.loggedIn) return location.replace('/');
  show(s.configured ? 'login' : 'setup1');
  if (s.locked) msg(`יותר מדי ניסיונות כושלים. הכניסה נעולה לעוד ${s.lockedMinutes} דקות.`);
  (s.configured ? $('l-pw') : $('s-token')).focus();
}

$('login-form').onsubmit = async (e) => {
  e.preventDefault(); msg('');
  try {
    await post('/api/auth/login', { password: $('l-pw').value, code: $('l-code').value.trim() });
    location.replace('/');
  } catch (err) { msg(err.message); $('l-code').value = ''; $('l-code').focus(); }
};

$('setup1-form').onsubmit = async (e) => {
  e.preventDefault(); msg('');
  if ($('s-pw').value !== $('s-pw2').value) return msg('הסיסמאות לא זהות.');
  try {
    token = $('s-token').value.trim();
    const r = await post('/api/auth/setup/start', { token, password: $('s-pw').value });
    $('s-secret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
    $('s-uri').href = r.uri;
    show('setup2'); $('s-code').focus();
  } catch (err) { msg(err.message); }
};

$('setup2-form').onsubmit = async (e) => {
  e.preventDefault(); msg('');
  try {
    await post('/api/auth/setup/finish', { token, code: $('s-code').value.trim() });
    show('login'); msg('הכניסה הוגדרה. היכנס עם הסיסמה והקוד הבא שיופיע באפליקציה.', true); $('l-pw').focus();
  } catch (err) { msg(err.message); $('s-code').value = ''; }
};

init().catch((e) => msg(e.message));
