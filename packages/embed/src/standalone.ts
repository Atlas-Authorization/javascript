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

export interface AtlasGlobal {
  mountSignIn: typeof mountSignIn;
  mountSignUp: typeof mountSignUp;
  /** Mount a tenant-admin section (SSO, directory, domains, log streams, API keys, IP allowlist, webhooks). */
  mountOrganizationAdmin: typeof mountOrganizationAdmin;
  /** Mount the instance's pricing table (plans, trial, promotion, checkout). */
  mountPricingTable: typeof mountPricingTable;
  /** Mount a lead / newsletter signup form. */
  mountLeadForm: typeof mountLeadForm;
  defineElements: typeof defineElements;
}

declare global {
  interface Window {
    Atlas?: AtlasGlobal;
  }
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
  window.Atlas = { mountSignIn, mountSignUp, mountOrganizationAdmin, mountPricingTable, mountLeadForm, defineElements };
}

boot();
