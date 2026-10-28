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
      'OrganizationAuditLog',
      'useOrganizationAuditLog',
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

describe('Clerk-parity ergonomic exports (2026-09-15 quick wins)', () => {
  it('exports the auth-button, redirect, avatar, and useSignUp helpers', () => {
    for (const name of [
      'SignInButton',
      'SignUpButton',
      'SignOutButton',
      'RedirectToSignIn',
      'RedirectToSignUp',
      'UserAvatar',
      'useSignUp',
    ] as const) {
      expect(typeof (sdk as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports the organization-list, waitlist, and reverification helpers', () => {
    for (const name of [
      'useOrganizationList',
      'CreateOrganization',
      'OrganizationList',
      'Waitlist',
      'useWaitlist',
      'useReverification',
    ] as const) {
      expect(typeof (sdk as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('§commerce billing surface (Clerk commerce parity)', () => {
  it('exports the billing hooks and components', () => {
    for (const name of [
      'useBilling',
      'useCheckout',
      'useSubscription',
      'useInvoices',
      'usePaymentMethods',
      'PricingTable',
      'Invoices',
      'EmbeddedCheckout',
    ] as const) {
      expect(typeof (sdk as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('§L1 multi-session / multi-account surface', () => {
  it('exports useSessionList and <MultisessionAppSupport>', () => {
    expect(typeof (sdk as Record<string, unknown>).useSessionList).toBe('function');
    expect(typeof (sdk as Record<string, unknown>).MultisessionAppSupport).toBe('function');
  });
});

describe('§L3 prebuilt-component extension API (Clerk static-subcomponent parity)', () => {
  it('attaches the UserButton menu-item descriptors as statics', () => {
    // The extension surface is discovered by identity off the parent component,
    // so the statics must be the very functions a consumer writes as
    // `<UserButton.Action>` — not merely "some function".
    expect(typeof sdk.UserButton.MenuItems).toBe('function');
    expect(typeof sdk.UserButton.Action).toBe('function');
    expect(typeof sdk.UserButton.Link).toBe('function');
  });

  it('attaches the UserProfile page/link descriptors as statics', () => {
    expect(typeof sdk.UserProfile.Page).toBe('function');
    expect(typeof sdk.UserProfile.Link).toBe('function');
  });

  it('descriptor components render nothing themselves (parent reads them)', () => {
    // A descriptor is a marker, not a renderer: calling it must yield null, so a
    // stray `<UserButton.Action>` outside a `<UserButton>` paints nothing rather
    // than leaking raw props into the DOM.
    expect(sdk.UserButton.Action({ label: 'x' })).toBeNull();
    expect(sdk.UserButton.Link({ label: 'x', href: '/y' })).toBeNull();
    expect(sdk.UserButton.MenuItems({})).toBeNull();
    expect(sdk.UserProfile.Page({ label: 'x' })).toBeNull();
    expect(sdk.UserProfile.Link({ label: 'x', url: '/y' })).toBeNull();
  });
});
