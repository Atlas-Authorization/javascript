import { describe, expect, it } from 'vitest';
import {
  afterUrlTarget,
  gsiButtonRendered,
  resolveGoogleButtonRender,
  usesNativeGoogle,
  type EnvSocialProvider,
} from './flow';

/**
 * §2.1a/§2.1b native-Google decision helpers. Pure predicates, so no DOM: the
 * two questions the component asks — "should this provider use the in-page GSI
 * library?" and "did GSI actually draw its button?" — are unit-tested here, and
 * the component threads them into the effects.
 */

const google = (extra: Partial<EnvSocialProvider> = {}): EnvSocialProvider => ({
  provider: 'google',
  native: true,
  client_id: 'gcid.apps.googleusercontent.com',
  allow_sign_in: true,
  ...extra,
});

describe('§2.1a usesNativeGoogle honours the per-provider mode', () => {
  it('is native when Google is native with a client_id and mode is native/absent', () => {
    expect(usesNativeGoogle(google())).toBe(true);
    expect(usesNativeGoogle(google({ mode: 'native' }))).toBe(true);
  });

  it('is NOT native when the server resolved mode:"redirect" (the 2.1a ask)', () => {
    // Same client, same native flag — but redirect mode means the origin isn't a
    // registered JS origin, so the GSI library must not load; it renders redirect.
    expect(usesNativeGoogle(google({ mode: 'redirect' }))).toBe(false);
  });

  it('is NOT native without a client_id, when disabled, or for another provider', () => {
    expect(usesNativeGoogle(google({ client_id: undefined }))).toBe(false);
    expect(usesNativeGoogle(google({ native: false }))).toBe(false);
    expect(usesNativeGoogle(google({ allow_sign_in: false }))).toBe(false);
    expect(usesNativeGoogle({ provider: 'github', native: true, client_id: 'x' })).toBe(false);
  });
});

describe('§2.1b gsiButtonRendered detects the silent origin-mismatch failure', () => {
  const frameOfHeight = (height: number) => ({ getBoundingClientRect: () => ({ height }) });

  it('is false when GSI never drew an iframe (403 origin mismatch)', () => {
    expect(gsiButtonRendered(null)).toBe(false);
    expect(gsiButtonRendered(undefined)).toBe(false);
  });

  it('is false for a collapsed/trivial iframe (rendered but empty)', () => {
    expect(gsiButtonRendered(frameOfHeight(0))).toBe(false);
    expect(gsiButtonRendered(frameOfHeight(4))).toBe(false);
  });

  it('is true only for a real button iframe of non-trivial height', () => {
    expect(gsiButtonRendered(frameOfHeight(8))).toBe(true);
    expect(gsiButtonRendered(frameOfHeight(40))).toBe(true);
  });
});

describe('§4.5 resolveGoogleButtonRender picks the Google button render mode', () => {
  it("defaults to 'host': the styled button with an invisible overlay, no visible GSI", () => {
    const r = resolveGoogleButtonRender({});
    expect(r).toEqual({ mode: 'host', visible: false, showHostChrome: true });
    // An explicit 'host' is identical to the default.
    expect(resolveGoogleButtonRender({ googleButton: 'host' })).toEqual(r);
  });

  it("'google' renders Google's OWN button visibly and omits the host chrome while GSI is live", () => {
    expect(resolveGoogleButtonRender({ googleButton: 'google' })).toEqual({
      mode: 'google',
      visible: true,
      showHostChrome: false,
    });
    // active defaults to true (GSI live), so a caller needing only `visible` gets it.
    expect(resolveGoogleButtonRender({ googleButton: 'google', active: true }).showHostChrome).toBe(
      false,
    );
  });

  it('visible depends on the mode ALONE, never on active (so it can be fixed before the overlay runs)', () => {
    expect(resolveGoogleButtonRender({ googleButton: 'google', active: false }).visible).toBe(true);
    expect(resolveGoogleButtonRender({ googleButton: 'host', active: true }).visible).toBe(false);
  });

  it('falls back to the host chrome in BOTH modes when GSI is not the live path (active false)', () => {
    // 'host' always shows its chrome; 'google' shows it only once GSI has failed, so
    // the button degrades to a visible, clickable redirect fallback — never blank.
    expect(resolveGoogleButtonRender({ googleButton: 'host', active: false }).showHostChrome).toBe(
      true,
    );
    expect(
      resolveGoogleButtonRender({ googleButton: 'google', active: false }).showHostChrome,
    ).toBe(true);
  });

  it("treats any non-'google' value (incl. undefined) as 'host'", () => {
    expect(resolveGoogleButtonRender({ googleButton: undefined }).mode).toBe('host');
  });
});

describe('§10.2 afterUrlTarget decides the completion redirect', () => {
  it('returns null when afterUrl is unset (a no-op — today’s behaviour)', () => {
    expect(afterUrlTarget(undefined)).toBeNull();
  });

  it('returns null for a blank / whitespace-only afterUrl', () => {
    expect(afterUrlTarget('')).toBeNull();
    expect(afterUrlTarget('   ')).toBeNull();
  });

  it('returns the destination for a set afterUrl (relative or absolute)', () => {
    expect(afterUrlTarget('/dashboard')).toBe('/dashboard');
    expect(afterUrlTarget('https://app.acme.com/home')).toBe('https://app.acme.com/home');
  });

  it('trims surrounding whitespace so a padded value still navigates', () => {
    expect(afterUrlTarget('  /welcome  ')).toBe('/welcome');
  });
});
