import { createElement, useContext, type ReactElement, type ReactNode } from 'react';
import type { FapiClient } from '@atlasauth/js';
import { useAtlas } from '@atlasauth/react';
import { ExpoFapiContext } from './fapi-context';
import {
  PolicyGateView,
  usePendingPoliciesWith,
  usePoliciesWith,
  usePolicyGateWith,
  type PolicyUiProps,
  type UsePoliciesResult,
  type UsePolicyGateResult,
} from '@atlasauth/react-native';

/**
 * Policy acceptance (terms of service, privacy, any policy) for Expo.
 *
 * The native components are the ones in `@atlasauth/react-native` — they take a
 * `PolicyAcceptanceController` and draw with React Native primitives — so they
 * are re-exported here unchanged. The hooks are bound to THIS package's
 * provider: they use the bearer-authenticated client `<AtlasProvider>` builds
 * over the same token cache, never the DOM components `@atlasauth/react` ships.
 *
 * A sign-up / sign-in screen written with `@atlasauth/js` passes
 * `useExpoFapiClient()` to `startSignUp({ policyAcceptances })` and
 * `acceptAttemptPolicies(...)`.
 */

export {
  PolicyAcceptStep,
  PolicyClickwrap,
  PolicyConsent,
  PolicyDocument,
  PolicyGateView,
  PolicyScrollHost,
  PolicyScrollModal,
  PolicyViewer,
  parsePolicyHtml,
  policyPlainText,
  type PolicyUiProps,
  type UsePoliciesResult,
  type UsePolicyGateResult,
} from '@atlasauth/react-native';

export { ExpoFapiContext } from './fapi-context';

/**
 * The bearer-authenticated Frontend API client of the surrounding
 * `<AtlasProvider>`: the same token cache and transport the session uses.
 * Throws outside the provider, on purpose.
 */
export function useExpoFapiClient(): FapiClient {
  const client = useContext(ExpoFapiContext);
  if (!client) throw new Error('Atlas hooks must be used inside <AtlasProvider>.');
  return client;
}

function useEnv(): { client: FapiClient; locale?: string } {
  const client = useExpoFapiClient();
  const { locale } = useAtlas();
  return { client, locale: locale ?? undefined };
}

/**
 * Load the instance's policies into a controller (`GET /v1/client/policies`)
 * for a sign-up form; draw them with `<PolicyConsent>` / `<PolicyClickwrap>`,
 * enable your submit with `canSubmit`, and send `build()` as `policyAcceptances`.
 */
export function usePolicies(options: { combined?: boolean; signIn?: boolean } = {}): UsePoliciesResult {
  return usePoliciesWith(useEnv(), options);
}

/**
 * The controller for a sign-in attempt the server holds at
 * `needs_policy_acceptance`; pass `{ pendingPolicies }` from the held attempt
 * (an empty object, from a redirect, shows every required policy), or null.
 */
export function usePendingPolicies(
  held: { pendingPolicies?: unknown } | null | undefined,
  options: { combined?: boolean } = {},
) {
  return usePendingPoliciesWith(useEnv(), held, options);
}

/** In-app re-acceptance for the signed-in user (see `<PolicyGate>`). */
export function usePolicyGate(): UsePolicyGateResult {
  const env = useEnv();
  const { status } = useAtlas();
  return usePolicyGateWith(env, status === 'signed_in');
}

/**
 * A banner for a signed-in user whose policies need re-accepting. Draws nothing
 * when there is nothing to accept; renders `children` always. "Review and
 * accept" opens the acceptance step in a modal and posts the result.
 */
export function PolicyGate(props: { children?: ReactNode; onAccepted?: () => void } & PolicyUiProps): ReactElement {
  const gate = usePolicyGate();
  return createElement(PolicyGateView, { ...props, gate });
}
