import { component$, noSerialize, Slot, useSignal, useVisibleTask$, type NoSerialize, type Signal } from '@builder.io/qwik';
import type { PolicyAcceptanceController, PolicyAcceptancePayload } from '@atlasauth/js';
import { useAtlas } from './context';
import {
  createPolicyClient,
  loadPendingController,
  loadPolicyController,
  mountAcceptStep,
  mountClickwrap,
  mountConsent,
  mountPolicyGate,
} from './policies';

/**
 * Qwik components for policy acceptance (terms of service, privacy, any policy).
 *
 * `<SignIn>` / `<SignUp>` already show the instance's policies (they mount the
 * `@atlasauth/embed` widget). Use these in a custom form:
 *
 * ```tsx
 * const policies = usePolicies();
 * <PolicyConsent controller={policies.controller.value} />
 * <button disabled={!policies.canSubmit.value} onClick$={...}>Create account</button>
 * ```
 *
 * The controller is a live object, so it is held `noSerialize`d and created in a
 * client-only `useVisibleTask$`; it reads back as `undefined` on the server.
 * Read acceptances in a click handler with `policies.controller.value?.build()`.
 */

export interface UsePoliciesResult {
  /** The state machine behind the policy UI (undefined until loaded in the browser). */
  controller: Signal<NoSerialize<PolicyAcceptanceController> | undefined>;
  loading: Signal<boolean>;
  /** Whether the submit may be enabled: required boxes ticked (`scroll` policies are read on submit). */
  canSubmit: Signal<boolean>;
}

/**
 * Load the instance's policies (`GET /v1/client/policies`) into a controller for a
 * sign-up form. `signIn` keeps only the policies that also apply at sign-in.
 */
export function usePolicies(options: { combined?: boolean; signIn?: boolean; locale?: string } = {}): UsePoliciesResult {
  const store = useAtlas();
  const controller = useSignal<NoSerialize<PolicyAcceptanceController>>();
  const loading = useSignal(true);
  const canSubmit = useSignal(false);

  // eslint-disable-next-line qwik/no-use-visible-task -- the controller is a live
  // object the optimizer must not resume; it is created client-side only.
  useVisibleTask$(async ({ cleanup }) => {
    const client = createPolicyClient({ publishableKey: store.publishableKey, frontendApi: store.frontendApi, locale: options.locale });
    const c = await loadPolicyController(client, options);
    controller.value = noSerialize(c);
    canSubmit.value = c.canSubmit();
    loading.value = false;
    cleanup(c.subscribe(() => (canSubmit.value = c.canSubmit())));
  });

  return { controller, loading, canSubmit };
}

/** The `policy_acceptances` body for the current ticks (empty before the controller loads). */
export function buildAcceptances(controller: NoSerialize<PolicyAcceptanceController> | undefined): PolicyAcceptancePayload[] {
  return controller ? controller.build() : [];
}

export interface PolicyComponentProps {
  controller: NoSerialize<PolicyAcceptanceController> | undefined;
  /** Override any `policy.*` string. */
  strings?: Record<string, string>;
}

/** The checkbox block (combined or one each) with the in-page document viewer. */
export const PolicyConsent = component$<PolicyComponentProps>((props) => {
  const hostRef = useSignal<HTMLElement>();
  // eslint-disable-next-line qwik/no-use-visible-task -- DOM the optimizer must not resume.
  useVisibleTask$(({ track, cleanup }) => {
    const controller = track(() => props.controller);
    const host = hostRef.value;
    if (!host || !controller) return;
    cleanup(mountConsent(host, controller, { strings: props.strings }));
  });
  return <div class="atlas-policy-consent-host" ref={hostRef} />;
});

/** The clickwrap sentence for `link` policies, meant to sit under the submit button. */
export const PolicyClickwrap = component$<PolicyComponentProps>((props) => {
  const hostRef = useSignal<HTMLElement>();
  // eslint-disable-next-line qwik/no-use-visible-task -- see <PolicyConsent>.
  useVisibleTask$(({ track, cleanup }) => {
    const controller = track(() => props.controller);
    const host = hostRef.value;
    if (!host || !controller) return;
    cleanup(mountClickwrap(host, controller, { strings: props.strings }));
  });
  return <p class="atlas-policy-clickwrap-host" ref={hostRef} />;
});

export interface PolicyAcceptStepProps extends PolicyComponentProps {
  /** A held sign-in's pending policies (`pending_policies` on the attempt), to build the controller from. */
  attempt?: { pending_policies?: unknown } | null;
  /** The user accepted everything required: send these with `accept_policies`. */
  onSubmit$: (acceptances: PolicyAcceptancePayload[]) => void;
  /** The user declined a policy: cancel the attempt. */
  onDecline$?: (policyTitle: string) => void;
}

/**
 * The step a held sign-in shows (`needs_policy_acceptance`): scroll-mode
 * policies in their unskippable dialog, the rest as checkboxes, then "Accept and
 * continue". Give it `attempt` (the held attempt) or a ready `controller`.
 */
export const PolicyAcceptStep = component$<PolicyAcceptStepProps>((props) => {
  const store = useAtlas();
  const hostRef = useSignal<HTMLElement>();
  // eslint-disable-next-line qwik/no-use-visible-task -- see <PolicyConsent>.
  useVisibleTask$(async ({ track, cleanup }) => {
    const controllerProp = track(() => props.controller);
    const attempt = track(() => props.attempt);
    const host = hostRef.value;
    if (!host) return;
    let controller: PolicyAcceptanceController | undefined = controllerProp;
    if (!controller && attempt !== undefined) {
      const client = createPolicyClient({ publishableKey: store.publishableKey, frontendApi: store.frontendApi });
      controller = await loadPendingController(client, attempt);
    }
    if (!controller) return;
    const mounted = mountAcceptStep(host, controller, {
      strings: props.strings,
      onSubmit: (acceptances) => props.onSubmit$(acceptances),
      onDecline: (title) => props.onDecline$?.(title),
    });
    cleanup(mounted.destroy);
  });
  return <div class="atlas-policy-step-host" ref={hostRef} />;
});

/**
 * In-app re-acceptance: for a signed-in user, a banner when a policy needs
 * re-accepting; "Review and accept" opens the acceptance step and posts the
 * result. Renders its slot always.
 */
export const PolicyGate = component$<{ strings?: Record<string, string>; onAccepted$?: () => void }>((props) => {
  const store = useAtlas();
  const hostRef = useSignal<HTMLElement>();
  // eslint-disable-next-line qwik/no-use-visible-task -- see <PolicyConsent>.
  useVisibleTask$(({ track, cleanup }) => {
    const status = track(() => store.status);
    const host = hostRef.value;
    if (!host || status !== 'signed_in') return;
    const client = createPolicyClient({ publishableKey: store.publishableKey, frontendApi: store.frontendApi });
    const mounted = mountPolicyGate(host, { client, strings: props.strings, onAccepted: () => props.onAccepted$?.() });
    cleanup(mounted.destroy);
  });
  return (
    <>
      <div class="atlas-policy-gate-host" ref={hostRef} />
      <Slot />
    </>
  );
});
