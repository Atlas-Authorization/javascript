import { describe, expect, it, vi } from 'vitest';
import { AtlasConfigError, resolveFrontendApi } from './config';

/**
 * `frontendApi` cannot be derived from the publishable key, and a provider that
 * fell back to relative URLs looked exactly like "signed out". The resolver
 * turns every such mistake into a clear, typed error at mount.
 */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AtlasConfigError);
    return (e as AtlasConfigError).code;
  }
  return undefined;
}

describe('resolveFrontendApi', () => {
  it('throws FRONTEND_API_REQUIRED when missing, non-string or blank', () => {
    for (const v of [undefined, null, '   ', 42]) {
      expect(codeOf(() => resolveFrontendApi(v)), String(v)).toBe('FRONTEND_API_REQUIRED');
    }
  });

  it('names the component and suggests a value in the message', () => {
    expect(() => resolveFrontendApi(undefined, { component: '<AtlasProvider>' })).toThrow(
      /<AtlasProvider> needs `frontendApi`.*https:\/\/atlasauth\.net.*Got undefined/,
    );
  });

  it('accepts absolute https URLs and drops a trailing slash', () => {
    expect(resolveFrontendApi('https://auth.example.com')).toBe('https://auth.example.com');
    expect(resolveFrontendApi('https://auth.example.com/')).toBe('https://auth.example.com');
    expect(resolveFrontendApi(' https://atlasauth.net ')).toBe('https://atlasauth.net');
    expect(resolveFrontendApi('https://example.com/auth/')).toBe('https://example.com/auth');
  });

  it('accepts http only for localhost and local development hosts', () => {
    expect(resolveFrontendApi('http://localhost:4000')).toBe('http://localhost:4000');
    expect(resolveFrontendApi('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    expect(resolveFrontendApi('http://[::1]:4000')).toBe('http://[::1]:4000');
    expect(resolveFrontendApi('http://atlas.localhost')).toBe('http://atlas.localhost');
    expect(codeOf(() => resolveFrontendApi('http://auth.example.com'))).toBe('FRONTEND_API_INVALID');
  });

  it('rejects relative hosts, other schemes, credentials, queries and fragments', () => {
    for (const v of [
      'auth.example.com',
      '//auth.example.com',
      'ftp://auth.example.com',
      'javascript:alert(1)',
      'https://user:pw@auth.example.com',
      'https://auth.example.com/?x=1',
      'https://auth.example.com/#x',
    ]) {
      expect(codeOf(() => resolveFrontendApi(v)), v).toBe('FRONTEND_API_INVALID');
    }
  });

  it('maps "same-origin" and root-relative prefixes to relative request paths', () => {
    expect(resolveFrontendApi('same-origin')).toBe('');
    expect(resolveFrontendApi('/')).toBe('');
    expect(resolveFrontendApi('/atlas/')).toBe('/atlas');
  });

  it('keeps the deprecated "" working as same-origin, warning once', async () => {
    vi.resetModules();
    const fresh = await import('./config');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(fresh.resolveFrontendApi('', { component: '<AtlasProvider>' })).toBe('');
    expect(fresh.resolveFrontendApi('')).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/<AtlasProvider>.*deprecated.*"same-origin"/);
    warn.mockRestore();
  });

  it('refuses same-origin values when the platform has no origin (native)', () => {
    expect(codeOf(() => resolveFrontendApi('', { allowSameOrigin: false }))).toBe(
      'FRONTEND_API_REQUIRED',
    );
    expect(codeOf(() => resolveFrontendApi('same-origin', { allowSameOrigin: false }))).toBe(
      'FRONTEND_API_INVALID',
    );
    expect(codeOf(() => resolveFrontendApi('/atlas', { allowSameOrigin: false }))).toBe(
      'FRONTEND_API_INVALID',
    );
  });
});
