import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

/**
 * `atlas migrate code --from <vendor>` end to end over a temp Next.js app:
 * dry run by default (diff + report, nothing written), `--yes` writes, and a
 * second run is a no-op.
 */
const PAGE = `import { getServerSession } from 'next-auth';\nimport { authOptions } from '@/lib/auth';\n\nexport default async function Page() {\n  const session = await getServerSession(authOptions);\n  return <p>{session?.user?.email}</p>;\n}\n`;
const ROUTE = `import NextAuth from 'next-auth';\nimport GitHub from 'next-auth/providers/github';\n\nconst handler = NextAuth({ providers: [GitHub] });\nexport { handler as GET, handler as POST };\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-migrate-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '^15.0.0', 'next-auth': '^4.24.0' } }));
  mkdirSync(join(dir, 'app', 'dashboard'), { recursive: true });
  mkdirSync(join(dir, 'app', 'api', 'auth', '[...nextauth]'), { recursive: true });
  writeFileSync(join(dir, 'app', 'dashboard', 'page.tsx'), PAGE);
  writeFileSync(join(dir, 'app', 'api', 'auth', '[...nextauth]', 'route.ts'), ROUTE);
  writeFileSync(join(dir, '.env.local'), 'NEXTAUTH_SECRET=abc\nNEXTAUTH_URL=http://localhost:3000\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (io: ReturnType<typeof captureIO>): RunContext => ({
  io,
  env: {},
  config: new MemoryConfigStore(),
  prompt: { text: async () => '', secret: async () => '' },
  makeClient: () => ({}) as ManagementClient,
  readFile: (p) => readFileSync(p, 'utf8'),
});

describe('atlas migrate code', () => {
  it('dry-runs by default: prints the diff and the manual report, writes nothing', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'code', '--from', 'authjs', dir], ctx(io))).toBe(0);
    const out = io.stdout();
    expect(out).toContain("+ import { getServerSessionCompat } from '@atlasauth/nextjs/compat';");
    expect(out).toContain('dry run: nothing written');
    expect(out).toMatch(/app\/api\/auth\/\[\.\.\.nextauth\]\/route\.ts:1 {2}this Auth\.js route is no longer used/);
    expect(out).toMatch(/\.env\.local:1 {2}NEXTAUTH_SECRET: remove; set ATLAS_SECRET_KEY/);
    expect(out).toContain('npm install @atlasauth/nextjs');
    expect(out).toContain('npm uninstall next-auth');
    expect(out).toContain('atlas import --from authjs');
    expect(readFileSync(join(dir, 'app', 'dashboard', 'page.tsx'), 'utf8')).toBe(PAGE);
  });

  it('--yes writes, and a second run changes nothing', async () => {
    const io = captureIO();
    await run(['migrate', 'code', '--from', 'next-auth', dir, '--yes'], ctx(io));
    const page = readFileSync(join(dir, 'app', 'dashboard', 'page.tsx'), 'utf8');
    expect(page).toContain('await getServerSessionCompat(authOptions)');
    expect(page).not.toContain("from 'next-auth'");

    const again = captureIO();
    await run(['migrate', 'code', '--from', 'authjs', dir, '--yes', '--json'], ctx(again));
    const result = JSON.parse(again.stdout());
    expect(result.files_changed).toBe(0);
    expect(result.written).toBe(true);
    expect(readFileSync(join(dir, 'app', 'dashboard', 'page.tsx'), 'utf8')).toBe(page);
  });

  it('--json reports diffs, manual items, packages and env', async () => {
    const io = captureIO();
    await run(['migrate', 'code', '--from', 'authjs', dir, '--json'], ctx(io));
    const result = JSON.parse(io.stdout());
    expect(result.object).toBe('code_migration');
    expect(result.written).toBe(false);
    expect(result.changes.map((c: { path: string }) => c.path).sort()).toEqual([
      'app/api/auth/[...nextauth]/route.ts',
      'app/dashboard/page.tsx',
    ]);
    expect(result.manual.every((m: { line: number }) => m.line > 0)).toBe(true);
    expect(result.packages.remove).toEqual(['next-auth']);
    expect(result.env_to_set).toContain('NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
  });

  it('rejects an unknown vendor and a missing subcommand', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'code', '--from', 'nope', dir], ctx(io))).toBe(1);
    expect(io.stderr()).toContain("Unknown --from 'nope'");
    expect(await run(['migrate', '--from', 'authjs'], ctx(io))).toBe(1);
    expect(io.stderr()).toContain('migrate needs a subcommand: code, better-auth.');
  });
});

describe('atlas migrate code: hand-rolled OIDC', () => {
  const OIDC_FILE = `import { Issuer, generators } from 'openid-client';\n\nconst issuer = await Issuer.discover(process.env.OIDC_ISSUER!);\nconst client = new issuer.Client({ client_id: process.env.OIDC_CLIENT_ID! });\nexport const go = () => client.authorizationUrl({ state: generators.state() });\n`;

  beforeEach(() => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0', 'openid-client': '^5.6.0' } }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'login.ts'), OIDC_FILE);
    writeFileSync(join(dir, '.env'), 'OIDC_ISSUER=https://idp.example\nOIDC_CLIENT_ID=abc\n');
  });

  it('openid-client: dry run reports each step with the oidc.* call that replaces it', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'code', '--from', 'openid-client', dir], ctx(io))).toBe(0);
    const out = io.stdout();
    expect(out).toContain("import { oidc } from '@atlasauth/backend';");
    expect(out).toContain('oidc.start(');
    expect(out).toContain('npm install @atlasauth/backend');
    expect(out).toContain('npm uninstall openid-client');
    expect(out).toMatch(/\.env:1 {2}OIDC_ISSUER: set to your Atlas issuer/);
    expect(out).not.toContain('atlas import --from');
    expect(readFileSync(join(dir, 'src', 'login.ts'), 'utf8')).toBe(OIDC_FILE);
  });

  it('--yes writes TODO markers and a second run is a no-op', async () => {
    await run(['migrate', 'code', '--from', 'openid-client', dir, '--yes'], ctx(captureIO()));
    const after = readFileSync(join(dir, 'src', 'login.ts'), 'utf8');
    expect(after).toContain("import { oidc } from '@atlasauth/backend';");
    expect(after).toContain('TODO(atlas-migrate)');
    const again = captureIO();
    await run(['migrate', 'code', '--from', 'generic-oidc', dir, '--yes', '--json'], ctx(again));
    expect(JSON.parse(again.stdout()).files_changed).toBe(0);
  });

  it('rejects an unknown vendor and lists the new ones', async () => {
    const io = captureIO();
    expect(await run(['migrate', 'code', '--from', 'frob', dir], ctx(io))).toBe(1);
    expect(io.stderr()).toContain('openid-client');
    expect(io.stderr()).toContain('generic-oidc');
  });
});
