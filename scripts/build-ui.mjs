import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'assets');
fs.mkdirSync(path.join(destination, 'fonts'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/web/ui.js'), path.join(destination, 'ui.js'));
fs.copyFileSync(require.resolve('sortablejs/Sortable.min.js'), path.join(destination, 'sortable.min.js'));
for (const weight of [400, 500, 600, 700]) {
  const file = `geist-latin-${weight}-normal.woff2`;
  fs.copyFileSync(require.resolve(`@fontsource/geist/files/${file}`), path.join(destination, 'fonts', file));
}
const mono = 'geist-mono-latin-400-normal.woff2';
fs.copyFileSync(require.resolve(`@fontsource/geist-mono/files/${mono}`), path.join(destination, 'fonts', mono));
