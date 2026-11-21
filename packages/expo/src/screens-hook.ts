import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { SecuritySectionKind, SecuritySectionView, SignInScreenView } from '@atlasauth/js';
import { ExpoNativeContext } from './fapi-context';
import { useExpoFapiClient } from './policies';
import { createExpoSecuritySection, createExpoSignInScreen, createExpoSignUpScreen, type SecuritySectionSetup, type SignInScreenSetup } from './screens';

/**
 * The whole sign-in screen as a view-model: `const { view, ...actions } = useSignInScreen({ apple, google, passkey })`.
 * Render `view.step`, `view.methods`, `view.fields`, `view.error`; call `submit`, `selectMethod`, `sendCode`,
 * `signInWithPasskey`, `signInWithApple`, `signInWithGoogle`. Second-factor setup, recovery codes, policies and required
 * actions are steps of the same view (`enroll_second_factor`, `recovery_codes`, `policies`, `required_action`).
 * No fetch in your app; a completed sign-in is stored by the provider like any other.
 */
export function useSignInScreen(setup: SignInScreenSetup = {}) {
  const client = useExpoFapiClient();
  // Created once per client; the setup (providers, localization) is read when the client changes.
  const screen = useMemo(() => createExpoSignInScreen(client, setup), [client]); // eslint-disable-line react-hooks/exhaustive-deps
  const view: SignInScreenView = useSyncExternalStore(screen.subscribe, screen.getView, screen.getView);
  // A browser sign-in (`useSignIn().signInWithOAuth`) that came back owing a second factor or a required action continues here.
  const native = useContext(ExpoNativeContext);
  useEffect(() => native?.onPending((a) => void screen.flow.resumeAttempt(a)), [native, screen]);
  return { view, ...screen };
}

/**
 * The create-account screen as a view-model: `const { view, submit, saveDraft } = useSignUpScreen()`. Starts at
 * `view.step === 'details'` (`view.fields`, `view.legal`); after the account is made it walks the same steps as
 * sign-in: verify the email, policies, second-factor setup, recovery codes, and the required actions and journey
 * forms a sign-up journey adds (`required_action`, with typed `view.fields` and `saveDraft()` to resume later).
 */
export function useSignUpScreen(setup: Pick<SignInScreenSetup, 'localization' | 'passkey'> = {}) {
  const client = useExpoFapiClient();
  const screen = useMemo(() => createExpoSignUpScreen(client, setup), [client]); // eslint-disable-line react-hooks/exhaustive-deps
  const view: SignInScreenView = useSyncExternalStore(screen.subscribe, screen.getView, screen.getView);
  return { view, ...screen };
}

/**
 * One account-security section as a view-model, step-up handled inside:
 * `const { view, remove, startTotp, submit } = useSecuritySection('mfa', { choose })`.
 */
export function useSecuritySection(kind: SecuritySectionKind, setup: SecuritySectionSetup = {}) {
  const client = useExpoFapiClient();
  // The latest callbacks without re-creating the section on every render.
  const latest = useRef(setup);
  latest.current = setup;
  const section = useMemo(
    () =>
      createExpoSecuritySection(client, kind, {
        ...(setup.localization !== undefined ? { localization: setup.localization } : {}),
        ...(setup.choose ? { choose: (request) => latest.current.choose!(request) } : {}),
        ...(setup.passkey?.assertion ? { passkey: { assertion: (challenge) => latest.current.passkey!.assertion!(challenge) } } : {}),
        ...(setup.addPasskey ? { addPasskey: (c) => latest.current.addPasskey!(c) } : {}),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, kind],
  );
  const view: SecuritySectionView = useSyncExternalStore(section.subscribe, section.getView, section.getView);
  return { view, ...section };
}
