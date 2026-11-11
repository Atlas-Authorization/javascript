import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';

/**
 * `atlas init --next --mount <path>`: the files a Next.js App Router app needs for
 * a path mount. Offline: nothing here needs a key. An existing file is refused
 * unless `--force`, before anything is written.
 */

const SEGMENT = /^[a-z0-9-~][a-z0-9_~.-]*$/;

function parseMount(raw: string | undefined): string {
  const path = raw ?? '/atlas';
  const segments = path.split('/').slice(1);
  if (!path.startsWith('/') || path.endsWith('/') || segments.length > 4 || !segments.every((s) => SEGMENT.test(s))) {
    throw new CliError(
      `--mount must look like /atlas: up to 4 lowercase segments, no trailing slash, none starting with '_' (the App Router never routes those). Got '${path}'.`,
    );
  }
  return path;
}

const mountRoute = (base: string) => `import { createMountHandler } from '@atlasauth/nextjs/server';

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = createMountHandler({ basePath: '${base}' });
`;

const VERIFY_ROUTE = `import { createVerifyHandler } from '@atlasauth/nextjs/server';

export const { GET } = createVerifyHandler();
`;

const YAML = `# Atlas config for this app. Plan with: atlas plan atlas.yaml
# Apply with: atlas apply atlas.yaml --secrets-file <a 0600 dotenv file>
instance:
  allowed_origins:
    - \${APP_ORIGIN}

# oauth_providers:
#   - provider: google
#     client_id: \${GOOGLE_CLIENT_ID}
#     mode: native          # needs no client_secret; mode: redirect does

# webhook_endpoints:
#   - url: \${APP_ORIGIN}/api/webhooks/atlas
#     enabled_events: ['user.created']
#     secret: \${ATLAS_WEBHOOK_SECRET}
#     active: false
`;

const ENV_EXAMPLE = `# Build args: safe to bake into an image. The publishable key is the only one.
NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY=

# Runtime only. Never pass these as build args: build args stay in the image metadata.
# Check with: atlas doctor --scan-dir .
ATLAS_SECRET_KEY=
ATLAS_WEBHOOK_SECRET=
ATLAS_PROXY_SECRET=

# Runtime, not secret.
ATLAS_UPSTREAM=
ATLAS_VERIFY_TOKEN=
ATLAS_ISSUER=
ATLAS_JWKS_URL=
APP_ORIGIN=
`;

/** Write the files; the paths written. */
export function scaffoldNext(ctx: RunContext, args: ParsedArgs): string[] {
  const base = parseMount(str(args.values, 'mount'));
  const root = resolve(str(args.values, 'dir') ?? '.');
  const app = !existsSync(join(root, 'app')) && existsSync(join(root, 'src', 'app')) ? join('src', 'app') : 'app';
  const files: Record<string, string> = {
    'atlas.yaml': YAML,
    [join(app, ...base.split('/').slice(1), '[[...path]]', 'route.ts')]: mountRoute(base),
    [join(app, '.well-known', 'atlas-verify', '[token]', 'route.ts')]: VERIFY_ROUTE,
    '.env.example': ENV_EXAMPLE,
  };
  const taken = Object.keys(files).filter((f) => existsSync(join(root, f)));
  if (taken.length && args.values.force !== true) {
    throw new CliError(`Already there: ${taken.join(', ')}. Nothing was written. Move them aside, or re-run with --force.`);
  }
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
    ctx.io.out(`Wrote ${file}`);
  }
  ctx.io.out(`Next: run 'atlas setup-guide' for the calls that claim ${base} and take it live.`);
  return Object.keys(files);
}

/** The create-atlas-app templates `atlas init <template>` (or `--template`) hands over to. */
export const INIT_TEMPLATES = ['nextjs-local-users'] as const;

/**
 * `atlas init nextjs-local-users [--dir <app>]`: scaffold the starter app that keeps your own user
 * table in step with Atlas, by running the published create-atlas-app generator. Offline files
 * only; nothing here needs a key. Returns the generator's exit code.
 */
export async function scaffoldTemplate(ctx: RunContext, template: string, dir: string | undefined): Promise<number> {
  const target = dir ?? 'my-atlas-app';
  const args = ['--yes', '@atlasauth/create-atlas-app@latest', target, '--template', template, '--yes'];
  ctx.io.out(`Scaffolding ${template} into ${target} with create-atlas-app...`);
  const run =
    ctx.exec ??
    ((cmd: string, a: string[], o: { cwd: string }) =>
      new Promise<number>((done) => {
        const child = spawn(cmd, a, { cwd: o.cwd, stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('error', () => done(127));
        child.on('exit', (code) => done(code ?? 1));
      }));
  const code = await run('npx', args, { cwd: process.cwd() });
  if (code !== 0) ctx.io.err(`create-atlas-app exited ${code}. Run it yourself: npx @atlasauth/create-atlas-app ${target} --template ${template}`);
  return code;
}
