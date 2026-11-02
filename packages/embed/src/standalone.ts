/**
 * The IIFE entry point bundled into `dist/embed.js`.
 *
 * Loaded with a plain `<script src=".../embed.js" data-atlas-key="pk_…"
 * data-atlas-fapi="https://accounts.acme.com">`, it:
 *   1. captures the script tag's `data-atlas-*` as page-wide defaults,
 *   2. registers `<atlas-sign-in>` / `<atlas-sign-up>`, which then upgrade any
 *      such elements already in the markup, and
 *   3. exposes `window.Atlas` for imperative mounting.
 *
 * It has NO bare imports at runtime — `@atlasauth/js` is bundled in — so it runs
 * from the script tag alone.
 */
import { defineElements } from './element';
import { mountSignIn, mountSignUp } from './mount';
import { mountOrganizationAdmin } from './org-admin';
import { mountPricingTable } from './pricing';
import { mountLeadForm } from './lead-form';
import { readScriptTag, setScriptDefaults } from './config';
import { createClient } from './client';

export interface AtlasGlobal {
  mountSignIn: typeof mountSignIn;
  mountSignUp: typeof mountSignUp;
  /** Mount a tenant-admin section (SSO, directory, domains, log streams, API keys, IP allowlist, webhooks). */
  mountOrganizationAdmin: typeof mountOrganizationAdmin;
  /** Mount the instance's pricing table (plans, trial, promotion, checkout). */
  mountPricingTable: typeof mountPricingTable;
  /** Mount a lead / newsletter signup form. */
  mountLeadForm: typeof mountLeadForm;
  /** `session.getToken()` / `getIdToken()` / `user` / `isSignedIn`: see `@atlasauth/js`. Present when the script tag carries a key and FAPI origin. */
  session?: import('@atlasauth/js').AtlasSessionGlobal;
  billing?: import('@atlasauth/js').AtlasBillingGlobal;
  defineElements: typeof defineElements;
  /** Other scripts may add their own keys to the shared global. */
  [key: string]: unknown;
}

function currentScript(): HTMLScriptElement | null {
  const active = document.currentScript;
  if (active instanceof HTMLScriptElement) return active;
  // `defer`/`async` can null out currentScript; fall back to the tag that
  // carries our config, then any script whose src looks like the bundle.
  return (
    document.querySelector<HTMLScriptElement>('script[data-atlas-key]') ??
    document.querySelector<HTMLScriptElement>('script[src*="embed.js"]')
  );
}

function boot(): void {
  setScriptDefaults(readScriptTag(currentScript()));
  defineElements();
  const defaults = readScriptTag(currentScript());
  // The client registers `window.Atlas.session` (extended below, never clobbered).
  if (defaults.publishableKey && defaults.frontendApi) {
    createClient({ publishableKey: defaults.publishableKey, frontendApi: defaults.frontendApi, locale: defaults.locale });
  }
  window.Atlas = Object.assign(window.Atlas ?? {}, { mountSignIn, mountSignUp, mountOrganizationAdmin, mountPricingTable, mountLeadForm, defineElements }) as AtlasGlobal;
}

boot();
