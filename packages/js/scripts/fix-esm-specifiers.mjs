// Rewrites relative specifiers in a tsc ESM emit to explicit `./x.js` / `./x/index.js`
// so the files are valid strict ESM. Usage: node fix-esm-specifiers.mjs <dir>
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/esm');
const SPEC = /(\b(?:from|import)\s*\(?\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g;

function fix(file) {
  const src = readFileSync(file, 'utf8');
  const out = src.replace(SPEC, (m, pre, q, spec) => {
    if (/\.(m?js|json)$/.test(spec)) return m;
    const target = resolve(dirname(file), spec);
    const next = existsSync(`${target}.js`) ? `${spec}.js` : existsSync(join(target, 'index.js')) ? `${spec.replace(/\/$/, '')}/index.js` : null;
    if (!next) throw new Error(`${file}: cannot resolve ${spec}`);
    return `${pre}${q}${next}${q}`;
  });
  if (out !== src) writeFileSync(file, out);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) fix(p);
  }
}
walk(root);
