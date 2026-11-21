/**
 * HTML → PDF באמצעות דפדפן Chromium מותקן (headless), בלי תלויות חיצוניות:
 * Windows: Microsoft Edge. לינוקס (השרת): chrome-headless-shell של Chrome for Testing (מותקן ע"י
 * deploy/install-server.sh; Chromium של snap לא רץ תחת משתמש שירות), או Chromium / Chrome.
 * PINKAS_BROWSER – נתיב לדפדפן. PINKAS_PDF_TMP – תיקייה זמנית.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findBrowser(): string {
  const candidates = [
    process.env.PINKAS_BROWSER,
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/opt/chrome-headless-shell/chrome-headless-shell', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('לא נמצא דפדפן להפקת PDF (Edge / Chromium). ניתן להגדיר נתיב במשתנה PINKAS_BROWSER');
  return found;
}

export function htmlToPdf(html: string): Promise<Buffer> {
  const base = process.env.PINKAS_PDF_TMP || tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'pinkas-pdf-'));
  const htmlPath = join(dir, 'doc.html');
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(htmlPath, html, 'utf8');
  // PINKAS_BROWSER_ARGS: דגלים נוספים, למשל --no-sandbox בשרת שבו Ubuntu חוסם user namespaces
  // (ה-HTML הוא מסמך שפנקס עצמו מרנדר, מקומי, בלי תוכן מהרשת).
  const extra = (process.env.PINKAS_BROWSER_ARGS ?? '').split(/\s+/).filter(Boolean);
  const args = [
    '--headless', '--disable-gpu', '--no-first-run', '--disable-extensions', '--no-pdf-header-footer', '--print-to-pdf-no-header',
    ...extra, `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(findBrowser(), args, { timeout: 60_000, windowsHide: true }, (err) => {
      try {
        if (!existsSync(pdfPath)) return reject(err ?? new Error('יצירת ה-PDF נכשלה'));
        resolve(readFileSync(pdfPath));
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
  });
}
