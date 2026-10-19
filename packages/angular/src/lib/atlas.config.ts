import type { SignOutEvent } from '@atlasauth/js';
import { InjectionToken } from '@angular/core';
import type { Appearance } from './appearance';
import type { Catalog } from './i18n';

/**
 * Configuration for the Atlas Angular SDK — the Angular analogue of the props
 * passed to React's `<AtlasProvider>`.
 */
export interface AtlasOptions {
  /** The instance's publishable key (`pk_…`). Required. */
  publishableKey: string;
  /**
   * The instance's Frontend API: an absolute URL such as
   * `"https://auth.example.com"`, or `"same-origin"` / a path such as `"/atlas"`
   * behind a reverse proxy on the app's own origin (requests then go to
   * `/v1/...` on the app's host). Required at runtime — `AtlasService` throws an
   * `AtlasConfigError` (`FRONTEND_API_REQUIRED` / `FRONTEND_API_INVALID`) when
   * it is missing or malformed. Optional in the type only so existing call sites
   * keep compiling.
   */
  frontendApi?: string;
  /** Design tokens + per-element class overrides. See {@link Appearance}. */
  appearance?: Appearance;
  /** A localization catalog merged over `en-US`. */
  localization?: Catalog;
  /**
   * A `fetch` implementation to use instead of the global one — handy for SSR
   * or tests. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Called once each time a signed-in user becomes signed out, on every path:
   * `reason` is `user`, `other_tab`, `session_expired`, `revoked` (ended
   * elsewhere, seen on the next refresh) or `unknown`. See also
   * `AtlasService.signOut$`.
   */
  onSignOut?: (event: SignOutEvent) => void;
}

/**
 * DI token carrying the resolved {@link AtlasOptions}. Populated by
 * {@link provideAtlas} (standalone) or {@link AtlasModule.forRoot} (NgModule)
 * and read by {@link AtlasService}. Applications rarely inject this directly.
 */
export const ATLAS_OPTIONS = new InjectionToken<AtlasOptions>('ATLAS_OPTIONS');
