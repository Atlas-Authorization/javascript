import { describe, expect, it } from 'vitest';
import { normalizeConfig, normalizeFrontendApi } from './options';

describe('normalizeFrontendApi', () => {
  it('upgrades a bare host to https and strips a trailing slash', () => {
    expect(normalizeFrontendApi('accounts.acme.com')).toBe('https://accounts.acme.com');
    expect(normalizeFrontendApi('https://accounts.acme.com/')).toBe('https://accounts.acme.com');
    expect(normalizeFrontendApi('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('normalizeConfig validation', () => {
  const ok = { publishableKey: 'pk_test', domain: 'accounts.acme.com' };

  it('requires a publishable key', () => {
    expect(() => normalizeConfig({ ...ok, publishableKey: '' })).toThrow(/publishableKey/);
  });

  it('requires a domain', () => {
    expect(() => normalizeConfig({ publishableKey: 'pk_test', domain: '' })).toThrow(/domain/);
  });

  it('accepts frontendApi as an alias for domain', () => {
    const n = normalizeConfig({ publishableKey: 'pk', domain: '', frontendApi: 'id.acme.com' });
    expect(n.frontendApi).toBe('https://id.acme.com');
  });

  it('rejects disabling both screens', () => {
    expect(() =>
      normalizeConfig({ ...ok, options: { allowSignIn: false, allowSignUp: false } }),
    ).toThrow(/allowSignIn/);
  });

  it('requires a container for inline display', () => {
    expect(() => normalizeConfig({ ...ok, options: { display: 'inline' } })).toThrow(/inline/);
  });

  it('defaults to a closable sign-in modal with tabs and all methods', () => {
    const n = normalizeConfig(ok);
    expect(n.display).toBe('modal');
    expect(n.screen).toBe('sign-in');
    expect(n.closable).toBe(true);
    expect(n.tabs).toBe(true);
    expect(n.methods).toBeNull();
  });

  it('falls back to an allowed screen when the requested one is disabled', () => {
    const n = normalizeConfig({ ...ok, options: { screen: 'sign-in', allowSignIn: false } });
    expect(n.screen).toBe('sign-up');
    expect(n.tabs).toBe(false);
  });

  it('drops unknown methods and treats an empty result as "all"', () => {
    const n = normalizeConfig({
      ...ok,
      // @ts-expect-error — exercising a bad runtime value
      options: { methods: ['password', 'nonsense'] },
    });
    expect(n.methods).toEqual(['password']);
    // @ts-expect-error — exercising a bad runtime value
    expect(normalizeConfig({ ...ok, options: { methods: ['nope'] } }).methods).toBeNull();
  });
});
