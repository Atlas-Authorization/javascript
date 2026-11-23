#!/usr/bin/env node
// Bundles test-extension/ against the BUILT packages and runs addons-linter on the zip. Run by CI after build.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ADDONS_LINTER_VERSION = '10.15.0'; // exact pin; bump deliberately
const FORBIDDEN = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'atlas-policy'];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'atlas-ext-'));
let failed = false;
const fail = (m) => {
  console.error(m);
  failed = true;
};

try {
  // Normal node resolution from the package, so this exercises the published entry points (dist).
  await build({
    entryPoints: [join(root, 'test-extension/background.js')],
    outfile: join(out, 'ext/background.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    absWorkingDir: root,
    logLevel: 'error',
  });
  cpSync(join(root, 'test-extension/manifest.json'), join(out, 'ext/manifest.json'));

  const code = readFileSync(join(out, 'ext/background.js'), 'utf8');
  for (const bad of FORBIDDEN) if (code.includes(bad)) fail(`bundle contains forbidden string: ${bad}`);

  const zip = join(out, 'ext.zip');
  execFileSync('zip', ['-qr', zip, '.'], { cwd: join(out, 'ext') });

  let report;
  try {
    report = execFileSync('npx', ['--yes', `addons-linter@${ADDONS_LINTER_VERSION}`, zip, '--output', 'json'], { encoding: 'utf8' });
  } catch (e) {
    report = e.stdout; // addons-linter exits non-zero when it finds errors
    if (!report) throw e;
  }
  const result = JSON.parse(report);
  for (const kind of ['errors', 'warnings']) {
    for (const m of result[kind] ?? []) fail(`addons-linter ${kind.slice(0, -1)}: ${m.code}: ${m.message} (${m.file ?? ''}:${m.line ?? ''})`);
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('extension bundle check passed: 0 errors, 0 warnings');
