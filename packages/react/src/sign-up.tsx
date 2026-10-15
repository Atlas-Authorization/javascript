import { useCallback, useMemo, useState } from 'react';
import { flowNeedsCaptcha, startSignUp, type FieldError } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { FapiClient, type FlowState } from './fapi';
import { AttemptFlow, useFlow, type FlowProps } from './flow';
import { CaptchaSlot, localizeCaptchaErrors, useCaptcha, type CaptchaController } from './captcha';
import { useClass, useClasses, useText } from './components-shared';
import type { InstanceSettings, PublicSignUpField } from './instance-settings';

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
 * When the app can't deliver the verification email
 * (`instanceSettings.emailDelivery.passwordSignUp === false`) the form is
 * replaced by a "can't send email" notice (`signUp.emailUnavailable`) — the
 * server would refuse the sign-up anyway.
 */
export function SignUp(props: FlowProps = {}) {
  const { instanceSettings } = useAtlas();
  const t = useText();
  const { state, setState, submit, client, finish } = useFlow({
    afterUrl: props.afterUrl,
    signInCaptcha: false,
  });

  const signUpFlow = instanceSettings?.captchaFlows.signUp;
  const emailUnavailable = instanceSettings?.emailDelivery?.passwordSignUp === false;
  const captcha = useCaptcha(signUpFlow, {
    active: !state.attempt && !emailUnavailable && flowNeedsCaptcha(signUpFlow),
  });

  const create = useCallback(
    (values: Record<string, string>, consent: boolean) => {
      void (async () => {
        setState((current) => ({ ...current, busy: true, errors: [] }));
        const { email = '', password = '', ...rest } = values;
        // Drop blank optional fields so the server never sees empty strings.
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(rest)) if (value) fields[key] = value;

        const token = await captcha.getToken();
        let next: FlowState = await startSignUp(client, {
          email,
          password,
          fields,
          consent,
          captchaToken: token ?? undefined,
        });
        const localized = localizeCaptchaErrors(next.errors, t);
        next = { ...next, errors: localized.errors };
        // The token was spent either way; a refused create needs a fresh one.
        if (next.errors.length > 0 && captcha.needed) captcha.reset();
        await finish(next);
      })();
    },
    [captcha, client, finish, setState, t],
  );

  if (state.attempt) {
    return (
      <AttemptFlow
        attempt={state.attempt}
        busy={state.busy}
        errors={state.errors}
        titleKey="signUp.title"
        hideTitle={props.hideTitle}
        onSubmit={submit}
      />
    );
  }

  if (emailUnavailable) return <SignUpEmailUnavailable hideTitle={props.hideTitle} />;

  return (
    <SignUpForm
      settings={instanceSettings}
      busy={state.busy}
      errors={state.errors}
      hideTitle={props.hideTitle}
      captcha={captcha}
      onSubmit={create}
    />
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
  onSubmit,
}: {
  settings: InstanceSettings | null;
  busy: boolean;
  errors: FieldError[];
  hideTitle?: boolean;
  captcha: CaptchaController;
  onSubmit(values: Record<string, string>, consent: boolean): void;
}) {
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const cls = useClasses();

  const [values, setValues] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  const legal = settings?.legal;
  const showLegal = !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
  const consentOk = !legal?.required || agreed;

  const fieldErrors = (name: string) =>
    errors
      .filter((error) => error.param === name)
      .map((error) => (
        <span key={error.code} className={errorClass}>
          {error.message}
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

  const textField = (name: string, labelKey: string, type: string, autoComplete: string) => (
    <label key={name} className={cls('formField', 'atlas-field')}>
      <span className={cls('formFieldLabel', 'atlas-field-label')}>{t(labelKey)}</span>
      <input
        className={inputClass}
        type={type}
        name={name}
        autoComplete={autoComplete}
        required
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
            {error.message}
          </p>
        ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!consentOk) return;
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
        {textField('email', 'signUp.emailLabel', 'email', 'email')}
        {textField('password', 'signUp.passwordLabel', 'password', 'new-password')}

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

        <CaptchaSlot controller={captcha} />

        <button className={buttonClass} disabled={busy || !consentOk} type="submit">
          {t('signUp.submit')}
        </button>
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
  const { publishableKey, frontendApi, reload } = useAtlas();
  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi }),
    [frontendApi, publishableKey],
  );
  const create = useCallback(
    async (input: {
      email: string;
      password: string;
      fields?: Record<string, string>;
      consent?: boolean;
      captchaToken?: string;
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
