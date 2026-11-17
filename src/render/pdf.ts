/** HTML → PDF באמצעות Microsoft Edge המותקן (headless). בלי תלויות חיצוניות. */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findEdge(): string {
  const candidates = [
    process.env.PINKAS_BROWSER,
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('לא נמצא Microsoft Edge. ניתן להגדיר נתיב לדפדפן במשתנה PINKAS_BROWSER');
  return found;
}

export function htmlToPdf(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pinkas-pdf-'));
  const htmlPath = join(dir, 'doc.html');
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(htmlPath, html, 'utf8');
  const args = [
    '--headless', '--disable-gpu', '--no-first-run', '--disable-extensions', '--no-pdf-header-footer',
    `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
  ];
  return new Promise((resolve, reject) => {
    execFile(findEdge(), args, { timeout: 60_000, windowsHide: true }, (err) => {
      try {
        if (!existsSync(pdfPath)) return reject(err ?? new Error('יצירת ה-PDF נכשלה'));
        resolve(readFileSync(pdfPath));
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
  });
}
