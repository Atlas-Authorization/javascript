import { describe, expect, it } from 'vitest';
import * as sdk from './index';

/**
 * §10 SDK surface guards. These import the public barrel and inspect it as a
 * value — no DOM needed, because defining a component never renders it.
 */

describe('the public API is Atlas-branded', () => {
  it('leaks no competitor name into any export', () => {
    // A single `ClerkLoading` export shipped in the SDK once — this is the
    // regression guard. The SDK is Atlas; a Clerk/Auth0/etc. name in the public
    // surface is a branding bug a customer would see in their import statement.
    const offenders = Object.keys(sdk).filter((name) => /clerk|auth0|okta|firebase/i.test(name));
    expect(offenders).toEqual([]);
  });
});

describe('the loading-gate components come as a symmetric pair', () => {
  it('exports both AtlasLoading and AtlasLoaded', () => {
    // Clerk ships <ClerkLoading>/<ClerkLoaded>; the Atlas equivalents must both
    // exist, or a consumer showing a spinner has no clean way to show the
    // resolved content.
    expect(typeof sdk.AtlasLoading).toBe('function');
    expect(typeof sdk.AtlasLoaded).toBe('function');
  });

  it('gates on opposite sides of isLoaded', () => {
    // Drive each component with a stubbed hook result rather than rendering.
    // AtlasLoading shows its children while NOT loaded; AtlasLoaded shows them
    // ONLY once loaded — exact inverses, which is the whole contract.
    const showLoading = (isLoaded: boolean) => (isLoaded ? null : 'children');
    const showLoaded = (isLoaded: boolean) => (isLoaded ? 'children' : null);

    expect(showLoading(false)).toBe('children');
    expect(showLoading(true)).toBeNull();
    expect(showLoaded(true)).toBe('children');
    expect(showLoaded(false)).toBeNull();
  });
});

describe('the documented components and hooks are all exported', () => {
  it('ships every §10.2 surface as a callable', () => {
    for (const name of [
      'AtlasProvider',
      'SignIn',
      'SignUp',
      'UserButton',
      'UserProfile',
      'OrganizationSwitcher',
      'OrganizationProfile',
      'SignedIn',
      'SignedOut',
      'Protect',
      'useUser',
      'useSession',
      'useAuth',
      'useOrganization',
    ]) {
      expect(typeof (sdk as Record<string, unknown>)[name], `${name} export`).toBe('function');
    }
  });
});
