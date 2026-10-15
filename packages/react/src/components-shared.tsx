import { Children, isValidElement, useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import { localizedErrorMessage, type ErrorLike } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { FapiClient } from './fapi';
import { classFor, type ElementKey } from './appearance';
import { translate } from './i18n';

/**
 * Internal helpers shared by more than one component in the @atlasauth/react
 * library. Nothing here is part of the package's public API — the public
 * components live in their own sibling files and re-export through
 * `components.tsx`.
 */

export function useClass(appearanceKey: Parameters<typeof classFor>[0], base: string) {
  const { appearance } = useAtlas();
  return classFor(appearanceKey, appearance, base);
}

/** A class builder for components that style many elements: `cls('list', 'atlas-list')`. */
export function useClasses(): (key: ElementKey, base: string) => string {
  const { appearance } = useAtlas();
  return (key, base) => classFor(key, appearance, base);
}

export function useText() {
  const { catalog } = useAtlas();
  return (key: string, vars?: Record<string, string>) => translate(catalog, key, vars);
}

/**
 * The text to show for a server error, in the app's language: the catalog's
 * `error.<reason>`, else the server's own message, else `error.generic`. See
 * `localizedErrorMessage` in `@atlasauth/js`.
 */
export function useErrorText(): (error: ErrorLike | string | null | undefined) => string {
  const { catalog, errorCatalog } = useAtlas();
  return useCallback(
    (error) => localizedErrorMessage(error, errorCatalog ?? catalog, catalog),
    [catalog, errorCatalog],
  );
}

/** A FapiClient bound to this instance and the app's language (`Accept-Language`). */
export function useFapiClient(): FapiClient {
  const { publishableKey, frontendApi, locale } = useAtlas();
  return useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi, locale }),
    [publishableKey, frontendApi, locale],
  );
}

/** §2 A FapiClient bound to this instance, for the `/v1/client/me` + session
 *  account-management calls (all cookie-authenticated, credentials:'include'). */
export function useMeClient(): FapiClient {
  return useFapiClient();
}

/** Navigate the whole document. Guarded for SSR; `replace` for redirect helpers. */
export function navigateTo(url: string, replace = false): void {
  if (typeof window === 'undefined') return;
  if (replace) window.location.replace(url);
  else window.location.assign(url);
}

/** Append `?redirect_url=` (where to land after auth), preserving any existing query. */
export function withRedirect(url: string, redirectUrl?: string): string {
  if (!redirectUrl) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}redirect_url=${encodeURIComponent(redirectUrl)}`;
}

/** The current page URL, guarded for SSR. */
export function currentUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.href;
}

/** Walk a children tree and collect the extension descriptors matching `types`. */
export function collectByType<T>(
  children: ReactNode,
  match: (el: ReactElement) => T | undefined,
  out: T[] = [],
): T[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const hit = match(child);
    if (hit) out.push(hit);
    // Descend so `<Action>` inside `<MenuItems>` (or any wrapper) is still found.
    const nested = (child.props as { children?: ReactNode })?.children;
    if (nested) collectByType(nested, match, out);
  });
  return out;
}
