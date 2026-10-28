#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportBetterAuth, type BetterAuthLike, type ExportBetterAuthOptions } from './export';
import { fetchImportKey, uploadBundle } from './atlas';
import { MODEL_ORDER, type BetterAuthModel } from './format';
import { PACKAGE_VERSION } from './version';

/**
 * `atlas-better-auth-export` — run the exporter from a script or CI job.
 *
 *   npx atlas-better-auth-export --out better-auth.atlas-bundle --public-key <kid:key>
 *
 * It loads your Better Auth instance from the config module (--config, or the
 * first of the usual places Better Auth's own CLI looks: auth.ts, lib/auth.ts,
 * utils/auth.ts, each also under src/ and app/; the `auth` export, or the
 * default export), seals the bundle to your Atlas instance's import key
 * (fetched with ATLAS_SECRET_KEY, or passed with --public-key) and, with
 * --upload, uploads it so Atlas prepares the dry-run report.
 */

const HELP = `atlas-better-auth-export ${PACKAGE_VERSION}

Export a Better Auth app into an encrypted bundle for Atlas.

Usage:
  atlas-better-auth-export --out <file> --public-key <kid:key> [options]

Options:
  --config <path>             Module that exports your Better Auth instance
                              (default: the first of auth.ts, lib/auth.ts, utils/auth.ts,
                              also under src/ and app/, .ts or .js, that exists)
  --export <name>             Export name to use (default: auth, then default)
  --out <file>                Bundle file to write (default: better-auth.atlas-bundle)
  --public-key <kid:key>      Atlas import key; otherwise fetched with the secret key
  --secret-key <sk_...>       Atlas secret key (default: ATLAS_SECRET_KEY)
  --api-url <url>             Atlas API URL (default: ATLAS_API_BASE or ATLAS_API_URL, else https://api.atlasauth.net)
  --upload                    Upload the bundle and print the dry-run report
  --no-sessions               Leave live sessions out
  --oauth-tokens              Include social access/refresh tokens
  --verifications             Include pending verification rows
  --models <a,b,...>          Only these models
  --page-size <n>             Rows per database page (default 500)
  --api-key-hashing <mode>    auto | sha256 | none (for disableKeyHashing)
  --oauth-client-secrets <m>  hashed | encrypted | plain
  -h, --help                  Show this help
`;

interface Args {
  [k: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

const CONFIG_DIRS = ['', 'lib/', 'utils/', 'src/', 'src/lib/', 'src/utils/', 'app/', 'app/lib/', 'app/utils/', 'server/', 'src/server/'];
const CONFIG_EXTS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];

/** The config module path: --config, else the first conventional auth module that exists. */
export function findAuthConfig(cwd = process.cwd(), exists: (p: string) => boolean = existsSync): string | null {
  for (const dir of CONFIG_DIRS) {
    for (const ext of CONFIG_EXTS) {
      const candidate = `${dir}auth.${ext}`;
      if (exists(resolve(cwd, candidate))) return candidate;
    }
  }
  return null;
}

// A real dynamic import, kept out of reach of the CommonJS compile.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<Record<string, unknown>>;

/** Load the config module, TypeScript included (through the app's own jiti or tsx when needed). */
export async function loadAuthModule(path: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(abs)) throw new Error(`Config module not found: ${abs}`);
  const url = pathToFileURL(abs).href;
  try {
    return await dynamicImport(url);
  } catch (err) {
    const isTs = /\.(c|m)?tsx?$/.test(abs);
    if (!isTs) throw err;
    const req = createRequire(resolve(cwd, 'package.json'));
    try {
      const jitiMod = req('jiti') as { createJiti?: (u: string) => { import(p: string): Promise<unknown> } } & ((f: string) => (p: string) => unknown);
      if (typeof jitiMod.createJiti === 'function') {
        return (await jitiMod.createJiti(url).import(abs)) as Record<string, unknown>;
      }
      return (jitiMod as (f: string) => (p: string) => unknown)(abs)(abs) as Record<string, unknown>;
    } catch {
      /* fall through to tsx */
    }
    try {
      const tsxPath = req.resolve('tsx/esm/api');
      const tsx = (await dynamicImport(pathToFileURL(tsxPath).href)) as { tsImport?: (p: string, parent: string) => Promise<Record<string, unknown>> };
      if (tsx.tsImport) return await tsx.tsImport(abs, url);
    } catch {
      /* fall through */
    }
    throw new Error(
      `Could not load ${path}: it is TypeScript and neither jiti nor tsx is installed in this project. Run "npx tsx node_modules/.bin/atlas-better-auth-export …", or call exportBetterAuth() from a script.`,
    );
  }
}

export function pickAuth(mod: Record<string, unknown>, name?: string): BetterAuthLike {
  const candidates = name ? [mod[name]] : [mod.auth, mod.default, (mod.default as Record<string, unknown> | undefined)?.auth];
  for (const c of candidates) {
    if (c && typeof c === 'object' && '$context' in (c as object)) return c as BetterAuthLike;
  }
  throw new Error(name ? `The config module has no Better Auth instance named "${name}".` : 'The config module exports no Better Auth instance (export it as `auth` or as the default export).');
}

export async function main(argv = process.argv.slice(2), log = (s: string) => process.stdout.write(`${s}\n`)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    log(HELP);
    return 0;
  }
  const config = typeof args.config === 'string' ? args.config : findAuthConfig();
  if (!config) {
    log('No Better Auth config module found (looked for auth.ts in ./, lib/, utils/, src/, app/). Pass --config <path>.');
    return 2;
  }
  const secretKey = typeof args['secret-key'] === 'string' ? args['secret-key'] : process.env.ATLAS_SECRET_KEY;
  const apiUrl = typeof args['api-url'] === 'string' ? args['api-url'] : process.env.ATLAS_API_BASE?.trim() || process.env.ATLAS_API_URL?.trim() || undefined;
  let publicKey: ExportBetterAuthOptions['publicKey'];
  if (typeof args['public-key'] === 'string') publicKey = args['public-key'];
  else if (secretKey) publicKey = await fetchImportKey({ secretKey, apiUrl });
  else {
    log('Pass --public-key, or set ATLAS_SECRET_KEY so the import key can be fetched.');
    return 2;
  }
  const models = typeof args.models === 'string' ? args.models.split(',').map((m) => m.trim()).filter(Boolean) : undefined;
  if (models?.some((m) => !(MODEL_ORDER as readonly string[]).includes(m))) {
    log(`Unknown model in --models. Known: ${MODEL_ORDER.join(', ')}`);
    return 2;
  }
  const out = typeof args.out === 'string' ? args.out : 'better-auth.atlas-bundle';
  const auth = pickAuth(await loadAuthModule(config), typeof args.export === 'string' ? args.export : undefined);
  const result = await exportBetterAuth(auth, {
    out,
    publicKey,
    sessions: args.sessions !== false,
    oauthTokens: args['oauth-tokens'] === true,
    verifications: args.verifications === true,
    models: models as BetterAuthModel[] | undefined,
    pageSize: typeof args['page-size'] === 'string' ? Number(args['page-size']) : undefined,
    apiKeyHashing: (args['api-key-hashing'] as ExportBetterAuthOptions['apiKeyHashing']) ?? undefined,
    oauthClientSecretStorage: (args['oauth-client-secrets'] as ExportBetterAuthOptions['oauthClientSecretStorage']) ?? undefined,
    onProgress: ({ model, exported }) => log(`  ${model}: ${exported}`),
  });
  log(`Wrote ${out} (${result.bytes} bytes, ${result.chunks} chunks, sha256 ${result.sha256}).`);
  for (const [m, n] of Object.entries(result.counts)) if (n) log(`  ${m.padEnd(18)} ${n}`);
  for (const [m, o] of Object.entries(result.omitted)) log(`  ${m.padEnd(18)} ${o.count} not exported: ${o.reason}`);
  for (const w of result.manifest.warnings) log(`warning: ${w}`);
  if (args.upload) {
    if (!secretKey) {
      log('--upload needs ATLAS_SECRET_KEY (or --secret-key).');
      return 2;
    }
    const imp = await uploadBundle({ secretKey, apiUrl, path: out, onPart: (n, of) => log(`  uploaded part ${n}/${of}`) });
    log(`Uploaded as import ${imp.id} (status ${imp.status}). Review the dry-run report, then apply it:`);
    log(`  atlas import --from better-auth --import ${imp.id}`);
  } else {
    log('Import it into Atlas:');
    log(`  atlas import --from better-auth --bundle ${out}`);
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`atlas-better-auth-export: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
