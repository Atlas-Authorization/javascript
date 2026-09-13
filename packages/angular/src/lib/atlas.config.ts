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
   * The instance's FAPI origin. Empty string (the default) means same-origin —
   * requests go to `/v1/...` on the app's own host.
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
}

/**
 * DI token carrying the resolved {@link AtlasOptions}. Populated by
 * {@link provideAtlas} (standalone) or {@link AtlasModule.forRoot} (NgModule)
 * and read by {@link AtlasService}. Applications rarely inject this directly.
 */
export const ATLAS_OPTIONS = new InjectionToken<AtlasOptions>('ATLAS_OPTIONS');
