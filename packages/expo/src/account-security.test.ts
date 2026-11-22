import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { createAccountSecurityActions } from './account-security';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('@atlasauth/expo/account-security', () => {
  it('imports no React, React Native or provider code', () => {
    const src = readFileSync(new URL('./account-security.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['@atlasauth/js']);
  });

  it('binds every security call to the client', async () => {
    const seen: string[] = [];
    const client = new FapiClient({
      publishableKey: 'pk_test_x',
      baseUrl: 'https://fapi.test',
      fetchImpl: (async (u: string, i: RequestInit) => {
        seen.push(`${i.method ?? 'GET'} ${u.replace('https://fapi.test', '')}`);
        return reply({ object: 'list', data: [], preferences: [], codes: [], sessions_revoked: 0 });
      }) as unknown as typeof fetch,
    });
    const a = createAccountSecurityActions(client);
    await a.listSessions();
    await a.revokeAllSessions();
    await a.listMfaFactors();
    await a.regenerateBackupCodes();
    await a.listPasskeys();
    await a.getNotificationPreferences();
    expect(seen).toEqual([
      'GET /v1/client/sessions',
      'POST /v1/client/sessions/revoke_all',
      'GET /v1/client/me/mfa',
      'POST /v1/client/me/mfa/backup_codes',
      'GET /v1/client/me/passkeys',
      'GET /v1/client/me/notification_preferences',
    ]);
  });

  it('declares the subpath and keeps the root entry', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
    expect(pkg.exports['./account-security'].default).toBe('./dist/account-security.js');
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.sideEffects).toEqual(['./dist/index.js']);
  });

  it('serves a session entry that loads no React, React Native or provider code', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./session'].default).toBe('./dist/session.js');
    expect(pkg.peerDependencies['@atlasauth/react']).toBeDefined();
    expect(pkg.dependencies).toBeUndefined();
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(new URL(`./${file}.ts`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)) {
        const spec = m[1]!;
        if (spec.startsWith('./')) walk(spec.slice(2));
        else expect(spec, `${file} imports ${spec}`).toBe('@atlasauth/js');
      }
    };
    walk('session');
    expect([...seen].sort()).toEqual(['bridge', 'cache-fetch', 'native-session', 'session', 'token-cache']);
  });
});
