'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceAuthorizationError,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  formatUserCode,
  lookupDeviceAuthorization,
  userCodeFromUrl,
  type DeviceAuthorization as DeviceAuthorizationRecord,
} from '@atlasauth/js';
import { isReverificationCancelled, useReverification } from './reverification';
import { useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';

/**
 * Device sign-in (RFC 8628) on YOUR page: the signed-in user enters the code
 * their TV / console / CLI shows, sees which app is asking for what, and allows
 * or denies it — instead of being sent to the hosted `/oauth2/device` page.
 *
 * `useDeviceAuthorization()` is the headless half (look up, approve, deny), with
 * the step-up wired in: when the application requires a recent re-authentication
 * to approve a device, a stale session parks the approval and flips
 * `reverification.needsReverification`; `completeReverification(...)` finishes it.
 * `<DeviceAuthorization/>` is the drop-in UI built on it. It reads a
 * `?user_code=` from the page URL, so it works as the verification URI too.
 */

export type DeviceAuthorizationStatus = 'idle' | 'busy' | 'review' | 'approved' | 'denied' | 'error';

export interface UseDeviceAuthorizationResult {
  status: DeviceAuthorizationStatus;
  /** The device sign-in being reviewed, after a successful lookup. */
  authorization: DeviceAuthorizationRecord | null;
  error: string | null;
  lookup(userCode: string): Promise<DeviceAuthorizationRecord | null>;
  approve(): Promise<void>;
  deny(): Promise<void>;
  /** Back to entering a code. */
  reset(): void;
  reverification: ReturnType<typeof useReverification>;
}

export function useDeviceAuthorization(): UseDeviceAuthorizationResult {
  const client = useMeClient();
  const errorText = useErrorText();
  const t = useText();
  const reverification = useReverification();
  const { withReverification } = reverification;
  const [status, setStatus] = useState<DeviceAuthorizationStatus>('idle');
  const [authorization, setAuthorization] = useState<DeviceAuthorizationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (isReverificationCancelled(err)) {
        setStatus('review');
        return;
      }
      setStatus('error');
      setError(
        err instanceof DeviceAuthorizationError && err.isInvalidCode
          ? t('deviceAuth.invalidCode')
          : err instanceof Error
            ? errorText(err)
            : t('error.generic'),
      );
    },
    [errorText, t],
  );

  const lookup = useCallback(
    async (userCode: string) => {
      setStatus('busy');
      setError(null);
      try {
        const found = await lookupDeviceAuthorization(client, userCode);
        setAuthorization(found);
        setStatus('review');
        return found;
      } catch (err) {
        setAuthorization(null);
        fail(err);
        return null;
      }
    },
    [client, fail],
  );

  const approve = useCallback(async () => {
    if (!authorization) return;
    setStatus('busy');
    setError(null);
    try {
      const done = await withReverification(() => approveDeviceAuthorization(client, authorization));
      setAuthorization(done);
      setStatus('approved');
    } catch (err) {
      fail(err);
    }
  }, [authorization, client, fail, withReverification]);

  const deny = useCallback(async () => {
    if (!authorization) return;
    setStatus('busy');
    setError(null);
    try {
      const done = await denyDeviceAuthorization(client, authorization);
      setAuthorization(done);
      setStatus('denied');
    } catch (err) {
      fail(err);
    }
  }, [authorization, client, fail]);

  const reset = useCallback(() => {
    setAuthorization(null);
    setError(null);
    setStatus('idle');
  }, []);

  return { status, authorization, error, lookup, approve, deny, reset, reverification };
}

export interface DeviceAuthorizationProps {
  /** Start with this code (otherwise `?user_code=` on the page URL, if present). */
  userCode?: string;
  /** Called once the device sign-in is approved. */
  onApproved?: (authorization: DeviceAuthorizationRecord) => void;
  /** Called once it is denied. */
  onDenied?: (authorization: DeviceAuthorizationRecord) => void;
}

/**
 * Drop-in device approval: a code field, then the app's name, the access it
 * asks for and the code to compare against the device, with Allow / Deny — and
 * the "confirm it's you" prompt when the application requires it.
 */
export function DeviceAuthorization(props: DeviceAuthorizationProps) {
  const api = useDeviceAuthorization();
  const t = useText();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [code, setCode] = useState(props.userCode ?? '');
  const [password, setPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const { lookup } = api;

  // A code passed in, or on the verification URL the device showed, is looked up
  // straight away — once per distinct code.
  const lookedUp = useRef<string | null>(null);
  useEffect(() => {
    const initial =
      props.userCode ?? (typeof window !== 'undefined' ? userCodeFromUrl(window.location.href) : null);
    if (initial && lookedUp.current !== initial) {
      lookedUp.current = initial;
      setCode(formatUserCode(initial));
      void lookup(initial);
    }
  }, [props.userCode, lookup]);

  // The latest callbacks, so the effect below fires once per transition only.
  const callbacks = useRef({ onApproved: props.onApproved, onDenied: props.onDenied });
  callbacks.current = { onApproved: props.onApproved, onDenied: props.onDenied };
  const { status, authorization } = api;
  useEffect(() => {
    if (status === 'approved' && authorization) callbacks.current.onApproved?.(authorization);
    if (status === 'denied' && authorization) callbacks.current.onDenied?.(authorization);
  }, [status, authorization]);

  const confirmIdentity = async () => {
    setReauthError(null);
    try {
      await api.reverification.completeReverification({ strategy: 'password', password });
      setPassword('');
    } catch (err) {
      setReauthError(err instanceof Error ? errorText(err) : t('error.generic'));
    }
  };

  const auth = api.authorization;
  return (
    <section className={cardClass} data-atlas="device-authorization">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>{t('deviceAuth.title')}</h2>

      {api.status === 'approved' ? (
        <p className={cls('text', 'atlas-text')} role="status" data-atlas="device-authorization-approved">{t('deviceAuth.approved')}</p>
      ) : api.status === 'denied' ? (
        <p className={cls('text', 'atlas-text')} role="status" data-atlas="device-authorization-denied">{t('deviceAuth.denied')}</p>
      ) : auth && (api.status === 'review' || api.status === 'busy') ? (
        <div data-atlas="device-authorization-review">
          <p className={cls('text', 'atlas-text')}>
            {t('deviceAuth.request', { app: auth.client.name })}
          </p>
          {auth.scopes.length > 0 ? (
            <>
              <p className={cls('text', 'atlas-text')}>{t('deviceAuth.scopesTitle')}</p>
              <ul className={cls('list', 'atlas-list')} data-atlas="device-authorization-scopes">
                {auth.scopes.map((s) => (
                  <li className={cls('listItem', 'atlas-list-item')} key={s.scope}>{s.description}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p className={cls('text', 'atlas-text')} data-atlas="device-authorization-code">
            {t('deviceAuth.checkCode', { code: auth.userCode })}
          </p>
          {api.reverification.needsReverification ? (
            <div data-atlas="device-authorization-reverification" role="dialog" aria-label={t('reverification.title')}>
              <p className={cls('text', 'atlas-text')}><strong>{t('reverification.title')}</strong></p>
              <p className={cls('text', 'atlas-text')}>{t('reverification.subtitle')}</p>
              <label className={cls('formField', 'atlas-field')}>
                <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('reverification.passwordLabel')}</span>
                <input
                  className={cls('formFieldInput', 'atlas-account-input')}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {reauthError ? <p className={cls('formFieldError', 'atlas-error')} role="alert">{reauthError}</p> : null}
              <button className={cls('formButtonPrimary', 'atlas-button')} type="button" onClick={() => void confirmIdentity()}>
                {t('reverification.submit')}
              </button>
              <button
                className={cls('formButtonSecondary', 'atlas-button-secondary')}
                type="button"
                onClick={() => api.reverification.cancelReverification()}
              >
                {t('reverification.cancel')}
              </button>
            </div>
          ) : (
            <div>
              <button
                className={cls('formButtonPrimary', 'atlas-button')}
                type="button"
                disabled={api.status === 'busy'}
                onClick={() => void api.approve()}
              >
                {t('deviceAuth.approve')}
              </button>
              <button
                className={cls('formButtonSecondary', 'atlas-button-secondary')}
                type="button"
                disabled={api.status === 'busy'}
                onClick={() => void api.deny()}
              >
                {t('deviceAuth.deny')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <form
          data-atlas="device-authorization-entry"
          onSubmit={(e) => {
            e.preventDefault();
            void api.lookup(code);
          }}
        >
          <p className={cls('text', 'atlas-text')}>{t('deviceAuth.subtitle')}</p>
          <label className={cls('formField', 'atlas-field')}>
            <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('deviceAuth.codeLabel')}</span>
            <input
              className={cls('formFieldInput', 'atlas-account-input')}
              value={code}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX"
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {api.error ? <p className={cls('formFieldError', 'atlas-error')} role="alert">{api.error}</p> : null}
          <button className={cls('formButtonPrimary', 'atlas-button')} type="submit" disabled={api.status === 'busy' || !code.trim()}>
            {t('deviceAuth.continue')}
          </button>
        </form>
      )}

      {api.status === 'approved' || api.status === 'denied' || api.status === 'error' ? (
        <button
          className={cls('formButtonSecondary', 'atlas-button-secondary')}
          type="button"
          onClick={() => {
            setCode('');
            api.reset();
          }}
        >
          {t('deviceAuth.another')}
        </button>
      ) : null}
    </section>
  );
}
