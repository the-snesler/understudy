import fs from 'node:fs';
import type { Hono } from 'hono';

/** Only built, known UI assets are exposed; data directories are never mounted. */
export function registerAssets(app: Hono): void {
  const files = [
    ['app.css', 'text/css'], ['ui.js', 'text/javascript'], ['sortable.min.js', 'text/javascript'],
    ...[400, 500, 600, 700].map((weight) => [`fonts/geist-latin-${weight}-normal.woff2`, 'font/woff2']),
    ['fonts/geist-mono-latin-400-normal.woff2', 'font/woff2'],
  ];
  for (const [file, type] of files) {
    app.get(`/assets/${file}`, (c) => {
      const asset = new URL(`../../assets/${file}`, import.meta.url);
      if (!fs.existsSync(asset)) return c.text('Build UI assets first: pnpm build:ui', 503);
      c.header('Content-Type', `${type}${type?.startsWith('text/') ? '; charset=utf-8' : ''}`);
      c.header('Cache-Control', 'public, max-age=3600');
      return c.body(fs.readFileSync(asset));
    });
  }
}
