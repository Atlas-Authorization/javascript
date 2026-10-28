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
  mountPolicyClickwrap,
  mountPolicyConsent,
  policyTranslator,
  type PolicyClasses,
  type PolicyT,
} from '@atlasauth/js';

/**
 * Policy acceptance (terms of service, privacy, any policy) for Qwik.
 *
 * `<SignIn>` / `<SignUp>` mount the `@atlasauth/embed` widget, which already
 * shows the policies, so nothing here is needed for them. These helpers are for
 * a custom form: the state machine (`PolicyAcceptanceController`), the DOM pieces
 * and the FAPI calls all come from `@atlasauth/js`; this file only mounts them
 * into a ref'd element (the same pattern as `mountAtlasWidget`) and returns a
 * teardown. The Qwik components in `policies.tsx` call them from a client-only
 * `useVisibleTask$`, so the controller never crosses the serialization boundary.
 */

/** The identifiers the policy calls need (the store carries both as plain strings). */
export interface PolicyClientOptions {
  publishableKey: string;
  frontendApi: string;
  /** The UI language (`"es"`), sent as `Accept-Language` and used to pick a translation. */
  locale?: string;
}

/** A Frontend API client for the policy calls. */
export function createPolicyClient(options: PolicyClientOptions): FapiClient {
  return new FapiClient({
    publishableKey: options.publishableKey,
    baseUrl: options.frontendApi,
    locale: options.locale,
  });
}

/** The English policy strings, with any `policy.*` overrides on top. */
export function policyText(strings?: Record<string, string>): PolicyT {
  return policyTranslator((key, vars) => {
    const template = strings?.[key];
    return template ? template.replace(/\{(\w+)\}/g, (m, n: string) => vars?.[n] ?? m) : '';
  });
}

export interface PolicyUiOptions {
  /** Override any `policy.*` string. */
  strings?: Record<string, string>;
  /** Extra class names per element. */
  classes?: PolicyClasses;
}

/** Load the instance's policies into a new controller (`GET /v1/client/policies`). */
export async function loadPolicyController(
  client: FapiClient,
  options: { combined?: boolean; signIn?: boolean; locale?: string } = {},
): Promise<PolicyAcceptanceController> {
  const controller = new PolicyAcceptanceController([], { combined: options.combined });
  controller.setPolicies(await loadPolicies(client, { locale: options.locale, signIn: options.signIn }));
  return controller;
}

/** The controller for a sign-in attempt held at `needs_policy_acceptance` (see `controllerForPending`). */
export function loadPendingController(
  client: FapiClient,
  attempt: { pending_policies?: unknown } | null | undefined,
  options: { combined?: boolean; locale?: string } = {},
): Promise<PolicyAcceptanceController> {
  return controllerForPending(client, attempt, options);
}

type Mounter = (host: HTMLElement, controller: PolicyAcceptanceController, o: { t: PolicyT; classes?: PolicyClasses }) => { destroy(): void };

function mountInto(mount: Mounter, host: HTMLElement, controller: PolicyAcceptanceController, options: PolicyUiOptions): () => void {
  injectPolicyStyles(host.ownerDocument);
  const mounted = mount(host, controller, { t: policyText(options.strings), classes: options.classes });
  return () => {
    try {
      mounted.destroy();
    } catch {
      // The host may already be gone (navigation); nothing to clean.
    }
  };
}

/** Mount the checkbox block (combined or per policy) with its in-page document viewer. */
export function mountConsent(host: HTMLElement, controller: PolicyAcceptanceController, options: PolicyUiOptions = {}): () => void {
  return mountInto(mountPolicyConsent, host, controller, options);
}

/** Mount the clickwrap sentence for `link` policies. */
export function mountClickwrap(host: HTMLElement, controller: PolicyAcceptanceController, options: PolicyUiOptions = {}): () => void {
  return mountInto(mountPolicyClickwrap, host, controller, options);
}

export interface PolicyStepOptions extends PolicyUiOptions {
  /** The user accepted everything required: send these as `policy_acceptances`. */
  onSubmit(acceptances: ReturnType<PolicyAcceptanceController['build']>): void;
  /** The user declined a policy: cancel the attempt. */
  onDecline?(policyTitle: string): void;
}

/**
 * Mount the sign-in step for a held attempt: scroll-mode policies in their
 * unskippable dialog, the rest as checkboxes, then "Accept and continue".
 * Returns the teardown and a `setBusy` for the request in flight.
 */
export function mountAcceptStep(
  host: HTMLElement,
  controller: PolicyAcceptanceController,
  options: PolicyStepOptions,
): { destroy(): void; setBusy(busy: boolean): void } {
  injectPolicyStyles(host.ownerDocument);
  const step = mountPolicyAcceptStep(host, controller, {
    t: policyText(options.strings),
    classes: options.classes,
    onSubmit: options.onSubmit,
    onDecline: (policy) => options.onDecline?.(policy.title),
  });
  return {
    setBusy: (busy) => step.setBusy(busy),
    destroy() {
      try {
        step.destroy();
      } catch {
        // see mountInto
      }
    },
  };
}

export interface PolicyGateOptions extends PolicyUiOptions {
  client: FapiClient;
  locale?: string;
  /** Called after the user accepted and the server confirmed. */
  onAccepted?(): void;
}

/**
 * Mount the signed-in re-acceptance banner into `host`: it loads
 * `GET /v1/client/me/policies`, shows a banner when a policy needs accepting
 * (with the end of any grace window), and "Review and accept" opens the
 * acceptance step and posts `/v1/client/me/policies/accept`. Draws nothing when
 * there is nothing to accept. Call it only for a signed-in user.
 */
export function mountPolicyGate(host: HTMLElement, options: PolicyGateOptions): { destroy(): void; ready: Promise<void> } {
  const doc = host.ownerDocument;
  const t = policyText(options.strings);
  const gate = new PolicyGateController(options.client, options.locale);
  let step: ReturnType<typeof mountPolicyAcceptStep> | null = null;
  let open = false;
  let error = '';
  let alive = true;
  injectPolicyStyles(doc);

  const draw = () => {
    if (!alive) return;
    host.textContent = '';
    host.setAttribute('data-atlas-policy-gate', '');
    if (gate.pending.length === 0 && !open) return;
    if (open) return;
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
    if (error) {
      const p = doc.createElement('p');
      p.setAttribute('role', 'alert');
      p.textContent = error;
      host.append(p);
    }
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
    error = '';
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
          error = res.errors[0]?.message ?? t('policy.requiredGeneric');
          const p = doc.createElement('p');
          p.setAttribute('role', 'alert');
          p.textContent = error;
          host.append(p);
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
