import type { PasskeyExtensionResults, PasskeyPrfRequest } from '@atlasauth/js';
/**
 * The step-flow primitives — `Root`, `Step`, `Action`, `Strategy` — shared by
 * `<SignIn.*>` and `<SignUp.*>`. They are built once here and attached to each
 * namespace in `sign-in.tsx` / `sign-up.tsx`, so the two surfaces stay identical
 * in behaviour and only differ in which flow their `Root` drives.
 *
 * None of these renders chrome. `Step` and `Strategy` are pure conditional
 * boundaries (they render their children, or nothing); `Action` renders a bare
 * `<button>` (or your element, via `asChild`). What the server says is current is
 * the only thing that decides what shows.
 */

import { useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { EMAIL_UNAVAILABLE_MESSAGE, type Policy, type PolicyAcceptanceController } from '@atlasauth/js';
import { PolicyClickwrap, PolicyConsent, PolicyScrollQueue, usePolicyText } from '@atlasauth/react';
import { FlowProvider, useFlowContext, useFlowDriver, type FlowContextValue } from './context';
import { Slot } from './primitives';
import {
  oauthProviderOf,
  runAction,
  signUpEmailUnavailable,
  stepMatches,
  strategyAvailable,
  type ActionName,
  type FlowMode,
  type StepName,
} from './machine';

export interface RootProps {
  /** Where to send the user once the flow completes. Optional. */
  afterUrl?: string;
  /**
   * Request the WebAuthn `prf` extension in the passkey ceremony (sign-in with
   * a passkey on `<SignIn.Root>`): a secret derived from the passkey and your
   * salt, for client-side encryption keys. It never reaches Atlas.
   */
  passkeyPrf?: PasskeyPrfRequest;
  /** Receives the passkey ceremony's client extension results (the PRF outputs). */
  onPasskeyExtensionResults?: (results: PasskeyExtensionResults) => void;
  /**
   * Render-prop form: receive the live flow context (attempt, errors, busy, …) so
   * you can drive entirely bespoke markup. Otherwise children are rendered as-is.
   */
  children?: ReactNode | ((flow: FlowContextValue) => ReactNode);
}

/** Build the `Root` for a flow mode: runs the driver and provides the context. */
export function makeRoot(mode: FlowMode) {
  function Root({ afterUrl, passkeyPrf, onPasskeyExtensionResults, children }: RootProps) {
    const flow = useFlowDriver(mode, { afterUrl, passkeyPrf, onPasskeyExtensionResults });
    return (
      <FlowProvider value={flow}>
        {typeof children === 'function' ? children(flow) : children}
      </FlowProvider>
    );
  }
  Root.displayName = mode === 'sign-in' ? 'SignIn.Root' : 'SignUp.Root';
  return Root;
}

export interface StepProps {
  name: StepName;
  /** Render-prop form: receive the flow context when this step is current. */
  children?: ReactNode | ((flow: FlowContextValue) => ReactNode);
}

/**
 * Renders its children ONLY when the server's current status resolves to `name`.
 * Exactly one `<Step>` is ever live, and the decision is the server's — never the
 * client's (see `machine.stepForAttempt`).
 */
export function Step({ name, children }: StepProps) {
  const flow = useFlowContext();
  if (!stepMatches(flow.attempt, name)) return null;
  return <>{typeof children === 'function' ? children(flow) : children}</>;
}

export interface ActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSubmit'> {
  /** `submit` advances the attempt, `resend` re-sends a code, `navigate` routes. */
  action?: ActionName;
  /** Target route for `action="navigate"`. */
  navigate?: string;
  /** Render onto your own element instead of a bare `<button>`. */
  asChild?: boolean;
  children?: ReactNode;
}

/**
 * A bare `<button>` that fires the attempt method its `action` names (default
 * `submit`). A `submit` button is `type="submit"` so it also fires when the form
 * is submitted by Enter; everything else is `type="button"`. The right method is
 * resolved in one place (`machine.runAction`), so an `<Action>` can never call the
 * wrong one.
 */
export function Action({
  action = 'submit',
  navigate,
  asChild,
  children,
  ...rest
}: ActionProps) {
  const flow = useFlowContext();
  const actions = {
    submit: () => flow.submit(),
    resend: () => flow.resend(),
    navigate: (to: string) => {
      if (typeof window !== 'undefined') window.location.assign(to);
    },
  };

  const props: ButtonHTMLAttributes<HTMLButtonElement> = {
    type: action === 'submit' ? 'submit' : 'button',
    disabled: action === 'submit' ? flow.busy || flow.policiesSatisfied === false || rest.disabled : rest.disabled,
    ...rest,
    onClick: (event) => {
      rest.onClick?.(event);
      runAction(actions, action, navigate);
    },
  };

  return (
    <Slot asChild={asChild} props={props} defaultElement={(p) => <button {...p}>{children}</button>}>
      <button>{children}</button>
    </Slot>
  );
}

export interface StrategyProps {
  /** `password`, `email_code`, `email_link`, `passkey`, `reset_password`, or `oauth_<provider>`. */
  name: string;
  children?: ReactNode;
}

/**
 * Renders its children only when `name` is an available strategy for the current
 * attempt — the server's `supported_first_factors` on a first-factor step, or the
 * social / passkey strategies on the start screen. Wraps an `oauth_*` / `passkey`
 * strategy's children in a boundary that also begins the ceremony when activated:
 * put an `<Action>` or your own button inside and call the provided starter.
 *
 * Email code / link are hidden while the app can't deliver email, and
 * `reset_password` (wrap your "Forgot password?" link in it) shows on a
 * first-factor step that offers `password` only while reset emails can be
 * delivered — see `machine.strategyAvailable`.
 */
export function Strategy({ name, children }: StrategyProps) {
  const flow = useFlowContext();
  if (!strategyAvailable(flow.attempt, name, flow.emailDelivery)) return null;
  return <>{children}</>;
}

export interface EmailUnavailableProps {
  /** What to show; defaults to the English "can't send email" message. */
  children?: ReactNode;
}

/**
 * Renders its children only when email + password sign-up cannot complete
 * because the app can't deliver the verification email
 * (`instanceSettings.emailDelivery.passwordSignUp === false`). Put it in the
 * `start` step and hide your form with `flow.emailDelivery` (render-prop) when it
 * shows — the server refuses that sign-up anyway. Without children it renders
 * the default English message as text (no element of its own).
 */
export function EmailUnavailable({ children }: EmailUnavailableProps) {
  const flow = useFlowContext('sign-up');
  if (flow.attempt || !signUpEmailUnavailable(flow.emailDelivery)) return null;
  return <>{children ?? EMAIL_UNAVAILABLE_MESSAGE}</>;
}

/**
 * Convenience: a bare `<button>` that begins a social / OIDC sign-in for one
 * provider (the `oauth_<provider>` strategy). Renders only when that provider is
 * an available strategy. `asChild` merges onto your own button.
 */
export function makeOauthButton() {
  function OauthButton({
    provider,
    asChild,
    children,
    ...rest
  }: {
    provider: string;
    asChild?: boolean;
    children?: ReactNode;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
    const flow = useFlowContext();
    const strategy = `oauth_${provider}`;
    if (!strategyAvailable(flow.attempt, strategy)) return null;

    const props: ButtonHTMLAttributes<HTMLButtonElement> = {
      type: 'button',
      ...rest,
      onClick: () => {
        const p = oauthProviderOf(strategy);
        if (p) void flow.startOauth(p);
      },
    };
    return (
      <Slot
        asChild={asChild}
        props={props}
        defaultElement={(pr) => <button {...pr}>{children}</button>}
      >
        <button>{children}</button>
      </Slot>
    );
  }
  OauthButton.displayName = 'Connection';
  return OauthButton;
}

export interface CaptchaProps {
  /** Render onto your own element instead of a bare `<div>`. */
  asChild?: boolean;
  children?: ReactNode;
}

/**
 * Where the instance's captcha widget draws (Turnstile, hCaptcha, reCAPTCHA), in
 * the mode the dashboard configured. Renders a bare `<div>` only while the
 * current step needs one — the sign-up create step when sign-up captcha is on,
 * the sign-in start step when sign-in captcha is always on, and the
 * `needs_captcha` challenge (solving it continues the sign-in on its own). Its
 * token is sent as `captcha_token` with the next submit; a refused token draws a
 * fresh widget. Place it inside the `start` step, before the submit `<Action>`.
 */
export function Captcha({ asChild, children }: CaptchaProps) {
  const flow = useFlowContext();
  const controller = flow.captcha;
  const ref = useCallback(
    (el: HTMLElement | null) => {
      controller?.attach(el);
    },
    [controller],
  );
  if (!controller || !flow.captchaNeeded) return null;
  const props = { ref, 'data-atlas-captcha': '' } as Record<string, unknown>;
  return (
    <Slot asChild={asChild} props={props} defaultElement={(p) => <div {...p} />}>
      {children}
    </Slot>
  );
}

export interface PoliciesRenderProps {
  /** The state machine: policies, ticks, `build()`. */
  controller: PolicyAcceptanceController;
  policies: Policy[];
  /** Whether the required checkbox policies are all ticked. */
  satisfied: boolean;
  /** A policy the user declined and has not retried. */
  declined: string | null;
}

export interface PoliciesProps {
  /**
   * Render-prop form for fully custom markup. Without it the policies draw as
   * plain, class-hooked markup: the checkbox block with its in-page viewer and
   * the clickwrap sentence.
   */
  children?: ReactNode | ((props: PoliciesRenderProps) => ReactNode);
}

/**
 * The instance's policies (terms, privacy, any policy) for the current step.
 * On `<SignUp.Step name="start">` it is the create-account policies; on
 * `<SignIn.Step name="policies">` the policies waiting for acceptance. Renders
 * nothing when there are none. Scroll-mode policies appear as the unskippable
 * dialog: on submit at sign-up, at once at sign-in. Gate your submit on
 * `flow.policiesSatisfied` (the `<Action>` does so itself).
 */
export function Policies({ children }: PoliciesProps) {
  const flow = useFlowContext();
  const controller = flow.policies;
  const [declinedHere, setDeclinedHere] = useState(false);
  const t = usePolicyText();
  if (!controller || controller.policies.length === 0) return null;
  const policies = controller.policies;
  const signIn = flow.mode === 'sign-in';
  const hasOthers = policies.some((p) => p.display !== 'scroll');
  const running = signIn ? !declinedHere : !!flow.policyReading;
  const props: PoliciesRenderProps = {
    controller,
    policies,
    satisfied: flow.policiesSatisfied ?? controller.canSubmit(),
    declined: flow.policyDeclined ?? null,
  };
  return (
    <>
      {typeof children === 'function' ? (
        children(props)
      ) : (
        children ?? (
          <>
            <PolicyConsent controller={controller} errors={flow.errors} />
            <PolicyClickwrap controller={controller} />
            {props.declined ? (
              <span role="alert" data-atlas-policy-declined="">
                {t('policy.declined', { policy: props.declined })}
              </span>
            ) : null}
          </>
        )
      )}
      <PolicyScrollQueue
        controller={controller}
        running={running}
        reaccept={signIn}
        onDone={() => {
          flow.setPolicyReading?.(false);
          if (!signIn || !hasOthers) void flow.submit();
        }}
        onDecline={(policy) => {
          setDeclinedHere(true);
          flow.declinePolicy?.(policy.title);
        }}
      />
    </>
  );
}
