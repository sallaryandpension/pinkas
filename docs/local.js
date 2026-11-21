(() => {
  // src/db/schema.sql
  var schema_default = `-- פנקס – סכמת מסד הנתונים (SQLite)
-- עיקרון: "קובץ קבוע" (הוראות מס הכנסה (ניהול פנקסי חשבונות) 1973, ס' 1 ונספח ה'):
--   אין מחיקה, אין עריכה של מסמך שהופק, מספור אוטומטי עוקב לכל סוג מסמך.
--   האכיפה נעשית כאן, ברמת המסד (triggers), ולא רק בקוד האפליקציה.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- פרטי העסק – גרסאות בלבד (append-only). המסמכים שומרים snapshot של הגרסה בתוקף.
CREATE TABLE IF NOT EXISTS business_profile_versions (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  data       TEXT NOT NULL            -- JSON: name, id_number, address, phone, email, status
);

-- לקוחות – מותר לעדכן (המסמכים שומרים snapshot), אסור למחוק לקוח שיש לו מסמכים.
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  id_number  TEXT,                    -- ת"ז / ח"פ / מספר עוסק / מספר עמותה (רשות)
  address    TEXT,
  email      TEXT,
  phone      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- סוגי מסמכים רשמיים. אין "חשבונית מס" – עוסק פטור אינו רשאי (חוק מע"מ 50(א)).
CREATE TABLE IF NOT EXISTS document_types (
  code    TEXT PRIMARY KEY,
  name_he TEXT NOT NULL
);
INSERT OR IGNORE INTO document_types (code, name_he) VALUES
  ('order',           'הזמנה'),
  ('invoice',         'חשבונית עסקה'),
  ('invoice_receipt', 'חשבונית עסקה/קבלה'),
  ('receipt',         'קבלה'),
  ('credit',          'הודעת זיכוי');

-- סדרות מספור – סדרה נפרדת לכל סוג (ס' 5(ג), 18(א)(3)). המספור לא מתאפס בין שנים.
CREATE TABLE IF NOT EXISTS series (
  doc_type     TEXT PRIMARY KEY REFERENCES document_types(code),
  start_number INTEGER NOT NULL DEFAULT 1 CHECK (start_number >= 1),
  next_number  INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);
INSERT OR IGNORE INTO series (doc_type) SELECT code FROM document_types;

-- ★ המסמכים – הקובץ הקבוע.
CREATE TABLE IF NOT EXISTS documents (
  id                  INTEGER PRIMARY KEY,
  doc_type            TEXT    NOT NULL REFERENCES document_types(code),
  number              INTEGER NOT NULL,
  issue_date          TEXT    NOT NULL,      -- YYYY-MM-DD (שעון ישראל)
  created_at          TEXT    NOT NULL,      -- ISO, UTC
  customer_id         INTEGER REFERENCES customers(id),
  customer_snapshot   TEXT    NOT NULL,      -- JSON
  business_snapshot   TEXT    NOT NULL,      -- JSON
  body                TEXT    NOT NULL,      -- JSON: lines, payments, description, related, reason...
  total_agorot        INTEGER NOT NULL,      -- סכום המסמך באגורות
  content_hash        TEXT    NOT NULL,
  prev_hash           TEXT,                  -- hash המסמך הקודם באותה סדרה
  status              TEXT    NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  cancelled_at        TEXT,
  cancel_reason       TEXT,
  original_produced_at TEXT,                 -- מתי הופק "מקור" (פעם אחת בלבד)
  original_delivery   TEXT,                  -- JSON: איך ומתי נמסר המקור (דואר/יד)
  UNIQUE (doc_type, number)
);

-- אין מחיקה – לעולם.
CREATE TRIGGER IF NOT EXISTS documents_no_delete
BEFORE DELETE ON documents
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: documents are permanent (קובץ קבוע) – delete is not allowed');
END;

-- מספר המסמך חייב להיות בדיוק המספר הבא בסדרה, ותאריך לא מוקדם מהמסמך הקודם בסדרה.
CREATE TRIGGER IF NOT EXISTS documents_number_sequence
BEFORE INSERT ON documents
WHEN NEW.number IS NOT (SELECT next_number FROM series WHERE doc_type = NEW.doc_type)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: document number must be the next number in its series');
END;

CREATE TRIGGER IF NOT EXISTS documents_date_order
BEFORE INSERT ON documents
WHEN NEW.issue_date < (SELECT MAX(issue_date) FROM documents WHERE doc_type = NEW.doc_type)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: issue date earlier than the previous document in the series');
END;

CREATE TRIGGER IF NOT EXISTS documents_advance_series
AFTER INSERT ON documents
BEGIN
  UPDATE series SET next_number = next_number + 1 WHERE doc_type = NEW.doc_type;
END;

-- תוכן המסמך אינו ניתן לשינוי (הוראה 23(ב)).
CREATE TRIGGER IF NOT EXISTS documents_immutable
BEFORE UPDATE ON documents
WHEN NEW.id                IS NOT OLD.id
  OR NEW.doc_type          IS NOT OLD.doc_type
  OR NEW.number            IS NOT OLD.number
  OR NEW.issue_date        IS NOT OLD.issue_date
  OR NEW.created_at        IS NOT OLD.created_at
  OR NEW.customer_id       IS NOT OLD.customer_id
  OR NEW.customer_snapshot IS NOT OLD.customer_snapshot
  OR NEW.business_snapshot IS NOT OLD.business_snapshot
  OR NEW.body              IS NOT OLD.body
  OR NEW.total_agorot      IS NOT OLD.total_agorot
  OR NEW.content_hash      IS NOT OLD.content_hash
  OR NEW.prev_hash         IS NOT OLD.prev_hash
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: an issued document cannot be edited – issue a credit note instead');
END;

-- ביטול: רק issued→cancelled, ורק לפני שהופק "מקור" (הוראה 23א(1)).
CREATE TRIGGER IF NOT EXISTS documents_cancel_rules
BEFORE UPDATE ON documents
WHEN (NEW.status IS NOT OLD.status
      OR NEW.cancelled_at IS NOT OLD.cancelled_at
      OR NEW.cancel_reason IS NOT OLD.cancel_reason)
 AND NOT (OLD.status = 'issued' AND NEW.status = 'cancelled'
          AND OLD.original_produced_at IS NULL AND NEW.original_produced_at IS NULL
          AND NEW.cancelled_at IS NOT NULL AND NEW.cancel_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: a document can be cancelled only once, with a reason, before its original was produced');
END;

-- "מקור" מופק פעם אחת בלבד (נספח ה(א)(4)); לא על מסמך מבוטל.
CREATE TRIGGER IF NOT EXISTS documents_original_once
BEFORE UPDATE OF original_produced_at ON documents
WHEN NEW.original_produced_at IS NOT OLD.original_produced_at
 AND (OLD.original_produced_at IS NOT NULL OR OLD.status <> 'issued')
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: the original can be produced only once');
END;

-- אופן מסירת המקור נרשם פעם אחת, ורק אחרי שהמקור הופק.
CREATE TRIGGER IF NOT EXISTS documents_delivery_once
BEFORE UPDATE OF original_delivery ON documents
WHEN NEW.original_delivery IS NOT OLD.original_delivery
 AND (OLD.original_delivery IS NOT NULL OR OLD.original_produced_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: original delivery can be recorded once, after the original was produced');
END;

-- סדרות: מותר לקבוע מספר התחלה רק לפני המסמך הראשון בסדרה (המשך מפנקס קודם, 18(א)(3)).
CREATE TRIGGER IF NOT EXISTS series_guard
BEFORE UPDATE ON series
WHEN EXISTS (SELECT 1 FROM documents WHERE doc_type = OLD.doc_type)
 AND (NEW.start_number IS NOT OLD.start_number OR NEW.next_number IS NOT OLD.next_number + 1)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: series numbering is locked once documents exist');
END;

CREATE TRIGGER IF NOT EXISTS series_no_delete
BEFORE DELETE ON series
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: series cannot be deleted');
END;

-- לקוח שיש לו מסמכים אינו נמחק.
CREATE TRIGGER IF NOT EXISTS customers_no_delete_with_docs
BEFORE DELETE ON customers
WHEN EXISTS (SELECT 1 FROM documents WHERE customer_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: customer has documents');
END;

-- גרסאות פרטי העסק – append-only.
CREATE TRIGGER IF NOT EXISTS business_profile_no_update
BEFORE UPDATE ON business_profile_versions
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: business profile versions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS business_profile_no_delete
BEFORE DELETE ON business_profile_versions
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: business profile versions are append-only');
END;

-- ★ הוצאות / תשלומים – חלק מספר התקבולים והתשלומים (הוראה 12) ותיק תיעוד חוץ.
--   append-only: תיקון רק ברישום נגדי (reverses_id), הוראה 23(א)(2).
CREATE TABLE IF NOT EXISTS expenses (
  id                 INTEGER PRIMARY KEY,
  entry_number       INTEGER NOT NULL UNIQUE,       -- מספר רישום עוקב
  recorded_at        TEXT    NOT NULL,
  expense_date       TEXT    NOT NULL,              -- תאריך מסמך הספק / התשלום
  supplier_name      TEXT    NOT NULL,
  supplier_id_number TEXT,
  doc_kind           TEXT    NOT NULL,              -- receipt / invoice / tax_invoice / tax_invoice_receipt / other
  doc_number         TEXT,
  description        TEXT    NOT NULL,
  category           TEXT    NOT NULL,
  amount_agorot      INTEGER NOT NULL,              -- שלילי ברישום נגדי
  payment_method     TEXT    NOT NULL,
  column_kind        TEXT    NOT NULL DEFAULT 'regular' CHECK (column_kind IN ('regular', 'asset', 'deposit')),
  attachment         TEXT,                          -- JSON: {file, sha256, name, type}
  reverses_id        INTEGER REFERENCES expenses(id),
  reverse_reason     TEXT,
  notes              TEXT,
  content_hash       TEXT    NOT NULL,
  prev_hash          TEXT
);
CREATE TRIGGER IF NOT EXISTS expenses_number_sequence
BEFORE INSERT ON expenses
WHEN NEW.entry_number IS NOT (SELECT COALESCE(MAX(entry_number), 0) + 1 FROM expenses)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: expense entry number must be the next number');
END;
CREATE TRIGGER IF NOT EXISTS expenses_no_update
BEFORE UPDATE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: recorded expenses cannot be edited – record a reversing entry');
END;
CREATE TRIGGER IF NOT EXISTS expenses_no_delete
BEFORE DELETE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: recorded expenses cannot be deleted – record a reversing entry');
END;

-- ★ הכנסות שאינן ממסמכים שהעסק הפיק: פיצויים, מענקים, תשלומי ביטוח לאומי. append-only.
--   kind: compensation / grant  → נכללים במחזור העסק הזעיר (תקנות התשפ"ו-2025, ס' 87ז) ובספר התקבולים.
--         nii_reserve / nii_maternity → לא במחזור; שדה נפרד בדיווח המקוצר.
CREATE TABLE IF NOT EXISTS other_income (
  id            INTEGER PRIMARY KEY,
  entry_number  INTEGER NOT NULL UNIQUE,
  recorded_at   TEXT    NOT NULL,
  income_date   TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('compensation', 'grant', 'nii_reserve', 'nii_maternity')),
  payer         TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  amount_agorot INTEGER NOT NULL,
  reference     TEXT,
  reverses_id   INTEGER REFERENCES other_income(id),
  reverse_reason TEXT,
  content_hash  TEXT    NOT NULL,
  prev_hash     TEXT
);
CREATE TRIGGER IF NOT EXISTS other_income_sequence
BEFORE INSERT ON other_income
WHEN NEW.entry_number IS NOT (SELECT COALESCE(MAX(entry_number), 0) + 1 FROM other_income)
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: entry number must be the next number');
END;
CREATE TRIGGER IF NOT EXISTS other_income_no_update
BEFORE UPDATE ON other_income
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: recorded income cannot be edited – record a reversing entry');
END;
CREATE TRIGGER IF NOT EXISTS other_income_no_delete
BEFORE DELETE ON other_income
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: recorded income cannot be deleted – record a reversing entry');
END;

-- ★ יומן גיבויים – append-only (הוראה 25(ו)(2): גיבוי רבעוני, במקום נפרד בישראל).
CREATE TABLE IF NOT EXISTS backups_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('external', 'local')),
  path        TEXT NOT NULL,
  doc_count   INTEGER NOT NULL,
  verified_ok INTEGER NOT NULL,
  details     TEXT
);
CREATE TRIGGER IF NOT EXISTS backups_log_no_update
BEFORE UPDATE ON backups_log
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: backups log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS backups_log_no_delete
BEFORE DELETE ON backups_log
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: backups log is append-only');
END;

-- ★ יומן אירועים (LOG) – append-only, משורשר ב-hash.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  action    TEXT NOT NULL,           -- document.issue / document.original / document.copy / document.cancel / ...
  entity    TEXT,
  entity_id INTEGER,
  details   TEXT,                    -- JSON
  prev_hash TEXT,
  hash      TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: audit log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: audit log is append-only');
END;
`;

  // src/core/util.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function sha256Bytes(data) {
    const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
    const bitLen = data.length * 8;
    const padded = new Uint8Array(data.length + 9 + 63 >> 6 << 6);
    padded.set(data);
    padded[data.length] = 128;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = (w[i - 15] >>> 7 | w[i - 15] << 25) ^ (w[i - 15] >>> 18 | w[i - 15] << 14) ^ w[i - 15] >>> 3;
        const s1 = (w[i - 2] >>> 17 | w[i - 2] << 15) ^ (w[i - 2] >>> 19 | w[i - 2] << 13) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const ch = e & f ^ ~e & g;
        const t1 = hh + S1 + ch + K[i] + w[i] >>> 0;
        const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h[0] = h[0] + a >>> 0;
      h[1] = h[1] + b >>> 0;
      h[2] = h[2] + c >>> 0;
      h[3] = h[3] + d >>> 0;
      h[4] = h[4] + e >>> 0;
      h[5] = h[5] + f >>> 0;
      h[6] = h[6] + g >>> 0;
      h[7] = h[7] + hh >>> 0;
    }
    return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function todayIL(now = /* @__PURE__ */ new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
  }
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function canonicalJson(value) {
    return JSON.stringify(sortKeys(value));
  }
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])
      );
    }
    return v;
  }
  function sha256(text) {
    return sha256Bytes(new TextEncoder().encode(text));
  }
  function formatShekels(agorot) {
    const sign = agorot < 0 ? "-" : "";
    const abs = Math.abs(agorot);
    const s = (abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign}${s} ₪`;
  }
  var isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

  // src/core/audit.ts
  function appendAudit(db2, action, entity, entityId, details = {}) {
    const prev = db2.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
    const at = nowIso();
    const prevHash = prev?.hash ?? null;
    const hash = sha256(canonicalJson({ at, action, entity, entityId, details, prevHash }));
    db2.prepare(
      "INSERT INTO audit_log (at, action, entity, entity_id, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(at, action, entity, entityId, canonicalJson(details), prevHash, hash);
  }
  function verifyAuditChain(db2) {
    const rows = db2.prepare("SELECT * FROM audit_log ORDER BY id").all();
    const broken = [];
    let prevHash = null;
    for (const r of rows) {
      const expected = sha256(canonicalJson({
        at: r.at,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        details: JSON.parse(r.details),
        prevHash
      }));
      if (r.prev_hash !== prevHash || r.hash !== expected) broken.push(r.id);
      prevHash = r.hash;
    }
    return { ok: broken.length === 0, brokenIds: broken };
  }

  // src/db/tx.ts
  function inTransaction(db2, fn) {
    db2.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db2.exec("COMMIT");
      return result;
    } catch (err) {
      db2.exec("ROLLBACK");
      throw err;
    }
  }

  // src/core/entities.ts
  function setBusinessProfile(db2, profile) {
    if (!profile.name?.trim()) throw new Error("שם העסק חובה");
    if (!profile.idNumber?.trim()) throw new Error("מספר זהות / עוסק חובה (הוראה 5(א)(2))");
    if (!profile.address?.trim()) throw new Error("מען העסק חובה (הוראה 9(א)(1))");
    if (profile.status !== "exempt") throw new Error("כרגע נתמך רק עוסק פטור");
    inTransaction(db2, () => {
      db2.prepare("INSERT INTO business_profile_versions (created_at, data) VALUES (?, ?)").run(nowIso(), JSON.stringify(profile));
      appendAudit(db2, "business.profile", "business", null, { name: profile.name });
    });
  }
  function getBusinessProfile(db2) {
    const row = db2.prepare("SELECT data FROM business_profile_versions ORDER BY id DESC LIMIT 1").get();
    return row ? JSON.parse(row.data) : null;
  }
  function createCustomer(db2, c) {
    if (!c.name?.trim()) throw new Error("שם הלקוח חובה");
    return inTransaction(db2, () => {
      const now = nowIso();
      const r = db2.prepare(
        "INSERT INTO customers (name, id_number, address, email, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(c.name.trim(), c.idNumber ?? null, c.address ?? null, c.email ?? null, c.phone ?? null, now, now);
      const id = Number(r.lastInsertRowid);
      appendAudit(db2, "customer.create", "customer", id, { name: c.name });
      return { id, ...c };
    });
  }
  function updateCustomer(db2, id, c) {
    if (!c.name?.trim()) throw new Error("שם הלקוח חובה");
    inTransaction(db2, () => {
      const r = db2.prepare(
        "UPDATE customers SET name = ?, id_number = ?, address = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?"
      ).run(c.name.trim(), c.idNumber ?? null, c.address ?? null, c.email ?? null, c.phone ?? null, nowIso(), id);
      if (r.changes !== 1) throw new Error(`לקוח ${id} לא נמצא`);
      appendAudit(db2, "customer.update", "customer", id, { name: c.name });
    });
  }
  function getCustomer(db2, id) {
    const r = db2.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    return r ? { id: r.id, name: r.name, idNumber: r.id_number, address: r.address, email: r.email, phone: r.phone } : null;
  }

  // src/core/params.ts
  var PARAMS = {
    /** תוספת י"א 2(ג)(5): חשבונית לכל שירות בסכום זה ומעלה. ערכי תשע"ה – [לאמת הצמדה]. */
    invoiceRequiredFromAgorot: [
      { from: "2015-01-01", value: 21e3, source: 'הוראות 1973, תוספת י"א 2(ג)(5)' }
    ],
    /** חוק לצמצום השימוש במזומן: עסקה מעל התקרה – מזומן עד min(10%, התקרה). */
    cashLimitBusinessAgorot: [
      { from: "2022-08-01", value: 6e5, source: "חוק לצמצום השימוש במזומן, ס' 2" }
    ],
    cashLimitPercent: [
      { from: "2019-01-01", value: 10, source: "חוק לצמצום השימוש במזומן, ס' 2" }
    ],
    /** תקרת מחזור לעוסק פטור (חוק מע"מ ס' 1) = תקרת בעל עסק זעיר. */
    exemptDealerCeilingAgorot: [
      { from: "2025-01-01", value: 12e6, source: "מקורות משניים (2025) – לאמת" },
      { from: "2026-01-01", value: 12283300, source: 'רשות המסים, ש"ות רפורמת בעל עסק זעיר (נקרא 17.11.2026)' }
    ],
    /** בעל עסק זעיר: הוצאות מוכרות אוטומטית = 30% מהמחזור (פקודת מס הכנסה 87ב–87ז). */
    smallBusinessDeemedExpensePercent: [
      { from: "2024-01-01", value: 30, source: "רשות המסים, דיווח שנתי מקוצר לעסק זעיר" }
    ]
  };
  function paramAt(series, date) {
    const applicable = series.filter((p) => p.from <= date).sort((a, b) => a.from < b.from ? 1 : -1);
    if (applicable.length === 0) throw new Error(`אין ערך פרמטר בתוקף לתאריך ${date}`);
    return applicable[0].value;
  }

  // src/core/documents.ts
  var DOC_TYPE_NAMES = {
    order: "הזמנה",
    invoice: "חשבונית עסקה",
    invoice_receipt: "חשבונית עסקה/קבלה",
    receipt: "קבלה",
    credit: "הודעת זיכוי"
  };
  var ValidationError = class extends Error {
    errors;
    warnings;
    constructor(errors, warnings) {
      super(errors.length ? errors.join("; ") : `נדרש אישור לאזהרות: ${warnings.join("; ")}`);
      this.errors = errors;
      this.warnings = warnings;
    }
  };
  var sumLines = (lines) => lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPriceAgorot), 0);
  var sumPayments = (p) => p.reduce((s, x) => s + x.amountAgorot, 0);
  function getDoc(db2, id) {
    return db2.prepare("SELECT * FROM documents WHERE id = ?").get(id) ?? null;
  }
  function validateIssue(db2, input, customer) {
    const errors = [];
    const warnings = [];
    const t = input.type;
    const issueDate = input.issueDate ?? todayIL();
    const lines = input.lines ?? [];
    const payments = input.payments ?? [];
    const withholding = input.withholdingAgorot ?? 0;
    if (!(t in DOC_TYPE_NAMES)) errors.push(`סוג מסמך לא מוכר: ${t}. (חשבונית מס אסורה לעוסק פטור – חוק מע"מ 50(א))`);
    if (!isIsoDate(issueDate)) errors.push("תאריך לא תקין");
    else if (issueDate > todayIL()) errors.push("אי אפשר להפיק מסמך בתאריך עתידי (הוראה 17(א))");
    if (!customer?.name?.trim()) errors.push("שם הלקוח / המשלם חובה (5(א)(4), 9(א)(4))");
    if (customer && !customer.address?.trim() && t !== "credit")
      warnings.push("לא צוין מען הלקוח. מותר רק אם המען ידוע לך (5(א)(4), 9(א)(4))");
    const needsLines = t === "invoice" || t === "invoice_receipt";
    if (needsLines && lines.length === 0) errors.push("חשבונית חייבת לפחות שורת שירות אחת");
    lines.forEach((l, i) => {
      if (!l.description?.trim()) errors.push(`שורה ${i + 1}: תיאור השירות חובה (9(א)(5))`);
      if (!(l.quantity > 0)) errors.push(`שורה ${i + 1}: כמות חייבת להיות חיובית`);
      if (!l.unit?.trim()) errors.push(`שורה ${i + 1}: יחידת מידה חובה (9(א)(6))`);
      if (!Number.isInteger(l.unitPriceAgorot) || l.unitPriceAgorot < 0) errors.push(`שורה ${i + 1}: מחיר ליחידה לא תקין`);
    });
    const needsPayments = t === "receipt" || t === "invoice_receipt";
    if (needsPayments && payments.length === 0) errors.push("יש לפרט לפחות אמצעי תשלום אחד");
    if (!needsPayments && payments.length > 0) errors.push(`למסמך מסוג ${DOC_TYPE_NAMES[t]} לא מצרפים תשלומים`);
    if (!Number.isInteger(withholding) || withholding < 0) errors.push("ניכוי במקור לא תקין");
    if (withholding > 0 && !needsPayments) errors.push("ניכוי במקור רלוונטי רק לקבלה / חשבונית-קבלה");
    payments.forEach((p, i) => {
      const n = `תשלום ${i + 1}`;
      if (!Number.isInteger(p.amountAgorot) || p.amountAgorot <= 0) errors.push(`${n}: סכום לא תקין`);
      if (!isIsoDate(p.date)) errors.push(`${n}: תאריך לא תקין`);
      if (p.method === "cheque") {
        const c = p.cheque;
        if (!c?.number?.trim() || !c?.bank?.trim() || !c?.branch?.trim() || !isIsoDate(c?.dueDate))
          errors.push(`${n}: בשיק חובה מספר שיק, בנק, סניף ותאריך פירעון (5(ב))`);
        if (c?.endorser && (!c.endorser.name?.trim() || !c.endorser.idNumber?.trim()))
          errors.push(`${n}: בשיק מוסב חובה שם ות"ז המסב (חוק המזומן)`);
      }
      if (p.method === "credit_card" && !/^\d{4}$/.test(p.card?.last4 ?? "")) errors.push(`${n}: 4 ספרות אחרונות של הכרטיס`);
      if (p.method === "app" && !p.app?.name?.trim()) errors.push(`${n}: שם האפליקציה (Bit / PayBox...)`);
      if (p.method === "other" && !p.other?.description?.trim()) errors.push(`${n}: תיאור אמצעי התשלום`);
    });
    if (t === "receipt" && !input.description?.trim())
      errors.push("בקבלה חובה לציין את מהות התקבול (5(א)(6))");
    if (t === "order" && !input.description?.trim() && lines.length === 0)
      errors.push('בהזמנה חובה לתאר את השירות המוזמן (תוספת י"א 2(ג)(4))');
    let total = 0;
    if (t === "invoice" || t === "invoice_receipt" || t === "order") total = sumLines(lines);
    if (t === "receipt") total = sumPayments(payments) + withholding;
    if (t === "invoice_receipt" && sumPayments(payments) + withholding !== total)
      errors.push(`בחשבונית-קבלה סכום התשלומים (${formatShekels(sumPayments(payments) + withholding)}) חייב להיות שווה לסכום החשבונית (${formatShekels(total)})`);
    if ((t === "invoice" || t === "invoice_receipt" || t === "receipt") && total <= 0) errors.push("סכום המסמך חייב להיות חיובי");
    const related = (input.relatedDocumentIds ?? []).map((id) => ({ id, doc: getDoc(db2, id) }));
    for (const r of related) {
      if (!r.doc) errors.push(`מסמך קשור ${r.id} לא נמצא`);
      else if (r.doc.status !== "issued") errors.push(`מסמך קשור ${r.id} מבוטל`);
    }
    if (t === "credit") {
      const invoices = related.filter((r) => r.doc && ["invoice", "invoice_receipt"].includes(r.doc.doc_type));
      if (invoices.length === 0 || invoices.length !== related.length)
        errors.push("הודעת זיכוי חייבת להתייחס לחשבונית אחת או יותר (9(ה)(4))");
      if (!input.reason?.trim()) errors.push("בהודעת זיכוי חובה לציין את הסיבה (9(ה)(5))");
      if (!input.lines?.length && !input.description) errors.push("יש לפרט את סכום הזיכוי (שורות)");
      total = sumLines(lines);
      if (total <= 0) errors.push("סכום הזיכוי חייב להיות חיובי");
      const invoicedTotal = invoices.reduce((s, r) => s + r.doc.total_agorot, 0);
      const alreadyCredited = invoices.reduce((s, r) => s + creditedAgainst(db2, r.id), 0);
      if (total > invoicedTotal - alreadyCredited)
        errors.push(`סכום הזיכוי עולה על יתרת החשבוניות (${formatShekels(invoicedTotal - alreadyCredited)}) (23א)`);
    }
    if (t === "receipt" && isIsoDate(issueDate)) {
      const threshold = paramAt(PARAMS.invoiceRequiredFromAgorot, issueDate);
      const hasInvoice = related.some((r) => r.doc?.doc_type === "invoice");
      if (total >= threshold && !hasInvoice)
        warnings.push(`תקבול של ${formatShekels(total)} ללא חשבונית מקושרת. לשירות מ-${formatShekels(threshold)} נדרשת חשבונית (תוספת י"א) – שקול "חשבונית עסקה/קבלה"`);
    }
    const cash = payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amountAgorot, 0);
    if (cash > 0 && isIsoDate(issueDate)) {
      const limit = paramAt(PARAMS.cashLimitBusinessAgorot, issueDate);
      const pct = paramAt(PARAMS.cashLimitPercent, issueDate);
      const txTotal = t === "receipt" ? total : total;
      if (txTotal > limit) {
        const allowed = Math.min(limit, Math.floor(txTotal * pct / 100));
        if (cash > allowed)
          warnings.push(`מזומן ${formatShekels(cash)} בעסקה של ${formatShekels(txTotal)} – מעל המותר (${formatShekels(allowed)}) לפי חוק לצמצום השימוש במזומן`);
      }
    }
    return { errors, warnings, total, issueDate };
  }
  function creditedAgainst(db2, invoiceId) {
    const rows = db2.prepare("SELECT body, total_agorot FROM documents WHERE doc_type = 'credit' AND status = 'issued'").all();
    return rows.filter((r) => (JSON.parse(r.body).relatedDocumentIds ?? []).includes(invoiceId)).reduce((s, r) => s + r.total_agorot, 0);
  }
  function contentHashOf(row) {
    return sha256(canonicalJson({
      doc_type: row.doc_type,
      number: row.number,
      issue_date: row.issue_date,
      created_at: row.created_at,
      customer_snapshot: row.customer_snapshot,
      business_snapshot: row.business_snapshot,
      body: row.body,
      total_agorot: row.total_agorot,
      prev_hash: row.prev_hash
    }));
  }
  function issueDocument(db2, input) {
    const business = getBusinessProfile(db2);
    if (!business) throw new ValidationError(["יש להגדיר את פרטי העסק לפני הפקת מסמכים"], []);
    let customer = null;
    if (input.customerId != null) {
      const c = getCustomer(db2, input.customerId);
      if (!c) throw new ValidationError([`לקוח ${input.customerId} לא נמצא`], []);
      customer = { name: c.name, idNumber: c.idNumber ?? null, address: c.address ?? null };
    } else if (input.customer) {
      customer = { name: input.customer.name, idNumber: input.customer.idNumber ?? null, address: input.customer.address ?? null };
    }
    const v = validateIssue(db2, input, customer);
    if (v.errors.length) throw new ValidationError(v.errors, v.warnings);
    if (v.warnings.length && !input.acknowledgeWarnings) throw new ValidationError([], v.warnings);
    const body = canonicalJson({
      lines: input.lines ?? [],
      payments: input.payments ?? [],
      withholdingAgorot: input.withholdingAgorot ?? 0,
      description: input.description ?? null,
      relatedDocumentIds: input.relatedDocumentIds ?? [],
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      acknowledgedWarnings: v.warnings
    });
    return inTransaction(db2, () => {
      const series = db2.prepare("SELECT next_number FROM series WHERE doc_type = ?").get(input.type);
      const prev = db2.prepare("SELECT content_hash FROM documents WHERE doc_type = ? ORDER BY number DESC LIMIT 1").get(input.type);
      const row = {
        doc_type: input.type,
        number: series.next_number,
        issue_date: v.issueDate,
        created_at: nowIso(),
        customer_snapshot: canonicalJson(customer),
        business_snapshot: canonicalJson(business),
        body,
        total_agorot: v.total,
        prev_hash: prev?.content_hash ?? null
      };
      const content_hash = contentHashOf(row);
      const r = db2.prepare(`INSERT INTO documents
      (doc_type, number, issue_date, created_at, customer_id, customer_snapshot, business_snapshot, body, total_agorot, content_hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.doc_type,
        row.number,
        row.issue_date,
        row.created_at,
        input.customerId ?? null,
        row.customer_snapshot,
        row.business_snapshot,
        row.body,
        row.total_agorot,
        content_hash,
        row.prev_hash
      );
      const id = Number(r.lastInsertRowid);
      appendAudit(db2, "document.issue", "document", id, {
        type: row.doc_type,
        number: row.number,
        total: row.total_agorot,
        warnings: v.warnings
      });
      return { document: getDoc(db2, id), warnings: v.warnings };
    });
  }
  function produceOutput(db2, id, kind, purpose = "print") {
    return inTransaction(db2, () => {
      const doc = getDoc(db2, id);
      if (!doc) throw new Error(`מסמך ${id} לא נמצא`);
      if (kind === "original") {
        if (doc.status === "cancelled") throw new Error("אי אפשר להפיק מקור למסמך מבוטל");
        if (doc.original_produced_at) throw new Error(`המקור הופק כבר ב-${doc.original_produced_at}. ניתן להפיק העתק בלבד`);
        db2.prepare("UPDATE documents SET original_produced_at = ? WHERE id = ?").run(nowIso(), id);
        appendAudit(db2, "document.original", "document", id, { purpose });
        return { label: "מקור", document: getDoc(db2, id) };
      }
      appendAudit(db2, "document.copy", "document", id, { purpose });
      return { label: "העתק", document: doc };
    });
  }
  function recordOriginalDelivery(db2, id, delivery) {
    if (!isIsoDate(delivery.date)) throw new Error("תאריך מסירה לא תקין");
    inTransaction(db2, () => {
      db2.prepare("UPDATE documents SET original_delivery = ? WHERE id = ?").run(canonicalJson(delivery), id);
      appendAudit(db2, "document.delivery", "document", id, delivery);
    });
  }
  function cancelDocument(db2, id, reason) {
    if (!reason?.trim()) throw new Error("חובה לציין סיבת ביטול");
    inTransaction(db2, () => {
      const doc = getDoc(db2, id);
      if (!doc) throw new Error(`מסמך ${id} לא נמצא`);
      const sent = db2.prepare(
        "SELECT 1 FROM audit_log WHERE action = 'document.copy' AND entity_id = ? AND json_extract(details, '$.purpose') = 'sent' LIMIT 1"
      ).get(id);
      if (doc.original_produced_at || sent)
        throw new Error("המסמך כבר יצא ללקוח – אין לבטל. יש להפיק הודעת זיכוי (הוראה 23א(2))");
      db2.prepare("UPDATE documents SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(nowIso(), reason.trim(), id);
      appendAudit(db2, "document.cancel", "document", id, { reason });
    });
  }
  function setSeriesStart(db2, type, start) {
    if (!Number.isInteger(start) || start < 1) throw new Error("מספר התחלה לא תקין");
    inTransaction(db2, () => {
      db2.prepare("UPDATE series SET start_number = ?, next_number = ? WHERE doc_type = ?").run(start, start, type);
      appendAudit(db2, "series.start", "series", null, { type, start });
    });
  }

  // src/core/reports.ts
  function continuityReport(db2) {
    const series = db2.prepare("SELECT doc_type, start_number, next_number FROM series ORDER BY doc_type").all();
    return series.map((s) => {
      const docs = db2.prepare("SELECT * FROM documents WHERE doc_type = ? ORDER BY number").all(s.doc_type);
      const present = new Set(docs.map((d) => d.number));
      const missing = [];
      for (let n = s.start_number; n < s.next_number; n++) if (!present.has(n)) missing.push(n);
      const hashErrors = [];
      let prevHash = null;
      for (const d of docs) {
        if (d.prev_hash !== prevHash || contentHashOf(d) !== d.content_hash) hashErrors.push(d.number);
        prevHash = d.content_hash;
      }
      return {
        docType: s.doc_type,
        name: DOC_TYPE_NAMES[s.doc_type],
        startNumber: s.start_number,
        lastNumber: docs.length ? docs[docs.length - 1].number : null,
        count: docs.length,
        missingNumbers: missing,
        cancelledNumbers: docs.filter((d) => d.status === "cancelled").map((d) => d.number),
        hashErrors,
        ok: missing.length === 0 && hashErrors.length === 0
      };
    });
  }
  function customerLedger(db2, customerId) {
    const docs = db2.prepare(
      "SELECT * FROM documents WHERE customer_id = ? AND status = 'issued' AND doc_type <> 'order' ORDER BY issue_date, id"
    ).all(customerId);
    let balance = 0;
    const entries = [];
    for (const d of docs) {
      const debit = d.doc_type === "invoice" || d.doc_type === "invoice_receipt" ? d.total_agorot : 0;
      const credit = d.doc_type === "receipt" || d.doc_type === "invoice_receipt" || d.doc_type === "credit" ? d.total_agorot : 0;
      balance += debit - credit;
      entries.push({ date: d.issue_date, docType: d.doc_type, number: d.number, debit, credit, balance });
    }
    return { entries, balance };
  }
  function customerBalancesAt(db2, date) {
    const customers = db2.prepare("SELECT id, name FROM customers ORDER BY name").all();
    return customers.map((c) => {
      const { entries } = customerLedger(db2, c.id);
      const upto = entries.filter((e) => e.date <= date);
      return { customerId: c.id, name: c.name, balance: upto.length ? upto[upto.length - 1].balance : 0 };
    }).filter((r) => r.balance !== 0);
  }

  // src/render/html.ts
  var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var fmtDate = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  };
  var fmtDateTime = (iso) => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  var PAYMENT_NAMES = {
    cash: "מזומן",
    cheque: "שיק",
    transfer: "העברה בנקאית",
    credit_card: "כרטיס אשראי",
    app: "אפליקציית תשלום",
    other: "אחר"
  };
  function paymentDetails(p) {
    switch (p.method) {
      case "cheque": {
        const c = p.cheque;
        let s = `שיק מס' ${c.number}, בנק ${c.bank}, סניף ${c.branch}${c.account ? `, חשבון ${c.account}` : ""}, לפירעון ${fmtDate(c.dueDate)}`;
        if (c.endorser) s += ` (הוסב ע"י ${c.endorser.name}, ת"ז ${c.endorser.idNumber})`;
        return s;
      }
      case "transfer":
        return [p.transfer.bank && `בנק ${p.transfer.bank}`, p.transfer.reference && `אסמכתה ${p.transfer.reference}`].filter(Boolean).join(", ");
      case "credit_card":
        return `כרטיס המסתיים ב-${p.card.last4}${p.card.approval ? `, אישור ${p.card.approval}` : ""}${p.card.installments && p.card.installments > 1 ? `, ${p.card.installments} תשלומים` : ""}`;
      case "app":
        return `${p.app.name}${p.app.reference ? `, אסמכתה ${p.app.reference}` : ""}`;
      case "other":
        return p.other.description;
      default:
        return "";
    }
  }
  var BASE_CSS = `
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
  function renderDocument(doc, label, relatedDocs = []) {
    const business = JSON.parse(doc.business_snapshot);
    const customer = JSON.parse(doc.customer_snapshot) ?? {};
    const body = JSON.parse(doc.body);
    const lines = body.lines ?? [];
    const payments = body.payments ?? [];
    const t = doc.doc_type;
    const title = DOC_TYPE_NAMES[t];
    const numberText = label === "טיוטה" ? "ללא מספר" : `מס' ${doc.number}`;
    const isCancelled = doc.status === "cancelled";
    const linesTable = lines.length ? `
    <table>
      <thead><tr><th style="width:46%">תיאור השירות</th><th>יחידה</th><th class="num">כמות</th><th class="num">מחיר ליחידה</th><th class="num">סה"כ</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.unit)}</td>
        <td class="num">${esc(l.quantity)}</td><td class="num">${formatShekels(l.unitPriceAgorot)}</td>
        <td class="num">${formatShekels(Math.round(l.quantity * l.unitPriceAgorot))}</td></tr>`).join("")}</tbody>
    </table>` : "";
    const withholding = body.withholdingAgorot ?? 0;
    const paymentsTable = payments.length ? `
    <h3 style="margin:14px 0 0;font-size:11.5pt">פרטי התקבול</h3>
    <table>
      <thead><tr><th>אמצעי תשלום</th><th>פרטים</th><th>תאריך</th><th class="num">סכום</th></tr></thead>
      <tbody>${payments.map((p) => `<tr><td>${PAYMENT_NAMES[p.method]}</td><td>${esc(paymentDetails(p))}</td>
        <td>${fmtDate(p.date)}</td><td class="num">${formatShekels(p.amountAgorot)}</td></tr>`).join("")}
        ${withholding ? `<tr><td colspan="3">ניכוי במקור</td><td class="num">${formatShekels(withholding)}</td></tr>` : ""}
      </tbody>
    </table>` : "";
    const related = relatedDocs.length ? `<p><b>${t === "credit" ? "מתייחסת ל" : "בהתייחס ל"}:</b> ${relatedDocs.map((r) => `${esc(DOC_TYPE_NAMES[r.doc_type])} מס' ${r.number} מיום ${fmtDate(r.issue_date)}`).join("; ")}</p>` : "";
    const totalLabel = t === "receipt" ? 'סה"כ התקבל' : t === "credit" ? 'סה"כ זיכוי' : t === "order" ? 'סה"כ משוער' : 'סה"כ לתשלום';
    const watermark = label === "טיוטה" || isCancelled ? `<div style="position:fixed;top:40%;left:0;right:0;text-align:center;font-size:90pt;color:rgba(200,0,0,.13);transform:rotate(-25deg);font-weight:bold">${isCancelled ? "מבוטל" : "טיוטה"}</div>` : "";
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
      ${business.phone ? `<div>טל' ${esc(business.phone)}</div>` : ""}${business.email ? `<div>${esc(business.email)}</div>` : ""}
    </div>
    <div class="label ${label === "העתק" ? "copy" : label === "טיוטה" ? "draft" : ""}">${label}</div>
  </div>
  <div class="doctitle"><h1>${esc(title)} ${esc(numberText)}</h1><div>תאריך: <b>${fmtDate(doc.issue_date)}</b></div></div>
  ${isCancelled ? `<p style="color:#b00"><b>מסמך מבוטל.</b> סיבה: ${esc(doc.cancel_reason)}</p>` : ""}
  <p><b>${t === "receipt" ? "התקבל מאת" : "לכבוד"}:</b> ${esc(customer.name)}
    ${customer.idNumber ? ` | מזהה: ${esc(customer.idNumber)}` : ""}${customer.address ? ` | ${esc(customer.address)}` : ""}</p>
  ${body.description ? `<p><b>${t === "receipt" ? "עבור" : "תיאור"}:</b> ${esc(body.description)}</p>` : ""}
  ${related}
  ${t === "credit" ? `<p><b>סיבת הזיכוי:</b> ${esc(body.reason)}</p>` : ""}
  ${linesTable}
  <div class="total">${totalLabel}: ${formatShekels(doc.total_agorot)}</div>
  ${paymentsTable}
  ${t === "invoice_receipt" ? '<p style="margin-top:14px"><span class="paid">נפרע</span></p>' : ""}
  <p class="muted" style="margin-top:14px">עוסק פטור – המסמך אינו חשבונית מס ואינו כולל מע"מ.</p>
  ${body.notes ? `<p class="muted">הערות: ${esc(body.notes)}</p>` : ""}
  ${t === "receipt" || t === "invoice_receipt" || t === "credit" ? `<div class="sign"><div>חתימת ${t === "credit" ? "העוסק" : "המקבל"}: ____________________</div>${t === "credit" ? '<div>אישור קבלה ע"י הלקוח: ____________________</div>' : ""}</div>` : ""}
  </body></html>`;
  }
  function renderReport(opts) {
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
  function continuityBody(rows) {
    return `<table><thead><tr><th>סוג מסמך</th><th class="num">ממספר</th><th class="num">עד מספר</th><th class="num">כמות</th>
    <th>מספרים חסרים</th><th>מבוטלים</th><th>שלמות תוכן</th><th>תקין</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.count ? r.startNumber : "-"}</td><td class="num">${r.lastNumber ?? "-"}</td>
      <td class="num">${r.count}</td><td>${r.missingNumbers.length ? r.missingNumbers.join(", ") : "אין"}</td>
      <td>${r.cancelledNumbers.length ? r.cancelledNumbers.join(", ") : "אין"}</td>
      <td>${r.hashErrors.length ? `<b style="color:#b00">שגיאה במסמכים ${r.hashErrors.join(", ")}</b>` : "תקינה"}</td>
      <td>${r.ok ? "✔" : '<b style="color:#b00">✘</b>'}</td></tr>`).join("")}
    </tbody></table>`;
  }
  function journalBody(docs) {
    return `<table><thead><tr><th class="num">#</th><th>סוג</th><th class="num">מספר</th><th>תאריך</th><th>לקוח</th>
    <th class="num">סכום</th><th>סטטוס</th><th>מקור הופק</th></tr></thead><tbody>
    ${docs.map((d) => `<tr><td class="num">${d.id}</td><td>${esc(DOC_TYPE_NAMES[d.doc_type])}</td><td class="num">${d.number}</td>
      <td>${fmtDate(d.issue_date)}</td><td>${esc(JSON.parse(d.customer_snapshot)?.name)}</td>
      <td class="num">${formatShekels(d.total_agorot)}</td><td>${d.status === "cancelled" ? "מבוטל" : "הופק"}</td>
      <td>${d.original_produced_at ? fmtDate(d.original_produced_at) : "-"}</td></tr>`).join("")}
    </tbody></table>`;
  }
  var cell = (v) => v ? formatShekels(v) : "";
  function bookBody(rows, totals) {
    const months = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const k = r.date.slice(0, 7);
      months.set(k, [...months.get(k) ?? [], r]);
    }
    const head = `<tr><th>תאריך</th><th>אסמכתה</th><th>לקוח / ספק</th><th>פרטים</th><th class="num">תקבולים</th>
    <th class="num">מזה ניכוי במקור</th><th class="num">תשלומים</th><th class="num">רכישת נכסים</th><th class="num">פיקדונות</th></tr>`;
    const sumRow = (label, rs) => {
      const s = (k) => rs.reduce((a, r) => a + r[k], 0);
      return `<tr><th colspan="4">${label}</th><th class="num">${cell(s("receipt"))}</th><th class="num">${cell(s("withholding"))}</th>
      <th class="num">${cell(s("payment"))}</th><th class="num">${cell(s("asset"))}</th><th class="num">${cell(s("deposit"))}</th></tr>`;
    };
    let body = "";
    for (const [month, rs] of months) {
      body += rs.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.ref)}</td><td>${esc(r.name)}</td><td>${esc(r.description)}</td>
      <td class="num">${cell(r.receipt)}</td><td class="num">${cell(r.withholding)}</td><td class="num">${cell(r.payment)}</td>
      <td class="num">${cell(r.asset)}</td><td class="num">${cell(r.deposit)}</td></tr>`).join("");
      body += sumRow(`סה"כ ${month.slice(5)}/${month.slice(0, 4)}`, rs);
    }
    if (!rows.length) return "<p>אין תקבולים או תשלומים בתקופה.</p>";
    return `<table style="font-size:9pt"><thead>${head}</thead><tbody>${body}
    <tr><th colspan="4">סה"כ לתקופה</th><th class="num">${cell(totals.receipt)}</th><th class="num">${cell(totals.withholding)}</th>
    <th class="num">${cell(totals.payment)}</th><th class="num">${cell(totals.asset)}</th><th class="num">${cell(totals.deposit)}</th></tr></tbody></table>`;
  }
  function annualSummaryBody(s) {
    return `<h3>נתונים לדיווחים השנתיים</h3><table><tbody>
    <tr><th>מחזור עסקאות ${s.year}</th><th class="num">${formatShekels(s.turnover)}</th></tr>
    <tr><td>← להצהרת עוסק פטור למע"מ (עד 31.1.${s.year + 1}) ולדיווח המקוצר של עסק זעיר</td><td></td></tr>
    <tr><td>הכנסה חייבת בעסק זעיר (${100 - s.deemedPct}% מהמחזור – חישוב מערכת רשות המסים)</td><td class="num">${formatShekels(s.smallBusinessTaxable)}</td></tr>
    <tr><td>ניכוי במקור לדיווח (יש לצרף אישורי ניכוי מהלקוחות)</td><td class="num">${formatShekels(s.withholding)}</td></tr>
    ${s.niiReserve ? `<tr><td>דמי מילואים מביטוח לאומי – לשדה הייעודי בדיווח המקוצר (לא במחזור)</td><td class="num">${formatShekels(s.niiReserve)}</td></tr>` : ""}
    ${s.niiMaternity ? `<tr><td>דמי לידה מביטוח לאומי – לשדה הייעודי בדיווח המקוצר (לא במחזור)</td><td class="num">${formatShekels(s.niiMaternity)}</td></tr>` : ""}
  </tbody></table>
  <p class="muted">מחזור = חשבוניות נטו אחרי זיכויים + קבלות שאינן מקושרות לחשבונית + פיצויים בעד נזק עקיף ומענקי רשות המסים
    (${formatShekels(s.compensationInTurnover)}; תקנות מס הכנסה התשפ"ו-2025 לפי ס' 87ז). דמי מילואים ודמי לידה מביטוח לאומי אינם חלק מהמחזור.</p>
  <h3>תקבולים והוצאות</h3><table><tbody>
    <tr><td>תקבולים (ברוטו, כולל ניכוי במקור)</td><td class="num">${formatShekels(s.receipts)}</td></tr>
    <tr><td>מזה ניכוי במקור (ניתן לקיזוז מהמס)</td><td class="num">${formatShekels(s.withholding)}</td></tr>
    <tr><td>חשבוניות שהוצאו (נטו אחרי זיכויים)</td><td class="num">${formatShekels(s.invoicedNet)}</td></tr>
    <tr><td>הוצאות שוטפות</td><td class="num">${formatShekels(s.expensesRegular)}</td></tr>
    <tr><th>הפרש תקבולים פחות הוצאות שוטפות</th><th class="num">${formatShekels(s.netBeforeAdjustments)}</th></tr>
  </tbody></table>
  <h3>הוצאות שוטפות לפי קטגוריה</h3>
  ${s.byCategory.length ? `<table><tbody>${s.byCategory.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${formatShekels(c.total)}</td></tr>`).join("")}</tbody></table>` : "<p>אין.</p>"}
  <h3>רכישת נכסים (פחת – לא נכלל בהוצאות השוטפות)</h3>
  ${s.assetList.length ? `<table><tbody>${s.assetList.map((a) => `<tr><td>${fmtDate(a.expense_date)}</td><td>${esc(a.supplier_name)}</td><td>${esc(a.description)}</td><td class="num">${formatShekels(a.amount_agorot)}</td></tr>`).join("")}</tbody></table>` : "<p>אין.</p>"}
  <p class="muted" style="margin-top:14px">הסיכום מבוסס על רישומי פנקס בלבד ואינו חישוב מס. הכרה בהוצאות, פחת על נכסים ובסיס הדיווח – לפי כללי מס הכנסה; מומלץ לבדוק מול מקור מוסמך.</p>`;
  }
  function balancesBody(rows) {
    if (!rows.length) return "<p>אין יתרות פתוחות.</p>";
    return `<table><thead><tr><th>לקוח</th><th class="num">יתרה (חוב הלקוח)</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${formatShekels(r.balance)}</td></tr>`).join("")}
    <tr><th>סה"כ</th><th class="num">${formatShekels(rows.reduce((s, r) => s + r.balance, 0))}</th></tr></tbody></table>`;
  }

  // src/core/expenses.ts
  var EXPENSE_CATEGORIES = [
    "ציוד וחומרים",
    "מחשב, תוכנה ומנויים",
    "טלפון ואינטרנט",
    "נסיעות וחניה",
    "רכב",
    "ספרות והשתלמויות",
    "פרסום ושיווק",
    "שכירות ואחזקת משרד",
    "ביטוחים",
    "עמלות בנק וסליקה",
    "שירותים מקצועיים",
    "כיבוד ואירוח",
    "אחר"
  ];
  var EXPENSE_DOC_KINDS = {
    receipt: "קבלה",
    invoice: "חשבונית עסקה",
    tax_invoice: "חשבונית מס",
    tax_invoice_receipt: "חשבונית מס/קבלה",
    cash_slip: "תלוש קופה",
    other: "מסמך אחר"
  };
  var EXPENSE_PAYMENT_METHODS = {
    credit_card: "כרטיס אשראי",
    transfer: "העברה בנקאית",
    cash: "מזומן",
    cheque: "שיק",
    app: "אפליקציה",
    standing_order: "הוראת קבע",
    other: "אחר"
  };
  var ALLOWED_TYPES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };
  var MAX_ATTACHMENT = 10 * 1024 * 1024;
  function sniffAttachmentType(b) {
    const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
    if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
    if (b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return "image/png";
    if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (b.length >= 12 && ascii(4, 8) === "ftyp" && ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(ascii(8, 12))) return "image/heic";
    return null;
  }
  function recordingDeadline(expenseDate) {
    const [y, m] = expenseDate.split("-").map(Number);
    const endOfMonth = new Date(Date.UTC(y, m, 0));
    return new Date(endOfMonth.getTime() + 30 * 864e5).toISOString().slice(0, 10);
  }
  function hashOf(r) {
    const { recorded_at, ...rest } = r;
    return sha256(canonicalJson({ ...rest, recorded_at }));
  }
  function insertExpense(db2, data) {
    const last = db2.prepare("SELECT entry_number, content_hash FROM expenses ORDER BY entry_number DESC LIMIT 1").get();
    const row = { ...data, entry_number: (last?.entry_number ?? 0) + 1, recorded_at: nowIso(), prev_hash: last?.content_hash ?? null };
    const content_hash = hashOf(row);
    const r = db2.prepare(`INSERT INTO expenses (entry_number, recorded_at, expense_date, supplier_name, supplier_id_number, doc_kind,
      doc_number, description, category, amount_agorot, payment_method, column_kind, attachment, reverses_id, reverse_reason, notes,
      content_hash, prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.entry_number,
      row.recorded_at,
      row.expense_date,
      row.supplier_name,
      row.supplier_id_number,
      row.doc_kind,
      row.doc_number,
      row.description,
      row.category,
      row.amount_agorot,
      row.payment_method,
      row.column_kind,
      row.attachment,
      row.reverses_id,
      row.reverse_reason,
      row.notes,
      content_hash,
      row.prev_hash
    );
    return db2.prepare("SELECT * FROM expenses WHERE id = ?").get(Number(r.lastInsertRowid));
  }
  function recordExpense(db2, input, saveAttachment) {
    const errors = [];
    const warnings = [];
    if (!isIsoDate(input.expenseDate)) errors.push("תאריך ההוצאה לא תקין");
    else if (input.expenseDate > todayIL()) errors.push("תאריך ההוצאה בעתיד");
    if (!input.supplierName?.trim()) errors.push("שם הספק חובה");
    if (!(input.docKind in EXPENSE_DOC_KINDS)) errors.push("סוג מסמך הספק לא תקין");
    if (!input.description?.trim()) errors.push("תיאור ההוצאה חובה");
    if (!EXPENSE_CATEGORIES.includes(input.category)) errors.push("קטגוריה לא תקינה");
    if (!Number.isInteger(input.amountAgorot) || input.amountAgorot <= 0) errors.push("סכום חייב להיות חיובי");
    if (!(input.paymentMethod in EXPENSE_PAYMENT_METHODS)) errors.push("אמצעי תשלום לא תקין");
    const columnKind = input.columnKind ?? "regular";
    if (!["regular", "asset", "deposit"].includes(columnKind)) errors.push("סוג טור לא תקין");
    if (!input.docNumber?.trim()) warnings.push("לא צוין מספר מסמך הספק – מומלץ לציין לצורך איתור התיעוד (הוראה 24)");
    if (isIsoDate(input.expenseDate) && todayIL() > recordingDeadline(input.expenseDate))
      warnings.push(`רישום באיחור: הוצאה מ-${input.expenseDate} הייתה צריכה להירשם עד ${recordingDeadline(input.expenseDate)} (הוראה 20)`);
    let buf = null;
    let attType = null;
    if (input.attachment) {
      try {
        buf = base64ToBytes(input.attachment.base64 ?? "");
      } catch {
        buf = new Uint8Array(0);
      }
      if (buf.length === 0 || buf.length > MAX_ATTACHMENT) errors.push("קובץ מצורף ריק או גדול מ-10MB");
      else {
        attType = sniffAttachmentType(buf);
        if (!attType) errors.push("סוג קובץ לא נתמך: רק PDF / JPG / PNG / WEBP / HEIC (נבדק לפי תוכן הקובץ)");
      }
      if (!saveAttachment) errors.push("שמירת קבצים מצורפים אינה זמינה");
    }
    if (errors.length) throw new ValidationError(errors, warnings);
    if (warnings.length && !input.acknowledgeWarnings) throw new ValidationError([], warnings);
    let attachment = null;
    if (input.attachment && buf && attType && saveAttachment) {
      const hash = sha256Bytes(buf);
      const file = `${hash}.${ALLOWED_TYPES[attType]}`;
      saveAttachment(file, buf);
      attachment = canonicalJson({ file, sha256: hash, name: String(input.attachment.name ?? "").slice(0, 200), type: attType });
    }
    return inTransaction(db2, () => {
      const expense = insertExpense(db2, {
        expense_date: input.expenseDate,
        supplier_name: input.supplierName.trim(),
        supplier_id_number: input.supplierIdNumber?.trim() || null,
        doc_kind: input.docKind,
        doc_number: input.docNumber?.trim() || null,
        description: input.description.trim(),
        category: input.category,
        amount_agorot: input.amountAgorot,
        payment_method: input.paymentMethod,
        column_kind: columnKind,
        attachment,
        reverses_id: null,
        reverse_reason: null,
        notes: input.notes?.trim() || null
      });
      appendAudit(db2, "expense.record", "expense", expense.id, { entry: expense.entry_number, amount: expense.amount_agorot, warnings });
      return { expense, warnings };
    });
  }
  function reverseExpense(db2, id, reason) {
    if (!reason?.trim()) throw new Error("חובה לציין סיבה לרישום הנגדי");
    return inTransaction(db2, () => {
      const orig = db2.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
      if (!orig) throw new Error(`רישום ${id} לא נמצא`);
      if (orig.reverses_id) throw new Error("אי אפשר לבטל רישום נגדי");
      if (db2.prepare("SELECT 1 FROM expenses WHERE reverses_id = ?").get(id)) throw new Error("הרישום כבר בוטל");
      const { id: _id, entry_number: _n, recorded_at: _r, content_hash: _h, prev_hash: _p, ...base } = orig;
      const rev = insertExpense(db2, {
        ...base,
        amount_agorot: -orig.amount_agorot,
        reverses_id: orig.id,
        reverse_reason: reason.trim(),
        expense_date: todayIL(),
        description: `ביטול רישום ${orig.entry_number}: ${orig.description}`,
        notes: null
      });
      appendAudit(db2, "expense.reverse", "expense", rev.id, { reverses: orig.entry_number, reason });
      return rev;
    });
  }
  function verifyExpenses(db2) {
    const rows = db2.prepare("SELECT * FROM expenses ORDER BY entry_number").all();
    const bad = [];
    let prev = null;
    rows.forEach((r, i) => {
      const { id, content_hash, ...rest } = r;
      if (r.entry_number !== i + 1 || r.prev_hash !== prev || hashOf(rest) !== content_hash) bad.push(r.entry_number);
      prev = r.content_hash;
    });
    return { ok: bad.length === 0, badEntries: bad };
  }

  // src/core/otherIncome.ts
  var OTHER_INCOME_KINDS = {
    compensation: { name: "פיצוי על נזק עקיף (מס רכוש)", inTurnover: true },
    grant: { name: "מענק רשות המסים על פגיעה במחזור", inTurnover: true },
    nii_reserve: { name: "דמי מילואים מביטוח לאומי", inTurnover: false },
    nii_maternity: { name: "דמי לידה מביטוח לאומי", inTurnover: false }
  };
  var hashOf2 = (r) => sha256(canonicalJson(r));
  function insert(db2, data) {
    const last = db2.prepare("SELECT entry_number, content_hash FROM other_income ORDER BY entry_number DESC LIMIT 1").get();
    const row = { ...data, entry_number: (last?.entry_number ?? 0) + 1, recorded_at: nowIso(), prev_hash: last?.content_hash ?? null };
    const r = db2.prepare(`INSERT INTO other_income (entry_number, recorded_at, income_date, kind, payer, description, amount_agorot,
    reference, reverses_id, reverse_reason, content_hash, prev_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.entry_number,
      row.recorded_at,
      row.income_date,
      row.kind,
      row.payer,
      row.description,
      row.amount_agorot,
      row.reference,
      row.reverses_id,
      row.reverse_reason,
      hashOf2(row),
      row.prev_hash
    );
    return db2.prepare("SELECT * FROM other_income WHERE id = ?").get(Number(r.lastInsertRowid));
  }
  function recordOtherIncome(db2, input) {
    const errors = [];
    if (!isIsoDate(input.incomeDate) || input.incomeDate > todayIL()) errors.push("תאריך לא תקין");
    if (!(input.kind in OTHER_INCOME_KINDS)) errors.push("סוג הכנסה לא תקין");
    if (!input.payer?.trim()) errors.push("המשלם חובה");
    if (!input.description?.trim()) errors.push("תיאור חובה");
    if (!Number.isInteger(input.amountAgorot) || input.amountAgorot <= 0) errors.push("סכום חייב להיות חיובי");
    if (errors.length) throw new ValidationError(errors, []);
    return inTransaction(db2, () => {
      const row = insert(db2, {
        income_date: input.incomeDate,
        kind: input.kind,
        payer: input.payer.trim(),
        description: input.description.trim(),
        amount_agorot: input.amountAgorot,
        reference: input.reference?.trim() || null,
        reverses_id: null,
        reverse_reason: null
      });
      appendAudit(db2, "other_income.record", "other_income", row.id, { kind: row.kind, amount: row.amount_agorot });
      return row;
    });
  }
  function reverseOtherIncome(db2, id, reason) {
    if (!reason?.trim()) throw new Error("חובה לציין סיבה");
    return inTransaction(db2, () => {
      const o = db2.prepare("SELECT * FROM other_income WHERE id = ?").get(id);
      if (!o) throw new Error("רישום לא נמצא");
      if (o.reverses_id || db2.prepare("SELECT 1 FROM other_income WHERE reverses_id = ?").get(id)) throw new Error("אי אפשר לבטל רישום זה");
      const row = insert(db2, {
        income_date: todayIL(),
        kind: o.kind,
        payer: o.payer,
        description: `ביטול רישום ${o.entry_number}: ${o.description}`,
        amount_agorot: -o.amount_agorot,
        reference: o.reference,
        reverses_id: o.id,
        reverse_reason: reason.trim()
      });
      appendAudit(db2, "other_income.reverse", "other_income", row.id, { reverses: o.entry_number, reason });
      return row;
    });
  }
  function otherIncomeTotals(db2, from, to) {
    const rows = db2.prepare("SELECT kind, SUM(amount_agorot) s FROM other_income WHERE income_date BETWEEN ? AND ? GROUP BY kind").all(from, to);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r.s]));
    return {
      inTurnover: (by.compensation ?? 0) + (by.grant ?? 0),
      niiReserve: by.nii_reserve ?? 0,
      niiMaternity: by.nii_maternity ?? 0
    };
  }
  function verifyOtherIncome(db2) {
    const rows = db2.prepare("SELECT * FROM other_income ORDER BY entry_number").all();
    const bad = [];
    let prev = null;
    rows.forEach((r, i) => {
      const { id, content_hash, ...rest } = r;
      if (r.entry_number !== i + 1 || r.prev_hash !== prev || hashOf2(rest) !== content_hash) bad.push(r.entry_number);
      prev = r.content_hash;
    });
    return { ok: bad.length === 0, badEntries: bad };
  }

  // src/core/books.ts
  function receiptsPaymentsBook(db2, from, to) {
    const docs = db2.prepare(`SELECT * FROM documents WHERE status = 'issued' AND doc_type IN ('receipt', 'invoice_receipt')
    AND issue_date BETWEEN ? AND ? ORDER BY issue_date, id`).all(from, to);
    const exps = db2.prepare("SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date, entry_number").all(from, to);
    const rows = [
      ...docs.map((d) => {
        const body = JSON.parse(d.body);
        return {
          date: d.issue_date,
          ref: `${DOC_TYPE_NAMES[d.doc_type]} ${d.number}`,
          name: JSON.parse(d.customer_snapshot)?.name ?? "",
          description: body.description ?? body.lines?.[0]?.description ?? "",
          receipt: d.total_agorot,
          withholding: body.withholdingAgorot ?? 0,
          payment: 0,
          asset: 0,
          deposit: 0,
          source: "document",
          sourceId: d.id
        };
      }),
      ...exps.map((e) => ({
        date: e.expense_date,
        ref: `רישום ${e.entry_number}${e.doc_number ? ` · ${EXPENSE_DOC_KINDS[e.doc_kind]} ${e.doc_number}` : ""}`,
        name: e.supplier_name,
        description: e.description,
        receipt: 0,
        withholding: 0,
        payment: e.column_kind === "regular" ? e.amount_agorot : 0,
        asset: e.column_kind === "asset" ? e.amount_agorot : 0,
        deposit: e.column_kind === "deposit" ? e.amount_agorot : 0,
        source: "expense",
        sourceId: e.id
      })),
      // פיצויים ומענקים הם תקבולי העסק; תשלומי ביטוח לאומי (מילואים/לידה) אינם תקבולי העסק ולא נכנסים לספר
      ...db2.prepare("SELECT * FROM other_income WHERE kind IN ('compensation', 'grant') AND income_date BETWEEN ? AND ? ORDER BY income_date, entry_number").all(from, to).map((o) => ({
        date: o.income_date,
        ref: `הכנסה נוספת ${o.entry_number}${o.reference ? ` · ${o.reference}` : ""}`,
        name: o.payer,
        description: `${OTHER_INCOME_KINDS[o.kind].name}: ${o.description}`,
        receipt: o.amount_agorot,
        withholding: 0,
        payment: 0,
        asset: 0,
        deposit: 0,
        source: "other_income",
        sourceId: o.id
      }))
    ].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.source === b.source ? a.sourceId - b.sourceId : a.source === "document" ? -1 : 1);
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    return { rows, totals: { receipt: sum("receipt"), withholding: sum("withholding"), payment: sum("payment"), asset: sum("asset"), deposit: sum("deposit") } };
  }
  function annualSummary(db2, year) {
    const from = `${year}-01-01`, to = `${year}-12-31`;
    const { totals } = receiptsPaymentsBook(db2, from, to);
    const byCategory = db2.prepare(`SELECT category, SUM(amount_agorot) total FROM expenses
    WHERE column_kind = 'regular' AND expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`).all(from, to);
    const assets = db2.prepare(`SELECT expense_date, supplier_name, description, amount_agorot FROM expenses
    WHERE column_kind = 'asset' AND expense_date BETWEEN ? AND ? ORDER BY expense_date`).all(from, to);
    const invoiced = db2.prepare(`SELECT COALESCE(SUM(CASE WHEN doc_type = 'credit' THEN -total_agorot ELSE total_agorot END), 0) s
    FROM documents WHERE status = 'issued' AND doc_type IN ('invoice', 'invoice_receipt', 'credit') AND issue_date BETWEEN ? AND ?`).get(from, to);
    const turnover = turnoverBetween(db2, from, to);
    const deemedPct = paramAt(PARAMS.smallBusinessDeemedExpensePercent, from);
    const other = otherIncomeTotals(db2, from, to);
    return {
      year,
      turnover,
      smallBusinessTaxable: Math.round(turnover * (100 - deemedPct) / 100),
      deemedPct,
      compensationInTurnover: other.inTurnover,
      niiReserve: other.niiReserve,
      niiMaternity: other.niiMaternity,
      receipts: totals.receipt,
      withholding: totals.withholding,
      invoicedNet: invoiced.s,
      expensesRegular: totals.payment,
      assets: totals.asset,
      deposits: totals.deposit,
      byCategory,
      assetList: assets,
      netBeforeAdjustments: totals.receipt - totals.payment
    };
  }
  function turnoverBetween(db2, from, to) {
    const invoiced = db2.prepare(`SELECT COALESCE(SUM(CASE WHEN doc_type = 'credit' THEN -total_agorot ELSE total_agorot END), 0) s
    FROM documents WHERE status = 'issued' AND doc_type IN ('invoice', 'invoice_receipt', 'credit') AND issue_date BETWEEN ? AND ?`).get(from, to);
    const receiptsNoInvoice = db2.prepare(`SELECT body, total_agorot FROM documents WHERE status = 'issued' AND doc_type = 'receipt'
    AND issue_date BETWEEN ? AND ?`).all(from, to).filter((r) => !(JSON.parse(r.body).relatedDocumentIds ?? []).length).reduce((s, r) => s + r.total_agorot, 0);
    return invoiced.s + receiptsNoInvoice + otherIncomeTotals(db2, from, to).inTurnover;
  }
  function exemptCeilingStatus(db2, today = todayIL()) {
    const year = today.slice(0, 4);
    const turnover = turnoverBetween(db2, `${year}-01-01`, today);
    const ceiling = paramAt(PARAMS.exemptDealerCeilingAgorot, `${year}-01-01`);
    return { year: Number(year), turnover, ceiling, percent: Math.round(turnover / ceiling * 1e3) / 10 };
  }
  function upcomingDeadlines(today = todayIL()) {
    const y = Number(today.slice(0, 4));
    const list = [];
    for (const year of [y, y + 1]) {
      list.push(
        { date: `${year}-01-31`, title: 'הצהרת עוסק פטור למע"מ', detail: `מחזור העסקאות של ${year - 1}`, url: "https://www.misim.gov.il/empatur/startPageIntErnet.aspx" },
        { date: year - 1 === 2025 ? "2026-08-31" : `${year}-03-31`, title: "דיווח שנתי מקוצר – עסק זעיר", detail: `מחזור ${year - 1} + ניכוי במקור (עם אישורים)`, url: "https://www.gov.il/he/service/report-and-payment-for-micro-business-owner" },
        { date: `${year}-12-31`, title: "תיאום מס מקוון – עסק זעיר", detail: `לשנת ${year} (בלי תיאום → דוח שנתי מלא)`, url: "https://www.gov.il/he/service/tax-coordination-online" }
      );
    }
    return list.filter((d) => d.date >= today).sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 3);
  }

  // src/core/backupStatus.ts
  function quarterlyBackupStatus(db2, today = todayIL()) {
    const [y, m] = today.split("-").map(Number);
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const quarterStart = `${y}-${String(qStartMonth).padStart(2, "0")}-01`;
    const dayInQuarter = Math.round((Date.parse(today) - Date.parse(quarterStart)) / 864e5) + 1;
    const last = (kind) => db2.prepare(
      "SELECT at, path, doc_count, verified_ok FROM backups_log WHERE kind = ? ORDER BY id DESC LIMIT 1"
    ).get(kind) ?? null;
    const externalThisQuarter = db2.prepare(
      "SELECT COUNT(*) c FROM backups_log WHERE kind = 'external' AND verified_ok = 1 AND at >= ?"
    ).get(quarterStart);
    const quarterDone = externalThisQuarter.c > 0;
    return {
      quarterStart,
      quarter: Math.floor((m - 1) / 3) + 1,
      year: y,
      dayInQuarter,
      inFirstWeek: dayInQuarter <= 7,
      quarterDone,
      lastExternal: last("external"),
      lastLocal: last("local"),
      // "due" = עכשיו השבוע הראשון ועדיין לא גובה; "overdue" = עבר השבוע הראשון בלי גיבוי
      state: quarterDone ? "ok" : dayInQuarter <= 7 ? "due" : "overdue"
    };
  }

  // src/routes.ts
  var HttpError = class extends Error {
    status;
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  };
  var ok = (json) => ({ status: 200, json });
  function docSummary(d) {
    return {
      id: d.id,
      type: d.doc_type,
      typeName: DOC_TYPE_NAMES[d.doc_type],
      number: d.number,
      issueDate: d.issue_date,
      customer: JSON.parse(d.customer_snapshot)?.name ?? "",
      customerId: d.customer_id,
      total: d.total_agorot,
      status: d.status,
      cancelReason: d.cancel_reason,
      originalProducedAt: d.original_produced_at,
      originalDelivery: d.original_delivery ? JSON.parse(d.original_delivery) : null,
      body: JSON.parse(d.body)
    };
  }
  async function route(db2, platform2, req) {
    const { method: m, path: p, query: q, body } = req;
    const relatedOf = (d) => (JSON.parse(d.body).relatedDocumentIds ?? []).map((id) => getDoc(db2, id)).filter(Boolean);
    const report = (title, period, bodyHtml, action, filename) => {
      const business = getBusinessProfile(db2);
      const html = renderReport({ businessName: business?.name ?? "-", title, period, producedAt: nowIso(), bodyHtml });
      return { status: 200, printable: { html, filename, finalize: () => {
        appendAudit(db2, action, "report", null, { title, period });
        return { label: "" };
      } } };
    };
    if (p === "/api/business" && m === "GET") return ok(getBusinessProfile(db2));
    if (p === "/api/business" && m === "POST") {
      setBusinessProfile(db2, { ...body, status: "exempt" });
      return ok(getBusinessProfile(db2));
    }
    if (p === "/api/customers" && m === "GET") {
      const rows = db2.prepare("SELECT id FROM customers ORDER BY name").all();
      return ok(rows.map((r) => ({ ...getCustomer(db2, r.id), balance: customerLedger(db2, r.id).balance })));
    }
    if (p === "/api/customers" && m === "POST") return ok(createCustomer(db2, body));
    let mm = p.match(/^\/api\/customers\/(\d+)$/);
    if (mm && m === "PUT") {
      updateCustomer(db2, Number(mm[1]), body);
      return ok(getCustomer(db2, Number(mm[1])));
    }
    mm = p.match(/^\/api\/customers\/(\d+)\/ledger$/);
    if (mm && m === "GET") return ok(customerLedger(db2, Number(mm[1])));
    if (p === "/api/series" && m === "GET") return ok(db2.prepare("SELECT * FROM series").all());
    mm = p.match(/^\/api\/series\/(\w+)\/start$/);
    if (mm && m === "POST") {
      setSeriesStart(db2, mm[1], Number(body.start));
      return ok({ ok: true });
    }
    if (p === "/api/documents" && m === "GET") {
      const type = q.get("type");
      const rows = type ? db2.prepare("SELECT * FROM documents WHERE doc_type = ? ORDER BY id DESC").all(type) : db2.prepare("SELECT * FROM documents ORDER BY id DESC").all();
      return ok(rows.map(docSummary));
    }
    if (p === "/api/documents" && m === "POST") {
      const { document: document2, warnings } = issueDocument(db2, body);
      return ok({ document: docSummary(document2), warnings });
    }
    if (p === "/api/documents/preview" && m === "POST") {
      const input = body;
      const business = getBusinessProfile(db2);
      const c = input.customerId ? getCustomer(db2, input.customerId) : input.customer;
      const customer = c ? { name: c.name, idNumber: c.idNumber ?? null, address: c.address ?? null } : null;
      const v = validateIssue(db2, input, customer);
      const draft = {
        doc_type: input.type,
        issue_date: v.issueDate,
        total_agorot: v.total,
        customer_snapshot: canonicalJson(customer),
        business_snapshot: canonicalJson(business ?? {}),
        body: canonicalJson({
          lines: input.lines ?? [],
          payments: input.payments ?? [],
          withholdingAgorot: input.withholdingAgorot ?? 0,
          description: input.description ?? null,
          relatedDocumentIds: input.relatedDocumentIds ?? [],
          reason: input.reason ?? null,
          notes: input.notes ?? null
        })
      };
      return ok({ html: renderDocument(draft, "טיוטה", relatedOf(draft)), errors: v.errors, warnings: v.warnings, total: v.total });
    }
    mm = p.match(/^\/api\/documents\/(\d+)$/);
    if (mm && m === "GET") {
      const d = getDoc(db2, Number(mm[1]));
      if (!d) throw new HttpError(404, "לא נמצא");
      return ok({ ...docSummary(d), related: relatedOf(d).map(docSummary) });
    }
    mm = p.match(/^\/api\/documents\/(\d+)\/cancel$/);
    if (mm && m === "POST") {
      cancelDocument(db2, Number(mm[1]), body.reason);
      return ok({ ok: true });
    }
    mm = p.match(/^\/api\/documents\/(\d+)\/delivery$/);
    if (mm && m === "POST") {
      recordOriginalDelivery(db2, Number(mm[1]), body);
      return ok({ ok: true });
    }
    mm = p.match(/^\/api\/documents\/(\d+)\/view$/);
    if (mm && m === "GET") {
      const d = getDoc(db2, Number(mm[1]));
      if (!d) throw new HttpError(404, "לא נמצא");
      produceOutput(db2, d.id, "copy", "view");
      return { status: 200, html: renderDocument(d, "העתק", relatedOf(d)) };
    }
    mm = p.match(/^\/api\/documents\/(\d+)\/pdf$/);
    if (mm && m === "POST") {
      const { kind, purpose } = body;
      if (kind !== "original" && kind !== "copy") throw new HttpError(400, "kind לא תקין");
      const id = Number(mm[1]);
      const d = getDoc(db2, id);
      if (!d) throw new HttpError(404, "לא נמצא");
      if (kind === "original" && d.original_produced_at) throw new HttpError(409, `המקור הופק כבר ב-${d.original_produced_at}. ניתן להפיק העתק בלבד`);
      if (kind === "original" && d.status !== "issued") throw new HttpError(409, "אי אפשר להפיק מקור למסמך מבוטל");
      const label = kind === "original" ? "מקור" : "העתק";
      return { status: 200, printable: {
        html: renderDocument(d, label, relatedOf(d)),
        filename: `${d.doc_type}-${d.number}-${kind}.pdf`,
        finalize: () => ({ label: produceOutput(db2, id, kind, purpose === "sent" ? "sent" : "print").label })
      } };
    }
    if (p === "/api/reports/continuity" && m === "GET") {
      if (q.get("format") !== "pdf") return ok({ series: continuityReport(db2), audit: verifyAuditChain(db2) });
      return report("דוח בדיקת רצף מספרים עוקבים", `כל התקופה עד ${todayIL()}`, continuityBody(continuityReport(db2)), "report.continuity", "continuity.pdf");
    }
    if (p === "/api/reports/journal" && m === "GET") {
      const from = q.get("from") ?? "0000-01-01";
      const to = q.get("to") ?? "9999-12-31";
      const docs = db2.prepare("SELECT * FROM documents WHERE issue_date BETWEEN ? AND ? ORDER BY id").all(from, to);
      return report("יומן רשומות – תיעוד פנים לפי סדר רישומן", `${from} עד ${to}`, journalBody(docs), "report.journal", "journal.pdf");
    }
    if (p === "/api/reports/balances" && m === "GET") {
      const date = q.get("date") ?? todayIL();
      const rows = customerBalancesAt(db2, date);
      if (q.get("format") !== "pdf") return ok(rows);
      return report("רשימת יתרות לקוחות", `נכון ליום ${date}`, balancesBody(rows), "report.balances", "balances.pdf");
    }
    if (p === "/api/reports/book" && m === "GET") {
      const from = q.get("from") ?? `${todayIL().slice(0, 4)}-01-01`;
      const to = q.get("to") ?? todayIL();
      const { rows, totals } = receiptsPaymentsBook(db2, from, to);
      if (q.get("format") !== "pdf") return ok({ rows, totals });
      return report("ספר תקבולים ותשלומים", `${from} עד ${to}`, bookBody(rows, totals), "report.book", "book.pdf");
    }
    if (p === "/api/reports/annual" && m === "GET") {
      const year = Number(q.get("year") ?? todayIL().slice(0, 4));
      const s = annualSummary(db2, year);
      if (q.get("format") !== "pdf") return ok(s);
      return report(`סיכום שנתי ${year}`, `01/01/${year} – 31/12/${year}`, annualSummaryBody(s), "report.annual", `annual-${year}.pdf`);
    }
    if (p === "/api/expenses/meta" && m === "GET")
      return ok({ categories: EXPENSE_CATEGORIES, docKinds: EXPENSE_DOC_KINDS, paymentMethods: EXPENSE_PAYMENT_METHODS });
    if (p === "/api/expenses" && m === "GET") {
      const rows = db2.prepare("SELECT * FROM expenses ORDER BY entry_number DESC").all();
      const reversed = new Set(rows.filter((r) => r.reverses_id).map((r) => r.reverses_id));
      return ok(rows.map((r) => ({ ...r, attachment: r.attachment ? JSON.parse(r.attachment) : null, reversed: reversed.has(r.id) })));
    }
    if (p === "/api/expenses" && m === "POST") return ok(recordExpense(db2, body, platform2.saveAttachment));
    mm = p.match(/^\/api\/expenses\/(\d+)\/reverse$/);
    if (mm && m === "POST") return ok(reverseExpense(db2, Number(mm[1]), body.reason));
    if (p === "/api/other-income" && m === "GET") {
      const rows = db2.prepare("SELECT * FROM other_income ORDER BY entry_number DESC").all();
      const reversed = new Set(rows.filter((r) => r.reverses_id).map((r) => r.reverses_id));
      return ok({ kinds: OTHER_INCOME_KINDS, rows: rows.map((r) => ({ ...r, reversed: reversed.has(r.id) })) });
    }
    if (p === "/api/other-income" && m === "POST") return ok(recordOtherIncome(db2, body));
    mm = p.match(/^\/api\/other-income\/(\d+)\/reverse$/);
    if (mm && m === "POST") return ok(reverseOtherIncome(db2, Number(mm[1]), body.reason));
    if (p === "/api/dashboard" && m === "GET") {
      const year = todayIL().slice(0, 4);
      const income = db2.prepare(`SELECT COALESCE(SUM(total_agorot),0) s FROM documents
      WHERE status='issued' AND doc_type IN ('receipt','invoice_receipt') AND substr(issue_date,1,4)=?`).get(year);
      const notDelivered = db2.prepare(`SELECT COUNT(*) c FROM documents WHERE status='issued' AND doc_type IN ('receipt','invoice_receipt','invoice','credit')
      AND original_produced_at IS NULL`).get();
      return ok({
        year,
        incomeAgorot: income.s,
        originalsPending: notDelivered.c,
        continuityOk: continuityReport(db2).every((s) => s.ok) && verifyExpenses(db2).ok && verifyOtherIncome(db2).ok,
        backup: { ...quarterlyBackupStatus(db2), ...platform2.backupExtras?.(db2) ?? {} },
        ceiling: exemptCeilingStatus(db2),
        deadlines: upcomingDeadlines()
      });
    }
    return null;
  }

  // web/sqlite.ts
  var norm = (params) => params.map((v) => v === void 0 ? null : typeof v === "boolean" ? v ? 1 : 0 : v);
  var Statement = class {
    #db;
    #sql;
    constructor(db2, sql) {
      this.#db = db2;
      this.#sql = sql;
    }
    get(...params) {
      const s = this.#db.prepare(this.#sql);
      try {
        s.bind(norm(params));
        return s.step() ? s.getAsObject() : void 0;
      } finally {
        s.free();
      }
    }
    all(...params) {
      const s = this.#db.prepare(this.#sql);
      const rows = [];
      try {
        s.bind(norm(params));
        while (s.step()) rows.push(s.getAsObject());
        return rows;
      } finally {
        s.free();
      }
    }
    run(...params) {
      this.#db.run(this.#sql, norm(params));
      const r = this.#db.exec("SELECT changes() AS c, last_insert_rowid() AS id")[0].values[0];
      return { changes: Number(r[0]), lastInsertRowid: Number(r[1]) };
    }
  };
  var BrowserDatabase = class {
    raw;
    constructor(raw) {
      this.raw = raw;
    }
    prepare(sql) {
      return new Statement(this.raw, sql);
    }
    exec(sql) {
      this.raw.exec(sql);
    }
    close() {
      this.raw.close();
    }
    export() {
      return this.raw.export();
    }
    /** מספר השינויים מאז פתיחת החיבור – לזיהוי מתי לשמור. */
    totalChanges() {
      return Number(this.raw.exec("SELECT total_changes()")[0].values[0][0]);
    }
  };

  // web/store.ts
  var DB_NAME = "pinkas";
  var STORES = ["kv", "attachments", "outputs", "snapshots"];
  var dbp = null;
  function idb() {
    dbp ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  function tx(store2, mode, fn) {
    return idb().then((db2) => new Promise((resolve, reject) => {
      const t = db2.transaction(store2, mode);
      const req = fn(t.objectStore(store2));
      t.oncomplete = () => resolve(req ? req.result : void 0);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
    }));
  }
  var store = {
    get: (s, key) => tx(s, "readonly", (o) => o.get(key)),
    put: (s, key, value) => tx(s, "readwrite", (o) => o.put(value, key)),
    del: (s, key) => tx(s, "readwrite", (o) => o.delete(key)),
    keys: (s) => tx(s, "readonly", (o) => o.getAllKeys()).then((k) => k.map(String))
  };

  // web/main.ts
  var SQL;
  var db;
  var lastSavedChanges = 0;
  var pendingWrites = [];
  async function openDatabase(bytes) {
    const d = new BrowserDatabase(new SQL.Database(bytes));
    d.exec("PRAGMA foreign_keys = ON;");
    d.exec(schema_default);
    return d;
  }
  async function persist(force = false) {
    const changes = db.totalChanges();
    if (!force && changes === lastSavedChanges) return;
    await store.put("kv", "db", db.export());
    lastSavedChanges = db.totalChanges();
  }
  async function dailySnapshot() {
    const today = todayIL();
    const keys = (await store.keys("snapshots")).sort();
    if (keys.includes(today)) return;
    await store.put("snapshots", today, db.export());
    for (const old of keys.slice(0, Math.max(0, keys.length + 1 - 14))) await store.del("snapshots", old);
    const docCount = db.prepare("SELECT COUNT(*) c FROM documents").get().c;
    inTransaction(db, () => {
      db.prepare("INSERT INTO backups_log (at, kind, path, doc_count, verified_ok, details) VALUES (?, ?, ?, ?, ?, ?)").run(nowIso(), "local", `browser-snapshot:${today}`, docCount, 1, "{}");
    });
    await persist(true);
  }
  async function init() {
    SQL = await initSqlJs({ locateFile: (f) => f });
    const bytes = await store.get("kv", "db");
    db = await openDatabase(bytes ?? void 0);
    await persist(true);
    try {
      await navigator.storage?.persist?.();
    } catch {
    }
    await dailySnapshot();
  }
  var platform = {
    saveAttachment: (file, bytes) => {
      pendingWrites.push(store.put("attachments", file, bytes));
    }
  };
  async function isPersisted() {
    try {
      return await navigator.storage?.persisted?.() ?? false;
    } catch {
      return false;
    }
  }
  function apiError(status, data) {
    const e = new Error(String(data.error ?? "שגיאה"));
    Object.assign(e, data, { status });
    return e;
  }
  async function api(path, opts = {}) {
    const url = new URL(path, "http://local");
    const method = opts.method ?? "GET";
    try {
      if (url.pathname === "/api/backup/status") return await backupStatus();
      const result = await route(db, platform, { method, path: url.pathname, query: url.searchParams, body: opts.body ?? {} });
      if (!result) throw new HttpError(404, "לא זמין בגרסת הדפדפן");
      return await finish(result);
    } catch (err) {
      if (err instanceof ValidationError) throw apiError(422, { error: err.message, errors: err.errors, warnings: err.warnings });
      if (err instanceof HttpError) throw apiError(err.status, { error: err.message });
      const msg = String(err?.message ?? err);
      throw apiError(msg.includes("FORBIDDEN") ? 409 : 400, { error: msg });
    } finally {
      await Promise.all(pendingWrites.splice(0));
      await persist();
    }
  }
  async function finish(result) {
    if ("json" in result) return result.json;
    if ("html" in result) return { html: result.html };
    const label = result.printable.finalize?.().label;
    if (label === "מקור") pendingWrites.push(store.put("outputs", result.printable.filename.replace(/\.pdf$/, ".html"), result.printable.html));
    return { printable: { html: result.printable.html, filename: result.printable.filename } };
  }
  function printHtml(html, filename) {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
    document.body.appendChild(frame);
    const title = filename.replace(/\.pdf$/, "");
    frame.onload = () => {
      try {
        frame.contentDocument.title = title;
      } catch {
      }
      const prev = document.title;
      document.title = title;
      setTimeout(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(() => {
          document.title = prev;
          frame.remove();
        }, 1500);
      }, 100);
    };
    frame.srcdoc = html;
  }
  function showHtmlInWindow(win, html) {
    if (!win) {
      printHtml(html, "document");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }
  async function openAttachment(win, id) {
    const r = db.prepare("SELECT attachment FROM expenses WHERE id = ?").get(id);
    if (!r?.attachment) throw new Error("אין קובץ מצורף");
    const a = JSON.parse(r.attachment);
    const bytes = await store.get("attachments", a.file);
    if (!bytes) throw new Error("הקובץ המצורף לא נמצא בדפדפן הזה");
    const url = URL.createObjectURL(new Blob([bytes], { type: a.type }));
    if (win) win.location.href = url;
    else window.open(url, "_blank");
  }
  var bytesToBase64 = (b) => {
    let s = "";
    for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
    return btoa(s);
  };
  function stampIL() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(/* @__PURE__ */ new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}${p.second}`;
  }
  async function backupStatus() {
    const log = db.prepare("SELECT * FROM backups_log ORDER BY id DESC LIMIT 30").all();
    return { ...quarterlyBackupStatus(db), mode: "browser", persisted: await isPersisted(), log };
  }
  async function inspectBackup(data) {
    const problems = [];
    if (data?.app !== "pinkas" || data.formatVersion !== 1) return { ok: false, problems: ["זה לא קובץ גיבוי של פנקס"], docCount: 0, bdb: null, data };
    const dbBytes = base64ToBytes(data.db);
    if (sha256Bytes(dbBytes) !== data.dbSha256) problems.push("קובץ המסד בגיבוי שונה מאז שנוצר");
    for (const [file, b64] of Object.entries(data.attachments ?? {})) {
      if (!file.startsWith(sha256Bytes(base64ToBytes(b64)))) problems.push(`קובץ מצורף פגום: ${file}`);
    }
    let docCount = 0;
    let bdb = null;
    try {
      bdb = new BrowserDatabase(new SQL.Database(dbBytes));
      const ic = bdb.prepare("PRAGMA integrity_check").get();
      if (Object.values(ic)[0] !== "ok") problems.push("בדיקת שלמות המסד נכשלה");
      const series = continuityReport(bdb);
      docCount = series.reduce((s, x) => s + x.count, 0);
      for (const s of series) if (!s.ok) problems.push(`רצף/תוכן לא תקין בסדרה ${s.name}`);
      if (!verifyAuditChain(bdb).ok) problems.push("יומן האירועים בגיבוי פגום");
      if (!verifyExpenses(bdb).ok) problems.push("רישומי ההוצאות בגיבוי פגומים");
      if (!verifyOtherIncome(bdb).ok) problems.push("רישומי ההכנסות הנוספות בגיבוי פגומים");
      if (docCount !== data.docCount) problems.push(`מספר המסמכים (${docCount}) שונה מהרשום בגיבוי (${data.docCount})`);
    } catch (e) {
      problems.push(`לא ניתן לפתוח את המסד: ${e.message}`);
    }
    return { ok: problems.length === 0, problems, docCount, bdb, data };
  }
  async function exportBackup() {
    await persist(true);
    const series = continuityReport(db);
    const dbBytes = db.export();
    const attachments = {};
    for (const k of await store.keys("attachments")) attachments[k] = bytesToBase64(await store.get("attachments", k));
    const outputs = {};
    for (const k of await store.keys("outputs")) outputs[k] = await store.get("outputs", k);
    const data = {
      app: "pinkas",
      formatVersion: 1,
      kind: "browser-export",
      createdAt: nowIso(),
      docCount: series.reduce((s, x) => s + x.count, 0),
      lastNumbers: Object.fromEntries(series.map((s) => [s.docType, s.lastNumber])),
      db: bytesToBase64(dbBytes),
      dbSha256: sha256Bytes(dbBytes),
      attachments,
      outputs
    };
    const check = await inspectBackup(JSON.parse(JSON.stringify(data)));
    check.bdb?.close();
    const name = `pinkas-backup-${stampIL()}.json`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1e4);
    inTransaction(db, () => {
      db.prepare("INSERT INTO backups_log (at, kind, path, doc_count, verified_ok, details) VALUES (?, ?, ?, ?, ?, ?)").run(data.createdAt, "external", `download:${name}`, data.docCount, check.ok ? 1 : 0, JSON.stringify({ problems: check.problems }));
      appendAudit(db, "backup.create", "backup", null, { kind: "external", path: name, ok: check.ok });
    });
    await persist(true);
    return { name, verify: { ok: check.ok, problems: check.problems, docCount: check.docCount } };
  }
  async function readBackupFile(file) {
    try {
      return JSON.parse(await file.text());
    } catch {
      throw new Error("הקובץ אינו קובץ גיבוי תקין");
    }
  }
  async function verifyBackupFile(file) {
    const r = await inspectBackup(await readBackupFile(file));
    r.bdb?.close();
    return { ok: r.ok, problems: r.problems, docCount: r.docCount, createdAt: r.data?.createdAt };
  }
  async function reportFromBackupFile(file) {
    const r = await inspectBackup(await readBackupFile(file));
    if (!r.bdb) throw new Error(r.problems.join("; "));
    try {
      const prof = r.bdb.prepare("SELECT data FROM business_profile_versions ORDER BY id DESC LIMIT 1").get();
      const docs = r.bdb.prepare("SELECT * FROM documents ORDER BY id").all();
      const html = renderReport({
        businessName: prof ? JSON.parse(prof.data).name : "-",
        title: "יומן רשומות – הופק מגיבוי",
        period: `גיבוי מיום ${r.data.createdAt.slice(0, 10)} (${file.name})`,
        producedAt: nowIso(),
        bodyHtml: `${r.ok ? "" : `<p style="color:#b00"><b>אזהרה – בעיות בגיבוי:</b> ${r.problems.join("; ")}</p>`}${journalBody(docs)}<h3>בדיקת רצף בגיבוי</h3>${continuityBody(continuityReport(r.bdb))}`
      });
      inTransaction(db, () => appendAudit(db, "backup.report", "backup", null, { path: file.name }));
      await persist();
      printHtml(html, "report-from-backup");
    } finally {
      r.bdb.close();
    }
  }
  async function restoreFromFile(file) {
    const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    if (count("documents") + count("expenses") + count("other_income") > 0)
      throw new Error("בדפדפן הזה כבר יש רישומים. שחזור אפשרי רק לדפדפן ריק, כדי לא לדרוס ספרים קיימים.");
    const r = await inspectBackup(await readBackupFile(file));
    r.bdb?.close();
    if (!r.ok) throw new Error(`הגיבוי לא תקין – לא שוחזר: ${r.problems.join("; ")}`);
    for (const [k, b64] of Object.entries(r.data.attachments ?? {})) await store.put("attachments", k, base64ToBytes(b64));
    for (const [k, html] of Object.entries(r.data.outputs ?? {})) await store.put("outputs", k, html);
    db.close();
    db = await openDatabase(base64ToBytes(r.data.db));
    inTransaction(db, () => appendAudit(db, "backup.restore", "backup", null, { file: file.name, createdAt: r.data.createdAt }));
    await persist(true);
    return { docCount: r.docCount };
  }
  window.pinkasLocal = {
    api,
    print: printHtml,
    showHtmlInWindow,
    openAttachment,
    exportBackup,
    verifyBackupFile,
    reportFromBackupFile,
    restoreFromFile
  };
  window.pinkasReady = init().catch((e) => {
    document.body.innerHTML = `<div style="padding:24px;font-family:Arial;direction:rtl"><h2>פנקס לא הצליח לעלות</h2><p>${String(e?.message ?? e)}</p>
    <p>ודא שהדפדפן מעודכן (Chrome / Edge) ושלא נחסם אחסון מקומי לאתר.</p></div>`;
    throw e;
  });
})();
