import { mountSignIn, mountSignUp, type WidgetOptions } from '@atlasauth/embed';

/**
 * The DOM-widget mount/cleanup helper.
 *
 * `@atlasauth/js` is the FAPI flow engine; the framework-agnostic DOM widget
 * that drives it — the same panel the hosted page renders — lives in
 * `@atlasauth/embed` as the imperative {@link mountSignIn} / {@link mountSignUp}.
 * The mountable Qwik `<SignIn>` / `<SignUp>` mount that widget into a ref'd
 * element from a client-only `useVisibleTask$`.
 *
 * Teardown note: `@atlasauth/embed`'s `AtlasWidget` renders into the host's light
 * DOM and exposes NO public `unmount()` — the custom-element version simply
 * drops its reference when the host disconnects. So for an imperative mount the
 * cleanup clears the host's children, which removes the rendered panel and lets
 * the widget (and its background conditional-passkey AbortController) be garbage
 * collected. That is the real, honest teardown the current widget supports.
 */

export type WidgetMode = 'sign-in' | 'sign-up';

/** A mount function with the shape of `@atlasauth/embed`'s `mountSignIn`. */
export type WidgetMounter = (host: HTMLElement, overrides: Partial<WidgetOptions>) => unknown;

const DEFAULT_MOUNTERS: Record<WidgetMode, WidgetMounter> = {
  'sign-in': (host, overrides) => mountSignIn(host, overrides),
  'sign-up': (host, overrides) => mountSignUp(host, overrides),
};

export interface MountWidgetOptions {
  publishableKey: string;
  frontendApi: string;
  /** Where to go on success. Validated same-origin / absolute-https by the widget. */
  redirect?: string;
  /**
   * The UI language as a BCP-47 tag (`"es"`), sent to the Frontend API as
   * `Accept-Language` so its error messages come back in that language.
   */
  locale?: string;
  /**
   * Strings for server errors, keyed `error.<reason>` — e.g. `esES` from
   * `@atlasauth/localizations`. Its `locale` tag is used when `locale` is unset.
   */
  localization?: WidgetOptions['localization'];
  /**
   * The mount function to use. Defaults to the `@atlasauth/embed` imperative
   * mount for the mode; injected by tests so the helper can be exercised without
   * the real widget or a network.
   */
  mounter?: WidgetMounter;
}

/**
 * Mount the Atlas DOM widget into `host` and return a cleanup function.
 *
 * Idempotent cleanup: calling the returned function clears the host, which is
 * safe to run from a `useVisibleTask$` cleanup even if the host was already
 * detached.
 */
export function mountAtlasWidget(
  host: HTMLElement,
  mode: WidgetMode,
  options: MountWidgetOptions,
): () => void {
  const mounter = options.mounter ?? DEFAULT_MOUNTERS[mode];
  const overrides: Partial<WidgetOptions> = {
    publishableKey: options.publishableKey,
    frontendApi: options.frontendApi,
  };
  if (options.redirect) overrides.redirect = options.redirect;
  if (options.locale) overrides.locale = options.locale;
  if (options.localization) overrides.localization = options.localization;

  mounter(host, overrides);

  return () => {
    try {
      host.replaceChildren();
    } catch {
      // The host may already be gone (navigation); nothing to clean.
    }
  };
}
