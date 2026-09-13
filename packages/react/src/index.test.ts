import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKENS,
  THEMES,
  classFor,
  cssVariables,
  resolveTokens,
  type Appearance,
} from './appearance';
import { evaluate } from './protect';
import { EN_US, translate, withFallback } from './i18n';
import type { SessionClaims } from './types';

const claims = (over: Partial<SessionClaims> = {}): SessionClaims => ({
  sub: 'user_1',
  sid: 'sess_1',
  exp: 0,
  ...over,
});

describe('design tokens', () => {
  it('falls back to the defaults with no appearance at all', () => {
    expect(resolveTokens()).toEqual(DEFAULT_TOKENS);
  });

  it('applies a prebuilt theme', () => {
    expect(resolveTokens({ baseTheme: 'dark' }).colorBackground).toBe(THEMES.dark.colorBackground);
  });

  /**
   * A customer setting ONE variable on the dark theme expects the other eleven
   * to stay dark, not silently revert to the light defaults.
   */
  it('layers explicit variables over the base theme without resetting the rest', () => {
    const tokens = resolveTokens({ baseTheme: 'dark', variables: { colorPrimary: '#ff0000' } });

    expect(tokens.colorPrimary).toBe('#ff0000');
    expect(tokens.colorBackground).toBe(THEMES.dark.colorBackground);
    expect(tokens.colorBorder).toBe(THEMES.dark.colorBorder);
  });

  it('ignores an undefined variable rather than blanking a token', () => {
    const tokens = resolveTokens({
      baseTheme: 'dark',
      variables: { colorPrimary: undefined },
    });
    // `{ colorPrimary: undefined }` is what a spread of optional props produces.
    expect(tokens.colorPrimary).toBe(THEMES.dark.colorPrimary);
  });

  /**
   * Neobrutalist exists to prove the token set is expressive enough for a theme
   * that looks nothing like the default. A theming system that only produces
   * tasteful variations of itself is not a theming system.
   */
  it('ships a theme that departs sharply from the default', () => {
    expect(THEMES.neobrutalist.borderRadius).not.toBe(DEFAULT_TOKENS.borderRadius);
    expect(THEMES.neobrutalist.fontFamily).not.toBe(DEFAULT_TOKENS.fontFamily);
  });

  it('exposes tokens as CSS custom properties a customer can target', () => {
    const vars = cssVariables(resolveTokens());
    expect(vars['--atlas-color-primary']).toBe(DEFAULT_TOKENS.colorPrimary);
    expect(vars['--atlas-border-radius']).toBe(DEFAULT_TOKENS.borderRadius);
  });

  it('names every token as a variable', () => {
    expect(Object.keys(cssVariables(resolveTokens()))).toHaveLength(
      Object.keys(DEFAULT_TOKENS).length,
    );
  });
});

/**
 * §10.3: no iframe, so the customer's CSS reaches our markup — which is what
 * they want and what makes the override system necessary rather than decorative.
 */
describe('element class overrides', () => {
  const appearance: Appearance = { elements: { formButtonPrimary: 'rounded-xl shadow-lg' } };

  it('appends the override to our base class', () => {
    // A customer adding `rounded-xl` wants a rounder button, not an unstyled
    // one — replacement would make every override start by rebuilding our base.
    expect(classFor('formButtonPrimary', appearance, 'atlas-btn')).toBe(
      'atlas-btn rounded-xl shadow-lg',
    );
  });

  it('puts the override last so it wins on equal specificity', () => {
    const result = classFor('formButtonPrimary', appearance, 'atlas-btn');
    expect(result.indexOf('rounded-xl')).toBeGreaterThan(result.indexOf('atlas-btn'));
  });

  it('returns the base class untouched when nothing is overridden', () => {
    expect(classFor('card', appearance, 'atlas-card')).toBe('atlas-card');
    expect(classFor('card', undefined, 'atlas-card')).toBe('atlas-card');
  });
});

/**
 * A RENDERING helper, never an authorization boundary. Anyone can flip the
 * condition in devtools; only the server checking the same permission stops
 * them acting.
 */
describe('<Protect> conditions', () => {
  it('refuses a signed-out visitor', () => {
    expect(evaluate(null)).toEqual({ allowed: false, reason: 'signed_out' });
  });

  it('allows any signed-in user when no condition is given', () => {
    // `<Protect>` with no props should read as "signed in", which is the common
    // case; requiring an explicit flag would make the simplest usage noisiest.
    expect(evaluate(claims())).toEqual({ allowed: true });
  });

  it('allows a held permission', () => {
    const result = evaluate(claims({ org_id: 'org_1', org_permissions: ['org:members:manage'] }), {
      permission: 'org:members:manage',
    });
    expect(result.allowed).toBe(true);
  });

  it('refuses a permission the role does not hold', () => {
    const result = evaluate(claims({ org_id: 'org_1', org_permissions: ['org:members:read'] }), {
      permission: 'org:members:manage',
    });
    expect(result).toEqual({ allowed: false, reason: 'missing_permission' });
  });

  it('checks an exact role', () => {
    const admin = claims({ org_id: 'org_1', org_role: 'org:admin' });
    expect(evaluate(admin, { role: 'org:admin' }).allowed).toBe(true);
    expect(evaluate(admin, { role: 'org:member' }).allowed).toBe(false);
  });

  it('supports any-of and all-of', () => {
    const held = claims({ org_id: 'org_1', org_permissions: ['a', 'b'] });

    expect(evaluate(held, { anyPermission: ['b', 'z'] }).allowed).toBe(true);
    expect(evaluate(held, { anyPermission: ['y', 'z'] }).allowed).toBe(false);
    expect(evaluate(held, { allPermissions: ['a', 'b'] }).allowed).toBe(true);
    expect(evaluate(held, { allPermissions: ['a', 'z'] }).allowed).toBe(false);
  });

  /**
   * The subtle one. `allPermissions: []` is trivially satisfied by the empty
   * set, so a user with no organization at all must fail on the ORG check
   * rather than pass vacuously and be shown an admin panel.
   */
  it('refuses an organization condition when there is no active organization', () => {
    expect(evaluate(claims(), { permission: 'anything' })).toEqual({
      allowed: false,
      reason: 'no_organization',
    });
    expect(evaluate(claims(), { allPermissions: [] })).toEqual({
      allowed: false,
      reason: 'no_organization',
    });
  });

  it('refuses when the token carries an org but no permissions array', () => {
    expect(
      evaluate(claims({ org_id: 'org_1' }), { permission: 'org:members:manage' }).allowed,
    ).toBe(false);
  });
});

describe('i18n', () => {
  it('looks up a key', () => {
    expect(translate(EN_US, 'signIn.submit')).toBe('Continue');
  });

  it('interpolates variables', () => {
    expect(translate(EN_US, 'signIn.socialButton', { provider: 'Google' })).toBe(
      'Continue with Google',
    );
  });

  /**
   * A blank button is a bug nobody can report; a button reading
   * `signIn.submit` is one anyone can.
   */
  it('renders the key itself when it is missing', () => {
    expect(translate({}, 'some.unknown.key')).toBe('some.unknown.key');
  });

  it('leaves an unsupplied placeholder visible', () => {
    // `Continue with {provider}` gets reported; `Continue with ` does not.
    expect(translate(EN_US, 'signIn.socialButton')).toBe('Continue with {provider}');
  });

  it('falls back to en-US for a partially translated locale', () => {
    const french = withFallback({ 'signIn.submit': 'Continuer' });
    expect(translate(french, 'signIn.submit')).toBe('Continuer');
    // A community locale that covers half the strings still renders fully.
    expect(translate(french, 'signIn.forgotPassword')).toBe(EN_US['signIn.forgotPassword']);
  });

  it('is a flat map, so a missing key cannot crash a lookup chain', () => {
    for (const key of Object.keys(EN_US)) {
      expect(typeof EN_US[key]).toBe('string');
    }
  });

  it('covers every component surface the spec lists', () => {
    for (const prefix of [
      'signIn.',
      'signUp.',
      'mfa.',
      'reset.',
      'userButton.',
      'userProfile.',
      'organization.',
      'error.',
    ]) {
      expect(
        Object.keys(EN_US).some((key) => key.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });
});
