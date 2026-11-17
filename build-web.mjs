// בונה את גרסת הדפדפן לתיקייה docs/ (שממנה GitHub Pages מגיש את האתר).
// הרצה: npm run build:web
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'docs';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: ['web/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
  loader: { '.sql': 'text' },
  outfile: `${OUT}/local.js`,
  legalComments: 'none',
  charset: 'utf8',
});

copyFileSync('public/app.js', `${OUT}/app.js`);
copyFileSync('public/style.css', `${OUT}/style.css`);
copyFileSync('node_modules/sql.js/dist/sql-wasm.js', `${OUT}/sql-wasm.js`);
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', `${OUT}/sql-wasm.wasm`);

const html = readFileSync('public/index.html', 'utf8').replace(
  '<script src="app.js" type="module"></script>',
  '<script src="sql-wasm.js"></script>\n  <script src="local.js"></script>\n  <script src="app.js" type="module"></script>',
).replace('<div class="brand">פנקס <small>עוסק פטור</small></div>',
  '<div class="brand">פנקס <small>עוסק פטור · הנתונים נשמרים רק בדפדפן הזה</small></div>');
writeFileSync(`${OUT}/index.html`, html);
writeFileSync(`${OUT}/.nojekyll`, '');
console.log('built → docs/');
