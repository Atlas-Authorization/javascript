/**
 * The public option surface for {@link AtlasLock} and the normalisation /
 * validation that sits in front of it.
 *
 * Everything here is PRESENTATIONAL or a passthrough: the actual auth flow is
 * owned by the embedded `@atlasauth/embed` widget (which drives `@atlasauth/js`),
 * so these options never touch factors, tickets or sessions — they decide which
 * screen opens, which method buttons are allowed to show, how it is themed, and
 * where it is mounted.
 */
import type { WidgetAppearance } from '@atlasauth/embed';
import type { Appearance } from '@atlasauth/themes';
import { themes } from '@atlasauth/themes';

/** Which screen the widget opens on, and the two tabs a user can switch between. */
export type AtlasLockScreen = 'sign-in' | 'sign-up';

/**
 * The discrete authentication methods a tenant may enable. The instance decides
 * which are actually available (auto-discovered from `GET /v1/appearance`); the
 * `methods` option is an ALLOW-LIST a page layers on top to hide ones it does
 * not want to offer here — the Atlas peer of Auth0 Lock's `allowedConnections`.
 */
export type AtlasLockMethod = 'password' | 'emailCode' | 'emailLink' | 'social' | 'passkey';

export const ALL_METHODS: readonly AtlasLockMethod[] = [
  'password',
  'emailCode',
  'emailLink',
  'social',
  'passkey',
];

/** How the widget is presented. */
export type AtlasLockDisplay = 'modal' | 'inline';

/**
 * A theme: a prebuilt `@atlasauth/themes` preset by name, a full `Appearance`
 * object (also from `@atlasauth/themes`), or `'auto'` to follow the tenant's own
 * server-side appearance with no override.
 */
export type AtlasLockTheme = keyof typeof themes | Appearance | 'auto';

/** The completion payload handed to {@link AtlasLockOptions.onAuthenticated}. */
export interface AtlasLockSession {
  /** The attempt that completed, when the server returned one. */
  attemptId: string | null;
  /** Whether the widget is navigating to a redirect URL (vs. staying put). */
  redirected: boolean;
}

/** The error payload handed to {@link AtlasLockOptions.onError}. */
export interface AtlasLockError {
  message: string;
  /** All field/form error messages currently shown, when the source is the form. */
  messages?: string[];
  /** Where the error came from. */
  source: 'config' | 'form';
}

/** The behavioural + presentational options, all optional with sane defaults. */
export interface AtlasLockOptions {
  /** Which screen to open on. Default `'sign-in'`. */
  screen?: AtlasLockScreen;
  /** Offer the sign-in tab. Default `true`. */
  allowSignIn?: boolean;
  /** Offer the sign-up tab. Default `true`. */
  allowSignUp?: boolean;
  /**
   * Show the sign-in / sign-up tab switcher. Defaults to `true` when both
   * `allowSignIn` and `allowSignUp` are on, `false` otherwise.
   */
  tabs?: boolean;
  /**
   * Allow-list of methods to show. When omitted every method the instance
   * enables is shown. Listing a subset hides the buttons for the rest (social
   * connections and passkeys are removed; the password field is hidden) — it
   * never enables a method the instance has switched off.
   */
  methods?: AtlasLockMethod[];
  /** Modal overlay (default) or an inline panel rendered into `container`. */
  display?: AtlasLockDisplay;
  /** Whether the modal can be dismissed (backdrop click, close button, Escape). Default `true`. */
  closable?: boolean;
  /** Where to go on success. Validated by the widget: same-origin or absolute https. */
  redirectUrl?: string;
  /**
   * Preview mode: run the whole flow but never exchange the ticket for a
   * session cookie — a safe "try your login" embed. Passed through to the widget.
   */
  preview?: boolean;
  /** Theme preset name, full `Appearance`, or `'auto'` (tenant default). */
  theme?: AtlasLockTheme;
  /** Convenience accent override, applied on top of `theme`. */
  primaryColor?: string;
  /** A logo rendered in the modal/panel header (above the form). */
  logo?: string;
  /** Header title. Defaults to the screen name. */
  title?: string;
  /** Header subtitle. */
  subtitle?: string;
  /** Advanced: a full widget appearance override, merged last (wins over `theme`). */
  appearance?: WidgetAppearance;
  /** Fired once a sign-in/up completes. */
  onAuthenticated?: (session: AtlasLockSession) => void;
  /** Fired on a configuration problem or when the form surfaces an error. */
  onError?: (error: AtlasLockError) => void;
  /** Fired when the widget is shown. */
  onShow?: () => void;
  /** Fired when the widget is hidden. */
  onHide?: () => void;
  /** Fired once the widget has mounted and rendered its first screen. */
  onReady?: () => void;
}

/** The constructor config. */
export interface AtlasLockConfig {
  /** Publishable key (`pk_…`) identifying the instance. */
  publishableKey: string;
  /**
   * The instance's frontend API origin — e.g. `accounts.acme.com` or
   * `https://accounts.acme.com`. A bare host is upgraded to `https://`.
   */
  domain: string;
  /** Alias for {@link domain}, matching `@atlasauth/embed`'s option name. */
  frontendApi?: string;
  /** For `display: 'inline'`, the element (or selector) to render into. */
  container?: Element | string;
  /** The option bag above. */
  options?: AtlasLockOptions;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** A fully-resolved, validated configuration. */
export interface NormalizedConfig {
  publishableKey: string;
  frontendApi: string;
  container: Element | string | null;
  display: AtlasLockDisplay;
  screen: AtlasLockScreen;
  allowSignIn: boolean;
  allowSignUp: boolean;
  tabs: boolean;
  methods: AtlasLockMethod[] | null;
  closable: boolean;
  redirectUrl?: string;
  preview: boolean;
  theme: AtlasLockTheme;
  primaryColor?: string;
  logo?: string;
  title?: string;
  subtitle?: string;
  appearance?: WidgetAppearance;
  options: AtlasLockOptions;
  fetchImpl?: typeof fetch;
}

/** Normalise an FAPI origin: upgrade a bare host to https, strip a trailing slash. */
export function normalizeFrontendApi(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** Validate the method allow-list, returning the known subset (or null for "all"). */
function normalizeMethods(methods: AtlasLockMethod[] | undefined): AtlasLockMethod[] | null {
  if (!methods) return null;
  const known = methods.filter((m): m is AtlasLockMethod => ALL_METHODS.includes(m));
  // An empty or all-garbage list would hide everything; treat it as "all".
  return known.length ? Array.from(new Set(known)) : null;
}

/**
 * Validate + normalise the constructor config. Throws a descriptive `Error`
 * when a required value is missing or a mutually-exclusive combination is
 * impossible, so misconfiguration fails loudly at construction rather than
 * rendering a blank box.
 */
export function normalizeConfig(config: AtlasLockConfig): NormalizedConfig {
  const publishableKey = (config.publishableKey ?? '').trim();
  if (!publishableKey) {
    throw new Error('@atlasauth/lock: `publishableKey` is required.');
  }
  const rawDomain = (config.domain || config.frontendApi || '').trim();
  if (!rawDomain) {
    throw new Error('@atlasauth/lock: `domain` (the instance frontend API origin) is required.');
  }

  const options = config.options ?? {};
  const allowSignIn = options.allowSignIn ?? true;
  const allowSignUp = options.allowSignUp ?? true;
  if (!allowSignIn && !allowSignUp) {
    throw new Error('@atlasauth/lock: at least one of `allowSignIn` / `allowSignUp` must be true.');
  }

  const display = options.display ?? 'modal';
  if (display === 'inline' && !config.container) {
    throw new Error("@atlasauth/lock: `display: 'inline'` requires a `container`.");
  }

  // The opening screen must be one the page actually allows.
  let screen: AtlasLockScreen = options.screen ?? 'sign-in';
  if (screen === 'sign-in' && !allowSignIn) screen = 'sign-up';
  if (screen === 'sign-up' && !allowSignUp) screen = 'sign-in';

  const tabs = options.tabs ?? (allowSignIn && allowSignUp);

  return {
    publishableKey,
    frontendApi: normalizeFrontendApi(rawDomain),
    container: config.container ?? null,
    display,
    screen,
    allowSignIn,
    allowSignUp,
    tabs: tabs && allowSignIn && allowSignUp,
    methods: normalizeMethods(options.methods),
    closable: options.closable ?? true,
    redirectUrl: options.redirectUrl,
    preview: options.preview ?? false,
    theme: options.theme ?? 'auto',
    primaryColor: options.primaryColor,
    logo: options.logo,
    title: options.title,
    subtitle: options.subtitle,
    appearance: options.appearance,
    options,
    fetchImpl: config.fetchImpl,
  };
}
