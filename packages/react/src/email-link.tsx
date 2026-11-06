'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createEmailLinkConfirmation, emailLinkFromUrl, type EmailLink } from '@atlasauth/js';
import { useClass, useClasses, useErrorText, useFapiClient, useText } from './components-shared';

const neverChanges = () => () => {};

/** The mailed link this page was opened with, if any. Null on the server, so hydration matches. */
export function useEmailLink(flow: 'sign_in' | 'sign_up'): EmailLink | null {
  const href = useSyncExternalStore(neverChanges, () => window.location.href, () => null);
  return useMemo(() => (href ? emailLinkFromUrl(href, flow) : null), [href, flow]);
}

/**
 * What `<SignIn>` / `<SignUp>` draw when opened from a mailed link: tries this
 * browser's stored secret, then asks for the code the starting tab shows. A
 * success signs nobody in here: the starting tab continues on its own.
 */
export function EmailLinkPage({ link, hideTitle }: { link: EmailLink; hideTitle?: boolean | undefined }) {
  const client = useFapiClient();
  const t = useText();
  const errorText = useErrorText();
  const cls = useClasses();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const controller = useMemo(() => createEmailLinkConfirmation(client, link), [client, link]);
  const [state, setState] = useState(controller.state);
  const [code, setCode] = useState('');
  useEffect(() => {
    setState(controller.state);
    const stop = controller.subscribe(setState);
    void controller.start();
    return stop;
  }, [controller]);
  return (
    <div className={cardClass} data-atlas="email-link" data-atlas-status={state.status}>
      {hideTitle ? null : <h1 className={titleClass}>{t('link.title')}</h1>}
      {state.status === 'needs_code' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void controller.submitCode(code);
          }}
        >
          <p className={cls('text', 'atlas-text')}>{t('link.enterCodeHelp')}</p>
          <label className={cls('formField', 'atlas-field')}>
            <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('link.codeLabel')}</span>
            <input
              className={inputClass}
              type="text"
              name="match_code"
              autoComplete="off"
              inputMode="numeric"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {state.errors.map((error) => (
            <p key={error.code} className={errorClass} role="alert">
              {errorText(error)}
            </p>
          ))}
          <button type="submit" className={buttonClass} disabled={state.busy}>
            {t('link.confirm')}
          </button>
        </form>
      ) : (
        <p className={cls('text', 'atlas-text')} role="status" aria-live="polite">
          {t(state.status === 'confirmed' ? 'link.confirmed' : state.status === 'invalid' ? 'link.invalid' : 'link.checking')}
        </p>
      )}
      {state.resetUrl ? (
        <p className={cls('text', 'atlas-text')}>
          <a className={cls('link', 'atlas-link')} data-atlas-reset-link="" href={state.resetUrl}>
            {t('signIn.forgotPassword')}
          </a>
        </p>
      ) : null}
    </div>
  );
}
