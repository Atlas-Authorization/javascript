import type { WidgetOptions } from './widget';

/**
 * Resolving widget options from the DOM.
 *
 * Configuration can come from three places, most specific first:
 *   1. the element's own attributes (`data-atlas-key`, `publishable-key`, …),
 *   2. the imperative `mount*()` options,
 *   3. the `<script>` tag that loaded the widget (`data-atlas-key`, …), which
 *      supplies defaults every element on the page inherits.
 */
export interface ScriptDefaults {
  publishableKey?: string;
  frontendApi?: string;
  redirect?: string;
}

let scriptDefaults: ScriptDefaults = {};

export function setScriptDefaults(defaults: ScriptDefaults): void {
  scriptDefaults = defaults;
}

export function getScriptDefaults(): ScriptDefaults {
  return scriptDefaults;
}

/** Read the `data-atlas-*` attributes off the loading script tag. */
export function readScriptTag(script: HTMLScriptElement | null | undefined): ScriptDefaults {
  if (!script) return {};
  const d = script.dataset;
  const out: ScriptDefaults = {};
  if (d.atlasKey) out.publishableKey = d.atlasKey;
  if (d.atlasFapi) out.frontendApi = d.atlasFapi;
  if (d.atlasRedirect) out.redirect = d.atlasRedirect;
  return out;
}

/**
 * Build widget options for an element in a given mode, falling back through the
 * element's attributes to the script-tag defaults. Returns null when the two
 * required values — publishable key and FAPI origin — cannot be resolved.
 */
export function optionsFromElement(
  el: Element,
  mode: 'sign-in' | 'sign-up',
): WidgetOptions | null {
  const dataset = (el as HTMLElement).dataset;
  const attr = (name: string): string | undefined => el.getAttribute(name) ?? undefined;

  const publishableKey = dataset.atlasKey ?? attr('publishable-key') ?? scriptDefaults.publishableKey;
  const frontendApi = dataset.atlasFapi ?? attr('frontend-api') ?? scriptDefaults.frontendApi;
  const redirect = dataset.atlasRedirect ?? attr('redirect') ?? scriptDefaults.redirect;

  if (!publishableKey || !frontendApi) return null;

  const options: WidgetOptions = { publishableKey, frontendApi, mode };
  if (redirect) options.redirect = redirect;
  return options;
}

/** Merge imperative options over the script-tag defaults. */
export function optionsFromApi(
  mode: 'sign-in' | 'sign-up',
  overrides: Partial<WidgetOptions> = {},
): WidgetOptions | null {
  const publishableKey = overrides.publishableKey ?? scriptDefaults.publishableKey;
  const frontendApi = overrides.frontendApi ?? scriptDefaults.frontendApi;
  if (!publishableKey || !frontendApi) return null;

  return {
    ...overrides,
    publishableKey,
    frontendApi,
    redirect: overrides.redirect ?? scriptDefaults.redirect,
    mode,
  };
}
