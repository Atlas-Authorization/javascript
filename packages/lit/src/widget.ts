import { mountSignIn, mountSignUp, type WidgetOptions } from '@atlasauth/embed';

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
  /** The UI language as a BCP-47 tag (`"es"`). */
  locale?: string;
  localization?: WidgetOptions['localization'];
  /** Replace the mount function (tests). */
  mounter?: WidgetMounter;
}

/**
 * Mount the Atlas DOM widget into `host` and return a cleanup function. The widget renders into
 * the host's light DOM and has no `unmount()`, so cleanup clears the host's children, which lets
 * the widget (and its background passkey AbortController) be garbage collected.
 */
export function mountAtlasWidget(host: HTMLElement, mode: WidgetMode, options: MountWidgetOptions): () => void {
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
