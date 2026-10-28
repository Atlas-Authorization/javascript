import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOptions } from './options';

describe('resolveOptions', () => {
  const SAVED = { ...process.env };

  beforeEach(() => {
    delete process.env.GATSBY_ATLAS_PUBLISHABLE_KEY;
    delete process.env.ATLAS_PUBLISHABLE_KEY;
    delete process.env.GATSBY_ATLAS_FRONTEND_API;
    delete process.env.ATLAS_FRONTEND_API;
  });

  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('takes explicit gatsby-config options over everything', () => {
    process.env.GATSBY_ATLAS_PUBLISHABLE_KEY = 'pk_from_env';
    const resolved = resolveOptions({
      publishableKey: 'pk_from_options',
      frontendApi: 'https://auth.acme.com',
    });
    expect(resolved.publishableKey).toBe('pk_from_options');
    expect(resolved.frontendApi).toBe('https://auth.acme.com');
  });

  it('falls back to GATSBY_ATLAS_* env when options omit a value', () => {
    process.env.GATSBY_ATLAS_PUBLISHABLE_KEY = 'pk_test_gatsby';
    process.env.GATSBY_ATLAS_FRONTEND_API = 'https://gatsby.example';
    const resolved = resolveOptions();
    expect(resolved.publishableKey).toBe('pk_test_gatsby');
    expect(resolved.frontendApi).toBe('https://gatsby.example');
  });

  it('falls back to unprefixed ATLAS_* env', () => {
    process.env.ATLAS_PUBLISHABLE_KEY = 'pk_test_atlas';
    process.env.ATLAS_FRONTEND_API = 'https://atlas.example';
    const resolved = resolveOptions();
    expect(resolved.publishableKey).toBe('pk_test_atlas');
    expect(resolved.frontendApi).toBe('https://atlas.example');
  });

  it('prefers the browser-safe GATSBY_* name over the unprefixed one', () => {
    process.env.GATSBY_ATLAS_PUBLISHABLE_KEY = 'pk_gatsby';
    process.env.ATLAS_PUBLISHABLE_KEY = 'pk_plain';
    expect(resolveOptions().publishableKey).toBe('pk_gatsby');
  });

  it('treats an empty-string env value as absent', () => {
    process.env.GATSBY_ATLAS_PUBLISHABLE_KEY = '';
    process.env.ATLAS_PUBLISHABLE_KEY = 'pk_real';
    expect(resolveOptions().publishableKey).toBe('pk_real');
  });

  it('resolves publishableKey to "" but leaves frontendApi undefined when nothing is set', () => {
    const resolved = resolveOptions();
    expect(resolved.publishableKey).toBe('');
    expect(resolved.frontendApi).toBeUndefined();
  });

  it('keeps an explicit frontendApi: "" option (deprecated same-origin spelling)', () => {
    expect(resolveOptions({ frontendApi: '' }).frontendApi).toBe('');
  });

  it('passes appearance / localization / oauthMode straight through', () => {
    const appearance = { variables: { colorPrimary: '#f00' } };
    const localization = { 'error.network': 'nope' } as never;
    const resolved = resolveOptions({ appearance, localization, oauthMode: 'popup' });
    expect(resolved.appearance).toBe(appearance);
    expect(resolved.localization).toBe(localization);
    expect(resolved.oauthMode).toBe('popup');
  });
});
