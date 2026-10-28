'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  atlasCaptchaLabels,
  listPublicPlans,
  planPriceView,
  startPlanCheckout,
  type PublicBillingPlan,
  awaitingPasskey,
  flowNeedsCaptcha,
  isPolicyAcceptanceRequired,
  passkeysSupported,
  registerSignUpPasskey,
  startPasskeySignUp,
  startSignUp,
  type FieldError,
  type PolicyAcceptancePayload,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { FapiClient, type FlowState } from './fapi';
import { AttemptFlow, useFlow, type FlowProps } from './flow';
import { CaptchaSlot, localizeCaptchaErrors, useCaptcha, type CaptchaController } from './captcha';
import { forceCaptchaFlow, useReferralChallenge } from './referral';
import { PolicyClickwrap, PolicyConsent, PolicyScrollQueue, usePolicies, usePolicyText, type UsePoliciesResult } from './policies';
import { useClass, useClasses, useErrorText, useText } from './components-shared';
import type { InstanceSettings, PublicSignUpField } from './instance-settings';
import { ATLAS_REACT_SDK } from './version';

/**
 * §10.2 `<SignUp/>` — creates an account.
 *
 * The first step is the create-account form: the instance's configured extra
 * fields, email + password, the legal-consent row and — when the instance
 * requires one on sign-up — the captcha widget. It POSTs `/v1/client/sign_ups`;
 * from there the flow is server-driven exactly like `<SignIn>` (the shared
 * `AttemptFlow` renders the email-code step, which `advance` posts to the
 * sign-up's `attempt_verification`), finishing through the same ticket exchange.
 *
 * All of it is read from the instance's settings, so a field, a consent policy
 * or a captcha switched on in the dashboard appears here with no code change.
 *
 * When the instance offers passkey-only sign-up (`account.passkeySignUp`) and
 * the browser supports passkeys, the form offers "Sign up with a passkey": no
 * password field, the email only when the instance collects one, and — after
 * any email proof — a "Create passkey" step. The account is created by the
 * server only when that passkey registers.
 *
 * When the app can't deliver the verification email
 * (`instanceSettings.emailDelivery.passwordSignUp === false`) the form is
 * replaced by a "can't send email" notice (`signUp.emailUnavailable`) — the
 * server would refuse the sign-up anyway.
 */
export function SignUp(props: FlowProps = {}) {
  const { instanceSettings } = useAtlas();
  const t = useText();
  // Plan selection: the chosen plan rides a ref so the post-sign-up hook sees the latest choice.
  const planRef = useRef<string | null>(null);
  const afterSignIn = useCallback(
    async (flowClient: FapiClient) => {
      if (!props.planSelection || !planRef.current) return false;
      const here = typeof window === 'undefined' ? '/' : window.location.href;
      const out = await startPlanCheckout(flowClient, { planId: planRef.current, successUrl: props.afterUrl ?? here });
      if (!out.url) return false;
      window.location.assign(out.url);
      return true;
    },
    [props.planSelection, props.afterUrl],
  );
  const { state, setState, submit, client, finish } = useFlow({
    afterUrl: props.afterUrl,
    afterSignIn,
    signInCaptcha: false,
    referral: props.referral,
    referralConsent: props.referralConsent,
  });

  // A sign-up carrying a referral code shows the challenge when the instance asks for it.
  const referralChallenge = useReferralChallenge(client, instanceSettings);
  const signUpFlow = forceCaptchaFlow(instanceSettings?.captchaFlows.signUp, referralChallenge);
  const passkeyOffer = instanceSettings?.account?.passkeySignUp ?? null;
  const canPasskey = !!passkeyOffer && passkeysSupported();
  const [mode, setMode] = useState<'password' | 'passkey'>('password');
  const usingPasskey = mode === 'passkey' && canPasskey;
  const emailUnavailable =
    instanceSettings?.emailDelivery?.passwordSignUp === false &&
    // A passkey sign-up that collects no email (or an unproven one) needs no mail.
    !(usingPasskey && passkeyOffer?.email !== 'required');
  const captcha = useCaptcha(signUpFlow, {
    active: !state.attempt && !emailUnavailable && flowNeedsCaptcha(signUpFlow),

    atlasLabels: atlasCaptchaLabels(t),
  });

  // The instance's policies (terms, privacy, …): shown in place of the legacy single consent row.
  const policies = usePolicies({ combined: props.policyConsent !== 'separate' }, client);

  const create = useCallback(
    (values: Record<string, string>, consent: boolean) => {
      if (props.planSelection === 'required' && !planRef.current) {
        setState((current) => ({ ...current, errors: [{ code: 'PLAN_REQUIRED', message: 'Choose a plan to continue.' }] }));
        return;
      }
      void (async () => {
        setState((current) => ({ ...current, busy: true, errors: [] }));
        const { email = '', password = '', ...rest } = values;
        // Drop blank optional fields so the server never sees empty strings.
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(rest)) if (value) fields[key] = value;

        const token = await captcha.getToken();
        const policyAcceptances = policies.controller.build();
        let next: FlowState = usingPasskey
          ? await startPasskeySignUp(client, {
              email: email || undefined,
              fields,
              consent,
              captchaToken: token ?? undefined,
              policyAcceptances,
            })
          : await startSignUp(client, {
              email,
              password,
              fields,
              consent,
              captchaToken: token ?? undefined,
              policyAcceptances,
            });
        // A policy changed while the form was open: reload them so the form asks again.
        if (isPolicyAcceptanceRequired(next.errors)) await policies.refresh();
        const localized = localizeCaptchaErrors(next.errors, t);
        next = { ...next, errors: localized.errors };
        // The token was spent either way; a refused create needs a fresh one.
        if (next.errors.length > 0 && captcha.needed) captcha.reset();
        await finish(next);
      })();
    },
    [captcha, client, finish, props.planSelection, setState, t, usingPasskey],
  );

  /** Run the browser ceremony; the server creates the account when it verifies. */
  const createPasskey = useCallback(() => {
    void (async () => {
      setState((current) => ({ ...current, busy: true, errors: [] }));
      const next = await registerSignUpPasskey(client, state, {
        ...(props.passkeyPrf ? { prf: props.passkeyPrf } : {}),
        ...(props.onPasskeyExtensionResults ? { onExtensionResults: props.onPasskeyExtensionResults } : {}),
      });
      await finish({
        ...next,
        errors: next.errors.map((e) => (e.code === 'PASSKEY_CANCELLED' ? { ...e, message: t('signUp.passkeyCancelled') } : e)),
      });
    })();
  }, [client, finish, setState, state, t, props.passkeyPrf, props.onPasskeyExtensionResults]);

  if (state.attempt && awaitingPasskey(state.attempt)) {
    return <PasskeySignUpStep busy={state.busy} errors={state.errors} hideTitle={props.hideTitle} onCreate={createPasskey} />;
  }

  if (state.attempt) {
    return (
      <AttemptFlow
        attempt={state.attempt}
        busy={state.busy}
        errors={state.errors}
        sessionKept={state.sessionKept}
        titleKey="signUp.title"
        hideTitle={props.hideTitle}
        onSubmit={submit}
      />
    );
  }

  if (emailUnavailable) return <SignUpEmailUnavailable hideTitle={props.hideTitle} />;

  return (
    <>
      {props.planSelection ? <SignUpPlanStep client={client} required={props.planSelection === 'required'} onChange={(id) => { planRef.current = id; }} /> : null}
    <SignUpForm
      settings={instanceSettings}
      busy={state.busy}
      errors={state.errors}
      hideTitle={props.hideTitle}
      captcha={captcha}
      policies={policies}
      onSubmit={create}
      passkey={usingPasskey ? { email: passkeyOffer!.email } : null}
      onSwitchMode={
        canPasskey
          ? () => {
              setState((current) => ({ ...current, errors: [] }));
              setMode(usingPasskey ? 'password' : 'passkey');
            }
          : undefined
      }
    />
    </>
  );
}

/**
 * The optional plan step above the create-account form: the instance's user plans
 * as radio cards with locale-formatted price, trial and promotion. The choice is
 * reported up; the account form's own submit then creates the account and the
 * flow continues to Checkout for it.
 */
function SignUpPlanStep({ client, required, onChange }: { client: FapiClient; required: boolean; onChange(planId: string | null): void }) {
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [plans, setPlans] = useState<PublicBillingPlan[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listPublicPlans(client, { audience: 'user' }).then((p) => live && setPlans(p.filter((x) => x.kind !== 'addon')));
    return () => { live = false; };
  }, [client]);
  const choose = (id: string | null) => { setChosen(id); onChange(id); };
  if (plans.length === 0) return null;
  return (
    <fieldset className={cardClass} data-atlas="sign-up-plans" aria-required={required}>
      <legend className={cls('headerSubtitle', 'atlas-subtitle')}>{required ? 'Choose a plan' : 'Choose a plan (optional)'}</legend>
      {plans.map((plan) => {
        const v = planPriceView(plan);
        return (
          <label key={plan.id} className={cls('formField', 'atlas-field')} data-atlas="sign-up-plan">
            <input type="radio" name="atlas-plan" value={plan.id} checked={chosen === plan.id} onChange={() => choose(plan.id)} />{' '}
            <strong>{plan.name}</strong> — {v.originalPrice ? <s>{v.originalPrice}</s> : null} {v.free ? 'Free' : v.price}
            {v.trialDays ? ` · ${v.trialDays}-day free trial` : ''}
            {v.promotionLabel ? ` · ${v.promotionLabel}` : ''}
          </label>
        );
      })}
      {required ? null : (
        <button type="button" className={cls('formButtonSecondary', 'atlas-button-secondary')} onClick={() => choose(null)}>
          Skip for now
        </button>
      )}
    </fieldset>
  );
}

/** The passkey-only sign-up's last step: create the passkey (which creates the account). */
function PasskeySignUpStep({
  busy,
  errors,
  hideTitle,
  onCreate,
}: {
  busy: boolean;
  errors: FieldError[];
  hideTitle?: boolean;
  onCreate(): void;
}) {
  const t = useText();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const cls = useClasses();
  return (
    <div className={cardClass} data-atlas-passkey-sign-up="">
      {hideTitle ? null : <h1 className={titleClass}>{t('signUp.title')}</h1>}
      {errors.map((error) => (
        <p key={error.code} className={errorClass} role="alert">
          {errorText(error)}
        </p>
      ))}
      <p className={cls('text', 'atlas-text')}>{t('signUp.passkeyPrompt')}</p>
      <button className={buttonClass} type="button" disabled={busy} onClick={onCreate}>
        {t('signUp.passkeyCreate')}
      </button>
    </div>
  );
}

/** The "can't send email" state shown instead of the create-account form. */
function SignUpEmailUnavailable({ hideTitle }: { hideTitle?: boolean }) {
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const errorClass = useClass('formFieldError', 'atlas-error');
  return (
    <div className={cardClass}>
      {hideTitle ? null : <h1 className={titleClass}>{t('signUp.title')}</h1>}
      <p className={errorClass} role="alert" data-atlas-email-unavailable="">
        {t('signUp.emailUnavailable')}
      </p>
    </div>
  );
}

/** The create-account step. Values are kept in state so an error never clears them. */
function SignUpForm({
  settings,
  busy,
  errors,
  hideTitle,
  captcha,
  policies,
  onSubmit,
  passkey = null,
  onSwitchMode,
}: {
  settings: InstanceSettings | null;
  busy: boolean;
  errors: FieldError[];
  hideTitle?: boolean;
  captcha: CaptchaController;
  policies: UsePoliciesResult;
  onSubmit(values: Record<string, string>, consent: boolean): void;
  /** Passkey-only sign-up: no password field; the email per the instance's mode. */
  passkey?: { email: 'off' | 'optional' | 'required' } | null;
  /** Toggle between the password and passkey forms (only when both are offered). */
  onSwitchMode?(): void;
}) {
  const t = useText();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const cls = useClasses();

  const [values, setValues] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  const pt = usePolicyText();
  const [reading, setReading] = useState(false);
  const [declined, setDeclined] = useState<string | null>(null);
  const hasPolicies = policies.policies.length > 0;
  // Instance policies replace the legacy single "I agree to the Terms" row.
  const legal = hasPolicies ? undefined : settings?.legal;
  const showLegal = !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
  const consentOk = (!legal?.required || agreed) && (!hasPolicies || policies.controller.canSubmit());

  const fieldErrors = (name: string) =>
    errors
      .filter((error) => error.param === name)
      .map((error) => (
        <span key={error.code} className={errorClass}>
          {errorText(error)}
        </span>
      ));

  const label = (f: { label: string; required: boolean }) =>
    f.required ? f.label : t('signUp.optionalField', { label: f.label });

  const control = (f: PublicSignUpField) => {
    const value = values[f.key] ?? '';
    switch (f.type) {
      case 'checkbox':
        return (
          <input
            type="checkbox"
            name={f.key}
            checked={value === 'true'}
            onChange={(e) => set(f.key, e.target.checked ? 'true' : '')}
          />
        );
      case 'select':
        return (
          <select className={inputClass} name={f.key} value={value} required={f.required} onChange={(e) => set(f.key, e.target.value)}>
            <option value="">{f.placeholder ?? t('signUp.selectPlaceholder')}</option>
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      case 'textarea':
        return (
          <textarea
            className={inputClass}
            name={f.key}
            rows={3}
            value={value}
            required={f.required}
            placeholder={f.placeholder ?? undefined}
            onChange={(e) => set(f.key, e.target.value)}
          />
        );
      case 'radio':
      case 'multiselect': {
        // Same encoding as the embed widget and hosted page: one value, or a
        // comma-joined list for multiselect.
        const picked = value ? value.split(', ') : [];
        return (
          <span className={cls('list', 'atlas-choices')}>
            {f.options.map((o) => (
              <label key={o} className={cls('listItem', 'atlas-choice')}>
                <input
                  type={f.type === 'radio' ? 'radio' : 'checkbox'}
                  name={f.key}
                  value={o}
                  checked={picked.includes(o)}
                  onChange={(e) => {
                    if (f.type === 'radio') set(f.key, o);
                    else
                      set(
                        f.key,
                        (e.target.checked ? [...picked, o] : picked.filter((p) => p !== o)).join(', '),
                      );
                  }}
                />
                {o}
              </label>
            ))}
          </span>
        );
      }
      default: {
        const type = ['email', 'tel', 'url', 'number', 'date'].includes(f.type) ? f.type : 'text';
        return (
          <input
            className={inputClass}
            type={type}
            name={f.key}
            value={value}
            required={f.required}
            placeholder={f.placeholder ?? undefined}
            onChange={(e) => set(f.key, e.target.value)}
          />
        );
      }
    }
  };

  const textField = (name: string, labelKey: string, type: string, autoComplete: string, required = true) => (
    <label key={name} className={cls('formField', 'atlas-field')}>
      <span className={cls('formFieldLabel', 'atlas-field-label')}>
        {required ? t(labelKey) : t('signUp.optionalField', { label: t(labelKey) })}
      </span>
      <input
        className={inputClass}
        type={type}
        name={name}
        autoComplete={autoComplete}
        required={required}
        value={values[name] ?? ''}
        onChange={(e) => set(name, e.target.value)}
      />
      {fieldErrors(name)}
    </label>
  );

  const links = showLegal
    ? [
        legal!.termsUrl ? (
          <a key="terms" className={cls('link', 'atlas-link')} href={legal!.termsUrl} target="_blank" rel="noopener noreferrer">
            {t('signUp.terms')}
          </a>
        ) : null,
        legal!.privacyUrl ? (
          <a key="privacy" className={cls('link', 'atlas-link')} href={legal!.privacyUrl} target="_blank" rel="noopener noreferrer">
            {t('signUp.privacy')}
          </a>
        ) : null,
      ].filter((x) => x !== null)
    : [];

  return (
    <div className={cardClass}>
      {hideTitle ? null : <h1 className={titleClass}>{t('signUp.title')}</h1>}

      {errors
        .filter((error) => !error.param)
        .map((error) => (
          <p key={error.code} className={errorClass} role="alert">
            {errorText(error)}
          </p>
        ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!consentOk) return;
          setDeclined(null);
          // Scroll-mode policies are read in their dialog first; the sign-up goes once they are accepted.
          if (policies.controller.pendingScroll()) {
            setReading(true);
            return;
          }
          onSubmit(values, legal?.required ? agreed : true);
        }}
      >
        {(settings?.signUpFields ?? []).map((f) => {
          const body = (
            <>
              <span className={cls('formFieldLabel', 'atlas-field-label')}>{label(f)}</span>
              {control(f)}
              {fieldErrors(f.key)}
            </>
          );
          // A choice group holds several inputs, so it can't sit inside one <label>.
          return f.type === 'radio' || f.type === 'multiselect' ? (
            <div key={f.key} className={cls('formField', 'atlas-field')}>
              {body}
            </div>
          ) : (
            <label key={f.key} className={cls('formField', 'atlas-field')}>
              {body}
            </label>
          );
        })}
        {passkey
          ? passkey.email === 'off'
            ? null
            : textField('email', 'signUp.emailLabel', 'email', 'email', passkey.email === 'required')
          : textField('email', 'signUp.emailLabel', 'email', 'email')}
        {passkey ? null : textField('password', 'signUp.passwordLabel', 'password', 'new-password')}
        {passkey ? <p className={cls('text', 'atlas-text')}>{t('signUp.passkeyIntro')}</p> : null}

        {showLegal ? (
          <label className={cls('formField', 'atlas-consent')}>
            {legal!.required ? (
              <input
                type="checkbox"
                name="consent"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
            ) : null}
            <span className={cls('text', 'atlas-text')}>
              {t(legal!.required ? 'signUp.consentAgree' : 'signUp.consentNotice')}{' '}
              {links.map((link, i) => (
                <span key={i}>
                  {i > 0 ? ` ${t('signUp.and')} ` : null}
                  {link}
                </span>
              ))}
              .
            </span>
            {fieldErrors('consent')}
          </label>
        ) : null}

        {hasPolicies ? (
          <>
            <PolicyConsent controller={policies.controller} errors={errors} />
            {declined ? (
              <span className={errorClass} role="alert" data-atlas-policy-declined="">
                {pt('policy.declined', { policy: declined })}
              </span>
            ) : null}
          </>
        ) : null}

        <CaptchaSlot controller={captcha} />

        <button className={buttonClass} disabled={busy || !consentOk} type="submit">
          {t('signUp.submit')}
        </button>
        {hasPolicies ? <PolicyClickwrap controller={policies.controller} /> : null}
        {hasPolicies ? (
          <PolicyScrollQueue
            controller={policies.controller}
            running={reading}
            onDone={() => {
              setReading(false);
              onSubmit(values, true);
            }}
            onDecline={(policy) => {
              setReading(false);
              setDeclined(policy.title);
            }}
          />
        ) : null}
        {onSwitchMode ? (
          <div className="atlas-alternatives">
            <button
              type="button"
              className={cls('link', 'atlas-link')}
              data-atlas-sign-up-mode={passkey ? 'password' : 'passkey'}
              disabled={busy}
              onClick={onSwitchMode}
            >
              {t(passkey ? 'signUp.passwordOption' : 'signUp.passkeyOption')}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

/**
 * §5.1 headless sign-up — the sign-up counterpart of {@link useSignIn}. Starts a
 * sign-up attempt and returns the resulting flow (usually `needs_email_verification`;
 * the shared `advance` then drives the code to completion), reloading the provider
 * when a sign-up completes with a session ticket.
 */
export function useSignUp() {
  const { publishableKey, frontendApi, locale, reload } = useAtlas();
  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi, locale, sdk: ATLAS_REACT_SDK }),
    [frontendApi, publishableKey, locale],
  );
  const create = useCallback(
    async (input: {
      email: string;
      password: string;
      fields?: Record<string, string>;
      consent?: boolean;
      captchaToken?: string;
      /** The instance's policies the user accepted (`usePolicies().build()`). */
      policyAcceptances?: PolicyAcceptancePayload[];
    }): Promise<FlowState> => {
      const next = await startSignUp(client, input);
      if (next.attempt?.status === 'complete' && next.ticket) {
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
        await reload();
      }
      return next;
    },
    [client, reload],
  );
  return { create };
}
