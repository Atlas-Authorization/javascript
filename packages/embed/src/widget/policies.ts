import {
  PolicyAcceptanceController,
  controllerForPending,
  injectPolicyStyles,
  isPolicyAcceptanceRequired,
  loadPolicies,
  mountPolicyClickwrap,
  mountPolicyAcceptStep,
  mountPolicyConsent,
  policyTranslator,
  runScrollPolicies,
  type PolicyT,
} from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { doc, el } from './dom';
import { render } from './render';
import { submit } from './flow';
import { say } from './mfa';

/**
 * Policy acceptance (terms, privacy, any policy) in the widget: the sign-up's
 * consent block and clickwrap line, and the sign-in step for
 * `needs_policy_acceptance`. The state machine and the DOM pieces come from
 * `@atlasauth/js`, shared with every framework SDK.
 */

/** The widget's translator: its `localization` catalog (`policy.*`), else English. */
export function policyT(w: AtlasWidget): PolicyT {
  return policyTranslator((key, vars) => say(w, key, vars ?? {}));
}

/** Load the sign-up's policies (and the stylesheet the policy UI uses). */
export async function loadSignUpPolicies(w: AtlasWidget): Promise<void> {
  if (w.mode !== 'sign-up') return;
  injectPolicyStyles(doc(w));
  w.policies.setPolicies(await loadPolicies(w.client));
}

function classes(w: AtlasWidget) {
  return {
    link: 'atlas-embed-consent-link',
    text: 'atlas-embed-consent-text',
  };
}

/** Drop the previous render's subscriptions (the DOM they fed is gone). */
export function disposePolicyUi(w: AtlasWidget): void {
  for (const dispose of w.policyDispose.splice(0)) dispose();
}

/**
 * The sign-up form's policy block: the consent checkboxes (with the in-page
 * viewer) and the clickwrap line. Returns `null` when the instance has no
 * policies, so the caller keeps the legacy consent row.
 */
export function mountSignUpPolicies(
  w: AtlasWidget,
  onChange: () => void,
): { consent: HTMLElement; clickwrap: HTMLElement; canSubmit(): boolean; read(): Promise<boolean> } | null {
  const controller = w.policies;
  if (controller.policies.length === 0) return null;
  const t = policyT(w);
  const document = doc(w);
  const consent = el(w, 'div');
  const clickwrap = el(w, 'p');
  w.policyDispose.push(mountPolicyConsent(consent, controller, { t, document, classes: classes(w) }).destroy);
  w.policyDispose.push(mountPolicyClickwrap(clickwrap, controller, { t, document, classes: classes(w) }).destroy);
  w.policyDispose.push(controller.subscribe(onChange));
  return {
    consent,
    clickwrap,
    canSubmit: () => controller.canSubmit(),
    // Scroll-mode policies are read in their unskippable dialog when the form is submitted.
    async read() {
      if (!controller.pendingScroll()) return true;
      return runScrollPolicies(controller, { t, document, container: w.root });
    },
  };
}

/** After a 422 POLICY_ACCEPTANCE_REQUIRED: reload the policies so the form asks again. */
export async function refreshAfterRefusal(w: AtlasWidget): Promise<void> {
  if (!isPolicyAcceptanceRequired(w.state.errors)) return;
  w.policies.setPolicies(await loadPolicies(w.client));
}

/** The sign-in step: accept the policies the attempt is waiting on. */
export function renderPolicyStep(w: AtlasWidget): HTMLElement {
  const t = policyT(w);
  const document = doc(w);
  const wrap = el(w, 'div', 'atlas-embed-policies');
  injectPolicyStyles(document);
  const attempt = w.state.attempt as { id?: string; pending_policies?: unknown } | null;
  const attemptId = attempt?.id ?? null;

  if (!w.pendingPolicies || w.pendingPolicies.attemptId !== attemptId) {
    w.pendingPolicies = { attemptId, controller: null };
    void controllerForPending(w.client, attempt, {}).then((controller) => {
      if (w.pendingPolicies?.attemptId !== attemptId) return;
      w.pendingPolicies = { attemptId, controller };
      render(w);
    });
  }
  const controller: PolicyAcceptanceController | null = w.pendingPolicies.attemptId === attemptId ? w.pendingPolicies.controller : null;
  if (!controller) {
    wrap.appendChild(el(w, 'p', 'atlas-embed-note', t('policy.loading')));
    return wrap;
  }

  const step = mountPolicyAcceptStep(wrap, controller, {
    t,
    document,
    container: w.root,
    classes: classes(w),
    onSubmit: (acceptances) => {
      w.pendingPolicies = null;
      void submit(w, { policy_acceptances: JSON.stringify(acceptances) });
    },
    onDecline: (policy) => {
      // Declining cancels the attempt: back to the start, saying why.
      w.pendingPolicies = null;
      w.state = { attempt: null, errors: [{ code: 'POLICY_DECLINED', message: t('policy.declined', { policy: policy.title }) }], busy: false, pollSecret: null, ticket: null };
      render(w);
    },
  });
  step.setBusy(w.busy);
  w.policyDispose.push(step.destroy);
  return wrap;
}
