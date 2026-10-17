// Inline web/demo-run.json into web/index.html, producing one self-contained page (web/overclock.html)
// that can be uploaded as a DeWEB site or opened from disk.
import { readFileSync, writeFileSync } from 'node:fs';

const page = readFileSync('web/index.html', 'utf8');
const run = readFileSync(process.argv[2] ?? 'web/demo-run.json', 'utf8').replace(/</g, '\\u003c');
const out = process.argv[3] ?? 'web/overclock.html';
writeFileSync(out, page.replace('<script id="run-data" type="application/json">null</script>', `<script id="run-data" type="application/json">${run}</script>`));
console.log(`wrote ${out}`);
