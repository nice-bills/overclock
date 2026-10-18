// Inline web/demo-run.json, the job board script and its event snapshot into web/index.html, producing one
// self-contained page (web/overclock.html) that can be uploaded as a DeWEB site or opened from disk.
//
//   node scripts/build-web.js [run.json] [out.html]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const json = (path) => readFileSync(path, 'utf8').trim().replace(/</g, '\\u003c');
const page = readFileSync('web/index.html', 'utf8');
const run = json(process.argv[2] ?? 'web/demo-run.json');
const snapshot = existsSync('web/board-snapshot.json') ? json('web/board-snapshot.json') : 'null';
const board = readFileSync('web/board.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const out = process.argv[3] ?? 'web/overclock.html';

const swap = (s, from, to) => {
  if (!s.includes(from)) throw new Error(`web/index.html is missing ${from}`);
  return s.replace(from, () => to);
};
let html = swap(page, '<script id="run-data" type="application/json">null</script>', `<script id="run-data" type="application/json">${run}</script>`);
html = swap(html, '<script id="board-data" type="application/json">null</script>', `<script id="board-data" type="application/json">${snapshot}</script>`);
html = swap(html, '<script src="board.js"></script>', `<script>\n${board}</script>`);
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
