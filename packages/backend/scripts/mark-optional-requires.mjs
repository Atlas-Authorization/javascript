#!/usr/bin/env node
// tsc (module commonjs) turns `import(/* webpackIgnore: true */ spec)` into `Promise.resolve(`${spec}`).then(s => require(s))`
// and drops the ignore comment, so bundlers warn "the request of a dependency is an expression".
// Put the comment back on that require in the build output. Fails the build if the pattern is gone, so it can't rot.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web-bot-auth.js');

const MARK = '/* webpackIgnore: true */ /* turbopackIgnore: true */ ';
// What tsc emits for `await import(spec)` with a variable spec: Promise.resolve(`${spec}`).then(s => __importStar(require(s)))
const EMITTED = /(Promise\.resolve\(`\$\{(\w+)\}`\)\.then\((\w+) => (?:__importStar\()?require\()(\3\))/g;

export function markOptionalRequires(src) {
  let n = 0;
  const out = src.replace(EMITTED, (_m, head, _spec, _arg, tail) => (n++, `${head}${MARK}${tail}`));
  return { out, n, already: src.includes(`require(${MARK}`) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, n, already } = markOptionalRequires(readFileSync(file, 'utf8'));
  if (n === 0 && !already) {
    console.error('mark-optional-requires: no optional require found in dist/web-bot-auth.js');
    process.exit(1);
  }
  writeFileSync(file, out);
}
