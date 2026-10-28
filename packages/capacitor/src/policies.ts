/**
 * Policy acceptance (terms of service, privacy, any policy) for Capacitor.
 *
 * The native-session sign-in runs in the SYSTEM browser on Atlas's hosted pages,
 * which already collect the acceptances (sign-up) and hold a sign-in until a
 * newer version is accepted, so {@link AtlasCapacitor.signIn} needs nothing more.
 * What the app's own WebView layer needs is:
 *
 *  - the policies for its own screens (a custom sign-up form): `policies()`
 *    returns a `PolicyAcceptanceController`, and the DOM pieces re-exported below
 *    (`mountPolicyConsent`, `mountPolicyClickwrap`, `mountPolicyAcceptStep`) draw
 *    it;
 *  - in-app re-acceptance for the signed-in user: `policyGate()` and
 *    {@link mountPolicyGate}'s banner, which post `/v1/client/me/policies/accept`
 *    with the session's bearer token.
 *
 * Everything is `@atlasauth/js`; this file only supplies a bearer-authenticated
 * client (a Capacitor app has no cookie against the FAPI origin).
 */

import {
  FapiClient,
  PolicyAcceptanceController,
  PolicyGateController,
  controllerForPending,
  formatPolicyDate,
  injectPolicyStyles,
  joinTitles,
  loadPolicies,
  mountPolicyAcceptStep,
  policyTranslator,
  type PolicyClasses,
  type PolicyT,
} from '@atlasauth/js';

export interface PolicyApiConfig {
  publishableKey: string;
  frontendApi: string;
  /** The headers an authenticated `/v1/client/me/*` call needs (bearer + pk); empty-bearer when signed out. */
  authHeaders: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  /** The UI language, sent as `Accept-Language` and used to pick a translation. */
  locale?: string;
}

/** What the Atlas handle exposes for policy acceptance. */
export interface PolicyApi {
  /** The bearer-authenticated Frontend API client (for `@atlasauth/js` helpers). */
  readonly fapi: FapiClient;
  /**
   * Load the instance's policies (`GET /v1/client/policies`) into a controller
   * for a sign-up form of your own. `signIn` keeps only the policies that also
   * apply at sign-in.
   */
  policies(options?: { combined?: boolean; signIn?: boolean; locale?: string }): Promise<PolicyAcceptanceController>;
  /**
   * The controller for an attempt the server holds at `needs_policy_acceptance`
   * (an attempt view with `pending_policies`), with the content filled in.
   */
  pendingPolicies(
    attempt: { pending_policies?: unknown } | null | undefined,
    options?: { combined?: boolean; locale?: string },
  ): Promise<PolicyAcceptanceController>;
  /**
   * In-app re-acceptance for the signed-in user: `load()` the standing,
   * `begin()` a controller for what needs accepting, `accept(controller)` to send it.
   */
  policyGate(locale?: string): PolicyGateController;
}

/** Build the policy API over a bearer-authenticated client. */
export function createPolicyApi(config: PolicyApiConfig): PolicyApi {
  const doFetch: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const fapi = new FapiClient({
    publishableKey: config.publishableKey,
    baseUrl: config.frontendApi,
    locale: config.locale,
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(await config.authHeaders())) if (!headers.has(k)) headers.set(k, v);
      return doFetch(input, { ...init, headers });
    },
  });
  return {
    fapi,
    async policies(options = {}) {
      const controller = new PolicyAcceptanceController([], { combined: options.combined });
      controller.setPolicies(await loadPolicies(fapi, { locale: options.locale ?? config.locale, signIn: options.signIn }));
      return controller;
    },
    pendingPolicies: (attempt, options = {}) =>
      controllerForPending(fapi, attempt, { combined: options.combined, locale: options.locale ?? config.locale }),
    policyGate: (locale) => new PolicyGateController(fapi, locale ?? config.locale),
  };
}

/** The English policy strings, with any `policy.*` overrides on top. */
export function policyText(strings?: Record<string, string>): PolicyT {
  return policyTranslator((key, vars) => {
    const template = strings?.[key];
    return template ? template.replace(/\{(\w+)\}/g, (m, n: string) => vars?.[n] ?? m) : '';
  });
}

export interface MountPolicyGateOptions {
  /** Override any `policy.*` string. */
  strings?: Record<string, string>;
  /** Extra class names per element. */
  classes?: PolicyClasses;
  /** Called after the user accepted and the server confirmed. */
  onAccepted?(): void;
}

/**
 * Mount the signed-in re-acceptance banner into `host`: it loads the user's
 * standing from `gate`, shows a banner when a policy needs accepting (with the
 * end of any grace window), and "Review and accept" opens the acceptance step
 * and posts the result. Draws nothing when there is nothing to accept. Call it
 * only for a signed-in user; `ready` resolves once the standing has loaded.
 */
export function mountPolicyGate(
  host: HTMLElement,
  gate: PolicyGateController,
  options: MountPolicyGateOptions = {},
): { destroy(): void; ready: Promise<void> } {
  const doc = host.ownerDocument;
  const t = policyText(options.strings);
  let step: ReturnType<typeof mountPolicyAcceptStep> | null = null;
  let open = false;
  let alive = true;
  injectPolicyStyles(doc);

  const showError = (message: string) => {
    const p = doc.createElement('p');
    p.setAttribute('role', 'alert');
    p.textContent = message;
    host.append(p);
  };

  const draw = () => {
    if (!alive || open) return;
    host.textContent = '';
    host.setAttribute('data-atlas-policy-gate', '');
    if (gate.pending.length === 0) return;
    const banner = doc.createElement('div');
    banner.className = 'atlas-policy-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('data-atlas-policy-banner', '');
    const text = doc.createElement('span');
    const strong = doc.createElement('strong');
    strong.textContent = `${t('policy.bannerTitle')}. `;
    text.append(strong, t('policy.bannerBody', { policies: joinTitles(gate.pending.map((p) => p.title), t('policy.and')) }));
    if (gate.graceEndsAt) text.append(` ${t('policy.bannerGrace', { date: formatPolicyDate(gate.graceEndsAt) })}`);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = ['atlas-policy-link', options.classes?.link].filter(Boolean).join(' ');
    button.textContent = t('policy.bannerReview');
    button.addEventListener('click', () => void begin());
    banner.append(text, button);
    host.append(banner);
  };

  const close = () => {
    step?.destroy();
    step = null;
    open = false;
    draw();
  };

  const begin = async () => {
    const controller = await gate.begin();
    if (!alive) return;
    open = true;
    host.textContent = '';
    const stepHost = doc.createElement('div');
    host.append(stepHost);
    step = mountPolicyAcceptStep(stepHost, controller, {
      t,
      classes: options.classes,
      onSubmit: async () => {
        step?.setBusy(true);
        const res = await gate.accept(controller);
        step?.setBusy(false);
        if (!res.ok) {
          showError(res.errors[0]?.message ?? t('policy.requiredGeneric'));
          return;
        }
        close();
        options.onAccepted?.();
      },
      onDecline: close,
    });
  };

  const off = gate.subscribe(draw);
  const ready = gate.load().then(draw, draw);
  return {
    ready,
    destroy() {
      alive = false;
      off();
      step?.destroy();
      host.textContent = '';
    },
  };
}

// The DOM pieces and helpers a WebView screen draws with (all from `@atlasauth/js`).
export {
  PolicyAcceptanceController,
  PolicyGateController,
  buildPolicyAcceptances,
  injectPolicyStyles,
  isPolicyAcceptanceRequired,
  mountPolicyAcceptStep,
  mountPolicyClickwrap,
  mountPolicyConsent,
  runScrollPolicies,
  type Policy,
  type PolicyAcceptancePayload,
} from '@atlasauth/js';
