-- פנקס – סכמת מסד הנתונים (SQLite)
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
