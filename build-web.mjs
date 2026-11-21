// בונה את גרסת הדפדפן לתיקייה docs/ (שממנה GitHub Pages מגיש את האתר), ואת גרסת הדמו ל-docs/demo/.
// הרצה: npm run build:web
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'docs';
rmSync(OUT, { recursive: true, force: true });

async function buildSite(dir, { demo }) {
  mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: ['web/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
    loader: { '.sql': 'text' },
    define: { __DEMO__: demo ? 'true' : 'false' },
    outfile: `${dir}/local.js`,
    legalComments: 'none',
    charset: 'utf8',
  });
  copyFileSync('public/app.js', `${dir}/app.js`);
  copyFileSync('public/style.css', `${dir}/style.css`);
  copyFileSync('node_modules/sql.js/dist/sql-wasm.js', `${dir}/sql-wasm.js`);
  copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', `${dir}/sql-wasm.wasm`);
  const brand = demo ? 'פנקס <small>דמו · נתונים לדוגמה</small>' : 'פנקס <small>עוסק פטור · הנתונים נשמרים רק בדפדפן הזה</small>';
  const html = readFileSync('public/index.html', 'utf8').replace(
    '<script src="app.js" type="module"></script>',
    '<script src="sql-wasm.js"></script>\n  <script src="local.js"></script>\n  <script src="app.js" type="module"></script>',
  ).replace('<div class="brand">פנקס <small>עוסק פטור</small></div>', `<div class="brand">${brand}</div>`)
    .replace('<title>פנקס – ניהול חשבונות וקבלות</title>', demo ? '<title>פנקס – דמו</title>' : '<title>פנקס – ניהול חשבונות וקבלות</title>');
  writeFileSync(`${dir}/index.html`, html);
}

await buildSite(OUT, { demo: false });
await buildSite(`${OUT}/demo`, { demo: true });
writeFileSync(`${OUT}/.nojekyll`, '');
console.log('built → docs/ and docs/demo/');
