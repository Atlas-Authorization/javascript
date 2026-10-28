import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';
import { mergeCsp, renderCsp } from './csp';

const MANIFEST = {
  product: 'atlas',
  surfaces: {
    'sign-in-button': { csp: { 'script-src': ['https://atlasauth.net'], 'connect-src': ['https://atlasauth.net'] }, requires: { 'style-src': [] } },
    'embedded-panel': {
      csp: { 'script-src': ['https://auth.example.com'], 'connect-src': ['https://auth.example.com'], 'frame-src': ['https://challenges.cloudflare.com'] },
    },
    'hosted-pages': { csp: { 'img-src': ['https://never.example'] } },
  },
  changes: [{ effective: '2026-12-01', surface: 'embedded-panel', add: { 'img-src': ['https://cdn.example.com'] }, note: 'avatars move to a CDN' }],
};

function ctx(io = captureIO(), seen: string[] = []): RunContext {
  const http: ConfigHttp = {
    get: async (p: string) => {
      seen.push(p);
      if (p === '/v1/instance') return { id: 'ins_1' } as never;
      return MANIFEST as never;
    },
    post: async () => ({}) as never,
    put: async () => ({}) as never,
    patch: async () => ({}) as never,
    delete: async () => undefined,
  };
  return {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: () => '',
  };
}

describe('mergeCsp', () => {
  it('unions the chosen surfaces and skips hosted pages by default', () => {
    expect(mergeCsp(MANIFEST)).toEqual({
      'script-src': ['https://atlasauth.net', 'https://auth.example.com'],
      'connect-src': ['https://atlasauth.net', 'https://auth.example.com'],
      'frame-src': ['https://challenges.cloudflare.com'],
    });
  });
  it('--shape picks one surface; redirect needs nothing', () => {
    expect(mergeCsp(MANIFEST, 'button')).toEqual({ 'script-src': ['https://atlasauth.net'], 'connect-src': ['https://atlasauth.net'] });
    expect(mergeCsp(MANIFEST, 'panel')['frame-src']).toEqual(['https://challenges.cloudflare.com']);
    expect(mergeCsp(MANIFEST, 'redirect')).toEqual({});
  });
});

describe('renderCsp', () => {
  const d = { 'script-src': ['https://a.example'], 'connect-src': ['https://a.example', 'wss://a.example'] };
  it('next', () => {
    const out = renderCsp('next', d);
    expect(out).toContain('async headers()');
    expect(out).toContain('"script-src": ["https://a.example"]');
  });
  it('express', () => {
    const out = renderCsp('express', d);
    expect(out).toContain("helmet.contentSecurityPolicy");
    expect(out).toContain(`'connect-src': ["https://a.example", "wss://a.example"],`);
  });
  it('nginx', () => {
    expect(renderCsp('nginx', d)).toContain('add_header Content-Security-Policy "script-src https://a.example; connect-src https://a.example wss://a.example" always;');
  });
});

describe('atlas csp', () => {
  it('resolves the instance, asks GET /v1/embed and prints the framework snippet', async () => {
    const seen: string[] = [];
    const io = captureIO();
    expect(await run(['csp', '--framework', 'nginx', '--shape', 'panel', '--origin', 'https://app.example.com'], ctx(io, seen))).toBe(0);
    expect(seen[0]).toBe('/v1/instance');
    const url = new URL(`https://x${seen[1]}`);
    expect(url.pathname).toBe('/v1/embed');
    expect(url.searchParams.get('instance')).toBe('ins_1');
    expect(url.searchParams.get('shape')).toBe('panel');
    expect(url.searchParams.get('origin')).toBe('https://app.example.com');
    expect(io.stdout()).toContain('add_header Content-Security-Policy');
    expect(io.stdout()).toContain('https://auth.example.com');
    expect(io.stderr()).toContain('avatars move to a CDN');
  });

  it('--instance skips the lookup; --json returns directives and the header', async () => {
    const seen: string[] = [];
    const io = captureIO();
    expect(await run(['csp', '--instance', 'ins_9', '--json'], ctx(io, seen))).toBe(0);
    expect(seen).toHaveLength(1);
    const out = JSON.parse(io.stdout());
    expect(out.header).toContain('script-src https://atlasauth.net https://auth.example.com');
    expect(out.upcoming).toHaveLength(1);
  });

  it('redirect integration needs nothing', async () => {
    const io = captureIO();
    expect(await run(['csp', '--shape', 'redirect'], ctx(io))).toBe(0);
    expect(io.stdout()).toContain('needs no Content Security Policy changes');
  });

  it('rejects an unknown framework or shape', async () => {
    expect(await run(['csp', '--framework', 'rails'], ctx())).toBe(1);
    expect(await run(['csp', '--shape', 'popup'], ctx())).toBe(1);
  });
});

describe('atlas csp with third-party manifests', () => {
  const THIRD = { schema: 'embed-v1', product: 'acme-cmp', surfaces: { banner: { csp: { 'script-src': ['https://cmp.acme.example'], 'connect-src': ['https://api.acme.example'] }, requires: { 'style-src': ["'unsafe-inline'"] } } } };

  it('merges a manifest fetched from a URL with the Atlas one', async () => {
    const c = ctx();
    c.fetch = (async () => new Response(JSON.stringify(THIRD), { status: 200 })) as unknown as typeof fetch;
    expect(await run(['csp', '--framework', 'nginx', '--manifest', 'https://cmp.acme.example/.well-known/atlas-embed.json'], c)).toBe(0);
    const out = (c.io as ReturnType<typeof captureIO>).stdout();
    expect(out).toContain('https://atlasauth.net https://auth.example.com https://cmp.acme.example');
    expect(out).toContain("style-src 'unsafe-inline'");
  });

  it('--no-atlas uses only the listed manifests (files work too) and needs no credentials', async () => {
    const c = ctx();
    c.config = new MemoryConfigStore();
    c.readFile = () => JSON.stringify(THIRD);
    expect(await run(['csp', '--no-atlas', '--manifest', './cmp.json', '--json'], c)).toBe(0);
    const out = JSON.parse((c.io as ReturnType<typeof captureIO>).stdout());
    expect(out.directives['script-src']).toEqual(['https://cmp.acme.example']);
  });

  it('--no-atlas without a manifest, or a bad manifest, is an error', async () => {
    expect(await run(['csp', '--no-atlas'], ctx())).toBe(1);
    const c = ctx();
    c.readFile = () => 'nope';
    expect(await run(['csp', '--no-atlas', '--manifest', 'x.json'], c)).toBe(1);
  });
});
