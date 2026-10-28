import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeBetterAuth, literalOf, propOf, type StaticValue } from './analyze';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ba-analyze-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

const opt = (v: StaticValue | undefined, ...path: string[]): StaticValue | undefined =>
  path.reduce<StaticValue | undefined>((acc, k) => propOf(acc, k), v);

describe('analyzeBetterAuth', () => {
  it('reads literals, folds arithmetic and resolves env vars by name only', () => {
    write({
      'auth.ts': `
        import { betterAuth } from 'better-auth';
        const WEEK = 60 * 60 * 24 * 7;
        export const auth = betterAuth({
          baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
          secret: import.meta.env.AUTH_SECRET,
          session: { expiresIn: WEEK, updateAge: WEEK / 7 },
          emailAndPassword: { enabled: true, minPasswordLength: 12 },
          socialProviders: {
            google: { clientId: process.env['GOOGLE_ID']!, clientSecret: process.env.GOOGLE_SECRET as string },
            github: { clientId: Bun.env.GH_ID, clientSecret: Deno.env.get('GH_SECRET') },
          },
          trustedOrigins: [\`https://\${process.env.APP_HOST}\`, 'https://a.example'],
        });
      `,
    });
    const a = analyzeBetterAuth(dir);
    expect(a.instances).toHaveLength(1);
    const o = a.instances[0]!.options;
    expect(opt(o, 'session', 'expiresIn')).toMatchObject({ kind: 'number', value: 604800 });
    expect(opt(o, 'session', 'updateAge')).toMatchObject({ kind: 'number', value: 86400 });
    expect(opt(o, 'baseURL')).toMatchObject({ kind: 'env', name: 'BETTER_AUTH_URL', fallback: { kind: 'string', value: 'http://localhost:3000' } });
    expect(opt(o, 'secret')).toMatchObject({ kind: 'env', name: 'AUTH_SECRET' });
    expect(opt(o, 'socialProviders', 'google', 'clientId')).toMatchObject({ kind: 'env', name: 'GOOGLE_ID' });
    expect(opt(o, 'socialProviders', 'google', 'clientSecret')).toMatchObject({ kind: 'env', name: 'GOOGLE_SECRET' });
    expect(opt(o, 'socialProviders', 'github', 'clientId')).toMatchObject({ kind: 'env', name: 'GH_ID' });
    expect(opt(o, 'socialProviders', 'github', 'clientSecret')).toMatchObject({ kind: 'env', name: 'GH_SECRET' });
    const origins = opt(o, 'trustedOrigins');
    expect(origins?.kind).toBe('array');
    const first = (origins as Extract<StaticValue, { kind: 'array' }>).items[0]!;
    expect(first).toMatchObject({ kind: 'template', parts: ['https://', { kind: 'env', name: 'APP_HOST' }] });
    expect(literalOf(opt(o, 'emailAndPassword'))).toEqual({ enabled: true, minPasswordLength: 12 });
    expect(opt(o, 'session', 'expiresIn')?.loc).toEqual({ file: 'auth.ts', line: 7 });
  });

  it('follows imports across files, tsconfig paths, spreads and re-exports', () => {
    write({
      'tsconfig.json': `{ /* comment */ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"] }, }, }`,
      'src/env.ts': `import { createEnv } from '@t3-oss/env-core';\nexport const env = createEnv({ server: {} });`,
      'src/config/base.ts': `import { env } from '~/env';\nexport const base = { secret: env.BETTER_AUTH_SECRET, appName: 'Split' };`,
      'src/config/index.ts': `export * from './base';\nexport { sessionOpts as session } from './session';`,
      'src/config/session.ts': `export const sessionOpts = { expiresIn: 3600 };`,
      'src/plugins.ts': `import { twoFactor as tf } from 'better-auth/plugins';\nconst make = () => [tf({ issuer: 'X' })];\nexport default make;`,
      'src/auth.ts': `
        import { betterAuth as ba } from 'better-auth';
        import { base, session } from './config';
        import makePlugins from '~/plugins';
        export const auth = ba({ ...base, session, plugins: makePlugins() });
      `,
    });
    const a = analyzeBetterAuth(dir);
    const o = a.instances[0]!.options;
    expect(a.instances[0]!.loc.file).toBe('src/auth.ts');
    expect(opt(o, 'secret')).toMatchObject({ kind: 'env', name: 'BETTER_AUTH_SECRET' });
    expect(opt(o, 'appName')).toMatchObject({ kind: 'string', value: 'Split' });
    expect(opt(o, 'session', 'expiresIn')).toMatchObject({ kind: 'number', value: 3600 });
    const plugins = opt(o, 'plugins');
    expect(plugins).toMatchObject({ kind: 'array', items: [{ kind: 'call', callee: 'tf', imported: { module: 'better-auth/plugins', name: 'twoFactor' } }] });
  });

  it('reads access-control roles, Better Auth default statements and function-scoped instances', () => {
    write({
      'perm.ts': `
        import { createAccessControl } from 'better-auth/plugins/access';
        import { defaultStatements, adminAc } from 'better-auth/plugins/organization/access';
        export const ac = createAccessControl({ ...defaultStatements, project: ['create', 'share'] });
        export const editor = ac.newRole({ ...adminAc.statements, project: ['create'] });
      `,
      'worker.ts': `
        import { betterAuth } from 'better-auth';
        import { organization } from 'better-auth/plugins';
        import { ac, editor } from './perm';
        export const createAuth = (env: Env) => betterAuth({
          secret: env.BETTER_AUTH_SECRET,
          socialProviders: { github: { clientId: env.GH_ID, clientSecret: env.GH_SECRET } },
          plugins: [organization({ ac, roles: { editor } })],
        });
      `,
    });
    const a = analyzeBetterAuth(dir);
    const o = a.instances[0]!.options;
    expect(opt(o, 'secret')).toMatchObject({ kind: 'env', name: 'BETTER_AUTH_SECRET' });
    const org = (opt(o, 'plugins') as Extract<StaticValue, { kind: 'array' }>).items[0] as Extract<StaticValue, { kind: 'call' }>;
    const editor = opt(org.args[0], 'roles', 'editor') as Extract<StaticValue, { kind: 'call' }>;
    expect(editor.callee).toBe('ac.newRole');
    expect(literalOf(editor.args[0])).toEqual({
      organization: ['update'],
      invitation: ['create', 'cancel'],
      member: ['create', 'update', 'delete'],
      team: ['create', 'update', 'delete'],
      ac: ['create', 'read', 'update', 'delete'],
      project: ['create'],
    });
    const statements = (opt(org.args[0], 'ac') as Extract<StaticValue, { kind: 'call' }>).args[0];
    expect(literalOf(opt(statements, 'project'))).toEqual(['create', 'share']);
    expect(literalOf(opt(statements, 'member'))).toEqual(['create', 'update', 'delete']);
  });

  it('keeps what cannot be read as typed placeholders with a location', () => {
    write({
      'auth.ts': `
        import { betterAuth } from 'better-auth';
        import { getOrigins } from 'some-lib';
        export const auth = betterAuth({
          trustedOrigins: getOrigins(),
          emailAndPassword: { enabled: process.env.NODE_ENV === 'production' ? true : false },
          databaseHooks: { user: { create: { after: async (user) => { console.log(user); } } } },
          socialProviders: { google: { clientId: 'id', clientSecret: 's', mapProfileToUser: (p) => ({ name: p.given_name }) } },
        });
      `,
    });
    const o = analyzeBetterAuth(dir).instances[0]!.options;
    expect(opt(o, 'trustedOrigins')).toMatchObject({ kind: 'call', callee: 'getOrigins', imported: { module: 'some-lib' } });
    expect(opt(o, 'emailAndPassword', 'enabled')).toMatchObject({ kind: 'unknown', reason: 'a runtime condition', loc: { line: 6 } });
    expect(opt(o, 'databaseHooks', 'user', 'create', 'after')).toMatchObject({ kind: 'function', async: true, params: ['user'] });
    const map = opt(o, 'socialProviders', 'google', 'mapProfileToUser') as Extract<StaticValue, { kind: 'function' }>;
    expect(propOf(map.returns, 'name')).toMatchObject({ kind: 'param', name: 'p', path: ['given_name'] });
  });

  it('finds several instances, honours --entry, and reports parse errors without failing', () => {
    write({
      'a.ts': `import { betterAuth } from 'better-auth';\nexport const a = betterAuth({ appName: 'A' });`,
      'b.ts': `import { betterAuth } from 'better-auth';\nexport const b = betterAuth({ appName: 'B' });`,
      'broken.ts': `import { betterAuth } from 'better-auth';\nconst x = betterAuth({ ;`,
      'client.ts': `import { createAuthClient } from 'better-auth/react';\nexport const c = createAuthClient();`,
    });
    const all = analyzeBetterAuth(dir);
    expect(all.instances.map((i) => i.loc.file)).toEqual(['a.ts', 'b.ts']);
    expect(all.parseErrors.map((e) => e.file)).toEqual(['broken.ts']);
    const one = analyzeBetterAuth(dir, { entry: 'b.ts' });
    expect(one.instances).toHaveLength(1);
    expect(opt(one.instances[0]!.options, 'appName')).toMatchObject({ value: 'B' });
  });

  it('does not treat a local function named betterAuth from elsewhere as the library call', () => {
    write({
      'auth.ts': `import { betterAuth } from './my-wrapper';\nexport const a = betterAuth({ appName: 'X' });`,
      'my-wrapper.ts': `export function betterAuth(o: unknown) { return o; }`,
    });
    expect(analyzeBetterAuth(dir).instances).toHaveLength(0);
  });
});
