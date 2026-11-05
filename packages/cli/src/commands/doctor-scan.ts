import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { SECRET_VALUE_SOURCE } from '../redact';

/**
 * `atlas doctor --scan-dir <path>` / `--scan-image <ref>`: secrets that end up in
 * image metadata. A build arg or `ENV` stays in the image for anyone who can pull
 * it; only the publishable key belongs there. Findings name a place and a rule and
 * NEVER the value.
 */

export interface ScanFinding {
  file: string;
  line: number | null;
  code: 'secret_value_in_build' | 'secret_name_in_build' | 'dev_and_prod_keys_together';
  message: string;
}

const SECRET_VALUE = new RegExp(SECRET_VALUE_SOURCE);
/** The variables that hold a secret whatever their value looks like (a `${VAR}` build arg passes it too). */
const SECRET_NAME = /(^|_)ATLAS_[A-Z0-9_]*SECRET|WEBHOOK_SECRET|HOOK_SECRET/;
const TEST_KEY = /\b(?:atlas_test_sk_|sk_test_)[A-Za-z0-9_-]+/;
const LIVE_KEY = /\b(?:atlas_live_sk_|sk_live_)[A-Za-z0-9_-]+/;

const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_FILE_BYTES = 1024 * 1024;
const VALUE_MESSAGE = 'A secret-key-shaped value is stored in the build. Rotate it and pass it at runtime; only the publishable key is a build arg.';
const nameMessage = (name: string) => `${name} is a secret passed to the build, where it stays in the image metadata. Set it at runtime; only the publishable key is a build arg.`;

const isDockerfile = (name: string) => /^Dockerfile(\..+)?$|\.dockerfile$/i.test(name);
const isCompose = (name: string) => /^(docker-)?compose[\w.-]*\.ya?ml$/i.test(name);
const isEnvFile = (name: string) => /\.env$|^\.env(\..+)?$/.test(name);

/** The files worth reading under `root`: no symlinks, dependency trees, big or binary files. */
function walk(root: string, out: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, out);
    } else if (entry.isFile() && (isDockerfile(entry.name) || isCompose(entry.name) || isEnvFile(entry.name)) && lstatSync(path).size <= MAX_FILE_BYTES) {
      const bytes = readFileSync(path);
      if (!bytes.subarray(0, 8192).includes(0)) out.push({ path, text: bytes.toString('utf8') });
    }
  }
  return out;
}

/** `ARG` defaults and `ENV` values, through line continuations. */
export function scanDockerfile(file: string, text: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  let instruction: 'ARG' | 'ENV' | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    const head = /^(ARG|ENV)\s+(.*)$/i.exec(line);
    if (head) instruction = head[1]!.toUpperCase() as 'ARG' | 'ENV';
    if (instruction) {
      const body = head ? head[2]! : line;
      if (SECRET_VALUE.test(body)) out.push({ file, line: i + 1, code: 'secret_value_in_build', message: VALUE_MESSAGE });
      else {
        for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:=(\S*)|\s+(\S+))?/g)) {
          const value = m[2] ?? m[3];
          if (!SECRET_NAME.test(m[1]!)) continue;
          // `ENV X=$X` only re-exports; the ARG it comes from is the finding.
          if (instruction === 'ENV' && (!value || value.startsWith('$'))) continue;
          out.push({ file, line: i + 1, code: 'secret_name_in_build', message: nameMessage(m[1]!) });
        }
      }
    }
    if (!line.endsWith('\\')) instruction = null;
  });
  return out;
}

/** `services.*.build.args`, in either the map or the list form. */
export function scanCompose(file: string, text: string): ScanFinding[] {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  if (doc.errors.length) return [];
  const out: ScanFinding[] = [];
  const at = (n: unknown) => {
    const start = (n as Node | null)?.range?.[0];
    return start === undefined ? null : counter.linePos(start).line;
  };
  const check = (name: string, value: string, node: unknown) => {
    if (SECRET_VALUE.test(value)) out.push({ file, line: at(node), code: 'secret_value_in_build', message: VALUE_MESSAGE });
    else if (SECRET_NAME.test(name)) out.push({ file, line: at(node), code: 'secret_name_in_build', message: nameMessage(name) });
  };
  const services = doc.get('services');
  if (!isMap(services)) return out;
  for (const service of services.items) {
    const build = isPair(service) && isMap(service.value) ? service.value.get('build') : null;
    const args = isMap(build) ? build.get('args') : null;
    if (isMap(args)) {
      for (const pair of args.items) {
        const name = isScalar(pair.key) ? String(pair.key.value) : '';
        check(name, isScalar(pair.value) ? String(pair.value.value ?? '') : '', pair.key);
      }
    } else if (isSeq(args)) {
      for (const item of args.items) {
        if (!isScalar(item)) continue;
        const [name = '', ...rest] = String(item.value).split('=');
        check(name, rest.join('='), item);
      }
    }
  }
  return out;
}

/** The secret keys in one env file, by line. */
function keyLines(text: string): Array<{ line: number; kind: 'test' | 'live' }> {
  const out: Array<{ line: number; kind: 'test' | 'live' }> = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim().startsWith('#')) return;
    if (TEST_KEY.test(raw)) out.push({ line: i + 1, kind: 'test' });
    if (LIVE_KEY.test(raw)) out.push({ line: i + 1, kind: 'live' });
  });
  return out;
}

/** True when a `*.env` file directly in `dir` holds a secret key of this kind. A missing folder holds none. */
export function folderHoldsKey(dir: string, kind: 'test' | 'live'): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isFile() && isEnvFile(e.name) && keyLines(readFileSync(join(dir, e.name), 'utf8')).some((h) => h.kind === kind),
  );
}

/** `*.env` files holding both a test and a live secret key, in one folder or in a folder and one below it. */
export function scanEnvFolders(files: Array<{ path: string; text: string }>): ScanFinding[] {
  const byDir = new Map<string, Array<{ file: string; line: number; kind: 'test' | 'live' }>>();
  for (const f of files.filter((x) => isEnvFile(basename(x.path)))) {
    const dir = dirname(f.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), ...keyLines(f.text).map((h) => ({ file: f.path, ...h }))]);
  }
  // Sibling folders stay fine: that is one environment per folder.
  const related = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  const out: ScanFinding[] = [];
  for (const [dir, hits] of byDir) {
    for (const h of hits) {
      if (![...byDir].some(([other, theirs]) => related(dir, other) && theirs.some((t) => t.kind !== h.kind))) continue;
      out.push({
        file: h.file,
        line: h.line,
        code: 'dev_and_prod_keys_together',
        message: `A ${h.kind === 'live' ? 'production' : 'development'} secret key, in a folder that holds both, directly or in a subfolder. A deploy script reading this folder can ship the wrong one; keep one environment per folder and delete stale files.`,
      });
    }
  }
  return out;
}

const captureDefault = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** Metadata of one image: every history line and the configured environment. */
async function scanImage(ctx: RunContext, ref: string): Promise<ScanFinding[]> {
  if (ref.startsWith('-')) throw new CliError(`--scan-image takes an image reference, got '${ref}'.`);
  const capture = ctx.execFile ?? captureDefault;
  const read = async (args: string[]) => {
    try {
      return await capture('docker', args);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') throw new CliError('docker was not found on PATH. Install Docker to use --scan-image, or use --scan-dir.');
      throw new CliError(`docker could not read image ${ref}. Pull or build it first.`);
    }
  };
  const history = await read(['history', '--no-trunc', '--format', '{{.CreatedBy}}', ref]);
  const inspected = await read(['inspect', '--format', '{{json .Config.Env}}', ref]);
  let env: string[] = [];
  try {
    const parsed = JSON.parse(inspected) as unknown;
    if (Array.isArray(parsed)) env = parsed.map(String);
  } catch {
    // shortcut: an unreadable Env is treated as empty, the history scan still runs; docker always prints JSON for this format.
  }
  const out: ScanFinding[] = [];
  const check = (place: string, line: number | null, text: string) => {
    if (SECRET_VALUE.test(text)) {
      out.push({ file: place, line, code: 'secret_value_in_build', message: VALUE_MESSAGE });
      return;
    }
    for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g)) {
      if (SECRET_NAME.test(m[1]!) && !m[2]!.startsWith('$')) out.push({ file: place, line, code: 'secret_name_in_build', message: nameMessage(m[1]!) });
    }
  };
  history.split(/\r?\n/).forEach((text, i) => check(`image ${ref} history`, i + 1, text));
  env.forEach((text, i) => check(`image ${ref} env`, i + 1, text));
  return out;
}

export async function scanForSecrets(ctx: RunContext, opts: { dir?: string; image?: string; json: boolean }): Promise<number> {
  const findings: ScanFinding[] = [];
  if (opts.dir !== undefined) {
    let files: Array<{ path: string; text: string }>;
    try {
      files = walk(opts.dir);
    } catch {
      throw new CliError(`--scan-dir: cannot read ${opts.dir}.`);
    }
    for (const f of files) {
      if (isDockerfile(basename(f.path))) findings.push(...scanDockerfile(f.path, f.text));
      if (isCompose(basename(f.path))) findings.push(...scanCompose(f.path, f.text));
    }
    findings.push(...scanEnvFolders(files));
  }
  if (opts.image !== undefined) findings.push(...(await scanImage(ctx, opts.image)));

  if (opts.json) printJson(ctx.io, { ok: findings.length === 0, findings });
  else if (!findings.length) ctx.io.out('No secrets found in build metadata.');
  else {
    for (const f of findings) ctx.io.out(`${f.file}${f.line === null ? '' : `:${f.line}`}  ${f.code}  ${f.message}`);
    ctx.io.out('');
    ctx.io.out(`${findings.length} finding(s).`);
  }
  return findings.length ? 1 : 0;
}
