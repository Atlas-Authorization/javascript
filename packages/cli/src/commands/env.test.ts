import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { envApiUrl } from './shared';

const LIVE = {
  id: 'ins_1',
  environment: 'production',
  publishable_key: 'pk_live_1',
  frontend_api_host: 'auth.example.com',
  issuer: 'https://auth.example.com',
  discovery_url: 'https://auth.example.com/.well-known/openid-configuration',
  jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
};

function ctx(env: NodeJS.ProcessEnv = {}, urls: string[] = []): RunContext {
  const http: ConfigHttp = {
    get: async () => LIVE as never,
    post: async () => ({}) as never,
    put: async () => ({}) as never,
    patch: async () => ({}) as never,
    delete: async () => undefined,
  };
  return {
    io: captureIO(),
    env,
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://stored.example', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: (o) => {
      urls.push(o.apiUrl);
      return http;
    },
    readFile: () => '',
  };
}

describe('API base env naming', () => {
  it('accepts ATLAS_API_BASE and ATLAS_API_URL, BASE first, blanks ignored', () => {
    expect(envApiUrl({})).toBeUndefined();
    expect(envApiUrl({ ATLAS_API_URL: 'https://u' })).toBe('https://u');
    expect(envApiUrl({ ATLAS_API_BASE: 'https://b' })).toBe('https://b');
    expect(envApiUrl({ ATLAS_API_BASE: 'https://b', ATLAS_API_URL: 'https://u' })).toBe('https://b');
    expect(envApiUrl({ ATLAS_API_BASE: '  ', ATLAS_API_URL: 'https://u' })).toBe('https://u');
  });

  it('whoami reports an ATLAS_API_BASE override as coming from the environment', async () => {
    const c = ctx({ ATLAS_API_BASE: 'https://base.example' });
    expect(await run(['whoami'], c)).toBe(0);
    const out = (c.io as ReturnType<typeof captureIO>).stdout();
    expect(out).toContain('https://base.example');
  });
});

describe('atlas env without --product (live instance)', () => {
  it('prints public values from GET /v1/instance, no secret references', async () => {
    const urls: string[] = [];
    const c = ctx({ ATLAS_API_BASE: 'https://base.example' }, urls);
    expect(await run(['env', '--format', 'dotenv'], c)).toBe(0);
    const out = (c.io as ReturnType<typeof captureIO>).stdout();
    expect(urls[0]).toBe('https://base.example');
    expect(out).toContain('ATLAS_PUBLISHABLE_KEY=pk_live_1');
    expect(out).toContain('ATLAS_FRONTEND_API=https://auth.example.com');
    expect(out).toContain('ATLAS_ISSUER=https://auth.example.com');
    expect(out).toContain('ATLAS_API_BASE=https://base.example');
    expect(out).toContain('ATLAS_API_URL=https://base.example');
    expect(out).not.toContain('_FILE=');
  });

  it('k8s and vercel work too', async () => {
    const k = ctx();
    expect(await run(['env', '--format', 'k8s'], k)).toBe(0);
    expect((k.io as ReturnType<typeof captureIO>).stdout()).toContain('ATLAS_ISSUER: "https://auth.example.com"');
    const v = ctx();
    expect(await run(['env', '--format', 'vercel'], v)).toBe(0);
    expect((v.io as ReturnType<typeof captureIO>).stdout()).toContain('vercel env add ATLAS_PUBLISHABLE_KEY production');
  });
});
