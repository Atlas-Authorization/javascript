'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  addPhoneNumber,
  clearCibaPin,
  decideCibaRequest,
  getCibaPin,
  listCibaRequests,
  setCibaPin,
  type CibaPinStatus,
  type CibaRequest,
  attemptPhoneNumberVerification,
  createPasskey,
  dismissPasskeyPrompt,
  passkeyPromptDue,
  reportPasskeyPromptEvent,
  type PasskeyPromptDecision,
  type PasskeyExtensionResults,
  type PasskeyPrfRequest,
  listPhoneNumbers,
  passkeysSupported,
  preparePhoneNumberVerification,
  removePhoneNumber,
  setPrimaryPhoneNumber,
  type UserPhoneNumber,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useUser } from './hooks';
import { collectByType, useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';
import { ReverificationPrompt, isReverificationCancelled, useReverification } from './reverification';
import { ManageMoreFactors, ManageSecurityQuestions } from './account-factors';

interface DeviceSession {
  id: string;
  current: boolean;
  last_active_at: number;
  device_label?: string | null;
  browser?: string | null;
  os?: string | null;
  location?: string | null;
}

/**
 * §2 The signed-in user's active devices, with per-device and "sign out everyone
 * else" revocation. A drop-in for a settings page — the composable half of the
 * post-login account surface an integrator needs the moment login is Atlas.
 */
export function ActiveSessions() {
  const client = useMeClient();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await client.get<{ data?: DeviceSession[] }>('/v1/client/sessions');
    setSessions(res.data?.data ?? []);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      await client.post(`/v1/client/sessions/${id}/revoke`).catch(() => undefined);
      await load();
      setBusy(false);
    },
    [client, load],
  );
  const revokeOthers = useCallback(async () => {
    setBusy(true);
    await client.post('/v1/client/sessions/revoke_all').catch(() => undefined);
    await load();
    setBusy(false);
  }, [client, load]);

  const fmt = (ms: number) => new Date(ms).toLocaleString();

  return (
    <section className={cardClass} data-atlas="active-sessions">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Active devices</h2>
      <ul className={cls('list', 'atlas-list')}>
        {sessions.map((s) => (
          <li className={cls('listItem', 'atlas-list-item')} key={s.id}>
            <strong>{s.device_label ?? [s.browser, s.os].filter(Boolean).join(' on ') ?? 'Unknown device'}</strong>
            {s.current ? <em> — this device</em> : null}
            <div>{[s.location, fmt(s.last_active_at)].filter(Boolean).join(' · ')}</div>
            {!s.current ? (
              <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void revoke(s.id)}>
                Sign out
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {sessions.some((s) => !s.current) ? (
        <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void revokeOthers()}>
          Sign out of all other devices
        </button>
      ) : null}
    </section>
  );
}

/**
 * Sign-in requests apps start on the user's behalf (CIBA), with approve and deny, and the optional CIBA PIN apps
 * must send as the user code. Renders nothing when there is no request, no PIN and no app that could ask.
 */
export function ManageCiba() {
  const client = useMeClient();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const button = cls('formButtonSecondary', 'atlas-button-secondary');
  const [requests, setRequests] = useState<CibaRequest[]>([]);
  const [pin, setPin] = useState<CibaPinStatus | null>(null);
  const [newPin, setNewPin] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([listCibaRequests(client).catch(() => []), getCibaPin(client).catch(() => null)]);
    setRequests(r);
    setPin(p);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setMessage(null);
    try {
      await fn();
      setNewPin('');
      setPassword('');
      await load();
    } catch (e) {
      setMessage(e instanceof Error && e.message ? e.message : fallback);
    }
  };

  if (!requests.length && !(pin && (pin.set || pin.available))) return null;
  return (
    <section className={cardClass} data-atlas="manage-ciba">
      {requests.length ? (
        <>
          <h2 className={cls('sectionTitle', 'atlas-section-title')}>Sign-in requests from apps</h2>
          <ul className={cls('list', 'atlas-list')}>
            {requests.map((r) => (
              <li className={cls('listItem', 'atlas-list-item')} key={r.id}>
                <strong>{r.client_name}</strong>
                {r.binding_message ? <div>{r.binding_message}</div> : null}
                <small>{r.scope.join(', ')}</small>
                <button className={button} type="button" onClick={() => void run(() => decideCibaRequest(client, r.id, 'approve'), 'Could not approve.')}>
                  Approve
                </button>
                <button className={button} type="button" onClick={() => void run(() => decideCibaRequest(client, r.id, 'deny'), 'Could not deny.')}>
                  Deny
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pin && (pin.set || pin.available) ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => setCibaPin(client, { pin: newPin, currentPassword: password }), 'Could not save the PIN.');
          }}
        >
          <h2 className={cls('sectionTitle', 'atlas-section-title')}>CIBA PIN</h2>
          <p>{pin.set ? 'You have a CIBA PIN.' : 'You have not set a CIBA PIN.'} Apps that start a sign-in request for you must send it.</p>
          <input type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input type="password" inputMode="numeric" autoComplete="off" placeholder="6 to 12 digits" aria-label="New CIBA PIN" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
          <button className={button} type="submit">{pin.set ? 'Change PIN' : 'Set PIN'}</button>
          {pin.set ? (
            <button className={button} type="button" onClick={() => void run(() => clearCibaPin(client, { currentPassword: password }), 'Could not remove the PIN.')}>
              Remove PIN
            </button>
          ) : null}
          {message ? <small role="status">{message}</small> : null}
        </form>
      ) : message ? (
        <small role="status">{message}</small>
      ) : null}
    </section>
  );
}

/**
 * §2 The signed-in user's profile — name (editable) and email addresses. Another
 * composable piece of the account surface; writes go to `PATCH /v1/client/me` and
 * re-boot the provider so the rest of the app sees the change.
 */
export function ProfileCard() {
  const { user } = useUser();
  const { reload } = useAtlas();
  const client = useMeClient();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);
  // An unverified address (one added and never confirmed, or the sign-up
  // address on an app that did not require verification) can be proven here:
  // send a code, then enter it.
  const [verifying, setVerifying] = useState<string | null>(null);
  const [confirmingPrimary, setConfirmingPrimary] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    setFirstName(user?.first_name ?? '');
    setLastName(user?.last_name ?? '');
  }, [user?.first_name, user?.last_name]);

  if (!user) return null;

  const save = async () => {
    setSaving(true);
    await client
      .request('/v1/client/me', {
        method: 'PATCH',
        body: JSON.stringify({ first_name: firstName, last_name: lastName }),
      })
      .catch(() => undefined);
    await reload();
    setSaving(false);
  };

  const sendCode = async (id: string) => {
    setVerifyError(null);
    setSaving(true);
    const res = await client.post(`/v1/client/me/email_addresses/${id}/prepare_verification`);
    setSaving(false);
    if (!res.ok) {
      setVerifyError('We could not send a code right now. Try again in a minute.');
      return;
    }
    setCode('');
    setVerifying(id);
  };

  const confirmCode = async () => {
    if (!verifying) return;
    setVerifyError(null);
    setSaving(true);
    const res = await client.post(`/v1/client/me/email_addresses/${verifying}/attempt_verification`, { code });
    setSaving(false);
    if (!res.ok) {
      setVerifyError('That code was not accepted.');
      return;
    }
    setVerifying(null);
    await reload();
  };

  const makePrimary = async (id: string) => {
    setVerifyError(null);
    setSaving(true);
    const res = await client.post<{ status?: string }>(`/v1/client/me/email_addresses/${id}/primary`);
    setSaving(false);
    if (!res.ok) {
      setVerifyError('We could not change your primary email right now.');
      return;
    }
    if (res.data?.status === 'pending_old_address_confirmation') {
      setCode('');
      setConfirmingPrimary(id);
      return;
    }
    await reload();
  };

  const confirmPrimary = async () => {
    if (!confirmingPrimary) return;
    setVerifyError(null);
    setSaving(true);
    const res = await client.post(`/v1/client/me/email_addresses/${confirmingPrimary}/confirm_primary`, { code });
    setSaving(false);
    if (!res.ok) {
      setVerifyError('That code was not accepted.');
      return;
    }
    setConfirmingPrimary(null);
    await reload();
  };

  return (
    <section className={cardClass} data-atlas="profile-card">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Profile</h2>
      <label className={cls('formField', 'atlas-account-field')}>
        First name
        <input className={cls('formFieldInput', 'atlas-account-input')} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      </label>
      <label className={cls('formField', 'atlas-account-field')}>
        Last name
        <input className={cls('formFieldInput', 'atlas-account-input')} value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </label>
      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={saving} onClick={() => void save()}>
        Save
      </button>
      <ul className={cls('list', 'atlas-list')} data-atlas="emails">
        {(user.email_addresses ?? []).map((email) => (
          <li className={cls('listItem', 'atlas-list-item')} key={email.id}>
            {email.email_address}
            {email.verified ? null : <em> — unverified</em>}
            {email.primary ? <em> — primary</em> : null}
            {email.verified && !email.primary ? (
              confirmingPrimary === email.id ? (
                <span data-atlas="email-primary-confirm">
                  <input
                    className={cls('formFieldInput', 'atlas-account-input')}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="Code sent to your current email"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={saving} onClick={() => void confirmPrimary()}>
                    Confirm
                  </button>
                </span>
              ) : (
                <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={saving} onClick={() => void makePrimary(email.id)}>
                  Make primary
                </button>
              )
            ) : null}
            {email.verified ? null : verifying === email.id ? (
              <span data-atlas="email-verify">
                <input
                  className={cls('formFieldInput', 'atlas-account-input')}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Code from the email"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={saving} onClick={() => void confirmCode()}>
                  Confirm
                </button>
              </span>
            ) : (
              <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={saving} onClick={() => void sendCode(email.id)}>
                Verify
              </button>
            )}
          </li>
        ))}
      </ul>
      {verifyError ? <p className={cls('text', 'atlas-text')} role="alert">{verifyError}</p> : null}
    </section>
  );
}

interface MfaFactor {
  id: string;
  type: string;
  verified: boolean;
}

/**
 * §2 Manage two-factor authentication (authenticator app / TOTP). The full
 * enrollment ceremony — start (secret + otpauth URI), verify with a live code,
 * then the one-time backup codes — plus turn-off, in one composable drop-in, so a
 * team never rebuilds the FAPI dance to put 2FA in their own settings page. The
 * secret + `otpauth://` URI are shown for scan-or-manual entry (render a QR from
 * the URI if you like — kept dependency-free here).
 */
export function ManageMfa() {
  const client = useMeClient();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; secret: string; uri: string; requiredCodes: number } | null>(
    null,
  );
  const [codes, setCodes] = useState<string[]>([]);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Turning 2FA off (and, when the app enabled it, turning it on) needs a recent
  // sign-in; a stale session parks the call behind the "Confirm it's you" prompt.
  const reverification = useReverification();

  const load = useCallback(async () => {
    const res = await client.get<{ data?: MfaFactor[]; backup_codes_remaining?: number }>(
      '/v1/client/me/mfa',
    );
    setFactors(res.data?.data ?? []);
    setRemaining(res.data?.backup_codes_remaining ?? null);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const totp = factors.find((f) => f.type === 'totp' && f.verified);

  const startEnroll = async () => {
    setError(null);
    setBackupCodes(null);
    setBusy(true);
    let res;
    try {
      res = await reverification.withReverification(() =>
        client.post<{ id: string; secret: string; uri: string; required_codes: number }>('/v1/client/me/mfa/totp'),
      );
    } catch (err) {
      setBusy(false);
      if (!isReverificationCancelled(err)) setError('Could not start enrollment.');
      return;
    }
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.errors[0] ? errorText(res.errors[0]) : 'Could not start enrollment.');
      return;
    }
    const required = res.data.required_codes || 1;
    setEnroll({ id: res.data.id, secret: res.data.secret, uri: res.data.uri, requiredCodes: required });
    setCodes(Array.from({ length: required }, () => ''));
  };

  const verify = async () => {
    if (!enroll) return;
    setError(null);
    setBusy(true);
    const res = await client.post<{ backup_codes?: string[] }>(
      `/v1/client/me/mfa/totp/${enroll.id}/verify`,
      { codes },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.errors[0] ? errorText(res.errors[0]) : 'That code was not accepted.');
      return;
    }
    setBackupCodes(res.data?.backup_codes ?? []);
    setEnroll(null);
    await load();
  };

  const disable = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await reverification.withReverification(() =>
        client.request(`/v1/client/me/mfa/${id}`, { method: 'DELETE' }),
      );
      if (!res.ok) setError(res.errors[0] ? errorText(res.errors[0]) : 'Could not turn off two-factor.');
    } catch (err) {
      if (!isReverificationCancelled(err)) setError('Could not turn off two-factor.');
    }
    await load();
    setBusy(false);
  };

  return (
    <section className={cardClass} data-atlas="manage-mfa">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Two-factor authentication</h2>
      {totp ? (
        <>
          <p className={cls('text', 'atlas-text')}>
            Authenticator app is on.
            {remaining != null ? ` ${remaining} backup codes remaining.` : ''}
          </p>
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void disable(totp.id)}>
            Turn off
          </button>
        </>
      ) : enroll ? (
        <div>
          <p className={cls('text', 'atlas-text')}>Add this to your authenticator app — scan the QR you render from the URI, or enter the key:</p>
          <code data-atlas="totp-secret">{enroll.secret}</code>
          <p className={cls('text', 'atlas-text')}>
            <a className={cls('link', 'atlas-link')} href={enroll.uri}>Open in an authenticator app</a>
          </p>
          {codes.map((c, i) => (
            <input className={cls('formFieldInput', 'atlas-account-input')}
              key={i}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={c}
              placeholder={enroll.requiredCodes > 1 ? `Code ${i + 1}` : 'Enter the code from your app'}
              onChange={(e) => setCodes((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          ))}
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void verify()}>
            Verify &amp; enable
          </button>
        </div>
      ) : backupCodes ? (
        <div>
          <p className={cls('text', 'atlas-text')}>Two-factor is on. Save these backup codes now — they are shown only once:</p>
          <ul className={cls('list', 'atlas-list')} data-atlas="backup-codes">
            {backupCodes.map((c) => (
              <li className={cls('listItem', 'atlas-list-item')} key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void startEnroll()}>
          Enable authenticator app
        </button>
      )}
      <ManageMoreFactors onChanged={() => void load()} />
      <ReverificationPrompt reverification={reverification} name="mfa-reverification" />
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="mfa-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface Passkey {
  id: string;
  name?: string | null;
  last_used_at?: number | null;
  created_at: number;
}

/**
 * §2 Manage passkeys (WebAuthn). Lists the user's registered credentials and runs
 * the full add ceremony — `POST /passkeys/begin` → `navigator.credentials.create`
 * (via the SDK's {@link createPasskey}) → `POST /passkeys/finish` — plus rename-free
 * removal, in one composable drop-in. Nothing renders the "Add" affordance when the
 * runtime has no WebAuthn support, so it degrades cleanly on older browsers.
 */
export interface ManagePasskeysProps {
  /**
   * Request the WebAuthn `prf` extension when a passkey is added: a secret
   * derived from the passkey and your salt, for client-side encryption keys. It
   * never reaches Atlas.
   */
  prf?: PasskeyPrfRequest;
  /** Receives the new passkey's client extension results (PRF support and outputs). */
  onExtensionResults?: (results: PasskeyExtensionResults) => void;
}

export function ManagePasskeys({ prf, onExtensionResults }: ManagePasskeysProps = {}) {
  const client = useMeClient();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = passkeysSupported();
  // Adding or removing a passkey needs a recent sign-in (STEP_UP_REQUIRED otherwise).
  const reverification = useReverification();

  const load = useCallback(async () => {
    const res = await client.get<{ data?: Passkey[] }>('/v1/client/me/passkeys');
    setPasskeys(res.data?.data ?? []);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const begin = await reverification.withReverification(() =>
        client.post<Record<string, unknown>>('/v1/client/me/passkeys/begin'),
      );
      if (!begin.ok || !begin.data) {
        setError(begin.errors[0] ? errorText(begin.errors[0]) : 'Could not start passkey setup.');
        return;
      }
      const body = await createPasskey(begin.data, {
        name: name.trim() || undefined,
        ...(prf ? { prf } : {}),
        ...(onExtensionResults ? { onExtensionResults } : {}),
      });
      const finish = await client.post('/v1/client/me/passkeys/finish', body);
      if (!finish.ok) {
        setError(finish.errors[0] ? errorText(finish.errors[0]) : 'Could not save the passkey.');
        return;
      }
      setName('');
      await load();
    } catch {
      // A cancelled or timed-out WebAuthn prompt throws — treat as a no-op, not an error banner.
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await reverification.withReverification(() =>
        client.request(`/v1/client/me/passkeys/${id}`, { method: 'DELETE' }),
      );
      if (!res.ok) setError(res.errors[0] ? errorText(res.errors[0]) : 'Could not remove the passkey.');
    } catch (err) {
      if (!isReverificationCancelled(err)) setError('Could not remove the passkey.');
    }
    await load();
    setBusy(false);
  };

  const fmt = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString() : null);

  return (
    <section className={cardClass} data-atlas="manage-passkeys">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Passkeys</h2>
      <ul className={cls('list', 'atlas-list')} data-atlas="passkey-list">
        {passkeys.map((pk) => (
          <li className={cls('listItem', 'atlas-list-item')} key={pk.id}>
            <strong>{pk.name || 'Passkey'}</strong>
            <div>
              {[pk.last_used_at ? `Last used ${fmt(pk.last_used_at)}` : `Added ${fmt(pk.created_at)}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void remove(pk.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {supported ? (
        <div data-atlas="passkey-add">
          <input className={cls('formFieldInput', 'atlas-account-input')}
            value={name}
            placeholder="Name this device (optional)"
            onChange={(e) => setName(e.target.value)}
          />
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void add()}>
            Add a passkey
          </button>
        </div>
      ) : (
        <p className={cls('text', 'atlas-text')}>Passkeys are not supported in this browser.</p>
      )}
      <ReverificationPrompt reverification={reverification} name="passkey-reverification" />
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="passkey-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Manage phone numbers: add one (a code is texted to it), verify it, pick the
 * primary, remove one. Adding, re-pointing the primary and removing need a recent
 * sign-in; a stale session gets the "Confirm it's you" prompt and the action
 * retries once the user re-authenticates.
 */
export function ManagePhoneNumbers() {
  const client = useMeClient();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const reverification = useReverification();
  const [phones, setPhones] = useState<UserPhoneNumber[]>([]);
  const [draft, setDraft] = useState('');
  const [verifying, setVerifying] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPhones(await listPhoneNumbers(client));
    } catch {
      setPhones([]);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await reverification.withReverification(action);
      return true;
    } catch (err) {
      if (!isReverificationCancelled(err)) setError(err instanceof Error ? errorText(err) : fallback);
      return false;
    } finally {
      setBusy(false);
      await load();
    }
  };

  const add = async () => {
    const value = draft.trim();
    if (!value) return;
    let added: UserPhoneNumber | undefined;
    const ok = await run(async () => {
      added = await addPhoneNumber(client, value);
    }, 'Could not add that number.');
    if (ok && added) {
      setDraft('');
      setCode('');
      setVerifying(added.id);
    }
  };

  const confirm = async () => {
    if (!verifying) return;
    const ok = await run(() => attemptPhoneNumberVerification(client, verifying, code), 'That code was not accepted.');
    if (ok) setVerifying(null);
  };

  return (
    <section className={cardClass} data-atlas="manage-phone-numbers">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Phone numbers</h2>
      <ul className={cls('list', 'atlas-list')} data-atlas="phone-list">
        {phones.map((phone) => (
          <li className={cls('listItem', 'atlas-list-item')} key={phone.id}>
            {phone.phone_number}
            {phone.verified ? null : <em> — unverified</em>}
            {phone.primary ? <em> — primary</em> : null}
            {phone.verified ? null : verifying === phone.id ? (
              <span data-atlas="phone-verify">
                <input
                  className={cls('formFieldInput', 'atlas-account-input')}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Code from the text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void confirm()}>
                  Confirm
                </button>
              </span>
            ) : (
              <button
                className={cls('formButtonSecondary', 'atlas-button-secondary')}
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => preparePhoneNumberVerification(client, phone.id), 'Could not send a code.').then(
                    (ok) => {
                      if (ok) {
                        setCode('');
                        setVerifying(phone.id);
                      }
                    },
                  )
                }
              >
                Verify
              </button>
            )}
            {phone.verified && !phone.primary ? (
              <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void run(() => setPrimaryPhoneNumber(client, phone.id), 'Could not change the primary number.')}>
                Make primary
              </button>
            ) : null}
            <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void run(() => removePhoneNumber(client, phone.id), 'Could not remove that number.')}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div data-atlas="phone-add">
        <input
          className={cls('formFieldInput', 'atlas-account-input')}
          type="tel"
          autoComplete="tel"
          placeholder="+15551234567"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void add()}>
          Add phone number
        </button>
      </div>
      <ReverificationPrompt reverification={reverification} name="phone-reverification" />
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="phone-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * §2 The drop-in post-login account surface. Composes the account-management
 * pieces (profile, 2FA, passkeys, devices). Each piece is also exported on its own
 * (`<ProfileCard/>`, `<ManageMfa/>`, `<ManagePasskeys/>`, `<ActiveSessions/>`) so a
 * team can drop just one into their existing settings page.
 */
/**
 * §L3 extension API (Clerk `<UserProfile.Page>` / `<UserProfile.Link>`): add
 * your own tab of content, or an external link, into the prebuilt profile. Both
 * are descriptor components — `<UserProfile>` reads them from its children.
 */
export interface ProfilePageProps {
  /** The tab's label. */
  label: ReactNode;
  labelIcon?: ReactNode;
  /** The tab's body. */
  children?: ReactNode;
}
export interface ProfileLinkProps {
  label: ReactNode;
  labelIcon?: ReactNode;
  /** Where the tab navigates instead of showing content. */
  url: string;
}
/** A custom content tab inside `<UserProfile>`. Renders nothing on its own. */
function UserProfilePage(_props: ProfilePageProps): null {
  return null;
}
/** A custom external-link tab inside `<UserProfile>`. Renders nothing on its own. */
function UserProfileLink(_props: ProfileLinkProps): null {
  return null;
}

export function UserProfile({ children }: { children?: ReactNode } = {}) {
  const { user } = useUser();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const tabClass = cls('tab', useClass('menuItem', 'atlas-tab'));

  const pages = useMemo(
    () =>
      collectByType<ProfilePageProps>(children, (el) =>
        el.type === UserProfilePage ? (el.props as ProfilePageProps) : undefined,
      ),
    [children],
  );
  const links = useMemo(
    () =>
      collectByType<ProfileLinkProps>(children, (el) =>
        el.type === UserProfileLink ? (el.props as ProfileLinkProps) : undefined,
      ),
    [children],
  );

  // 0 = the built-in account page; 1..N = custom pages.
  const [tab, setTab] = useState(0);

  if (!user) return null;

  return (
    <div className={cardClass} data-atlas="user-profile">
      <h1 className={cls('headerTitle', 'atlas-heading')}>{t('userProfile.title')}</h1>

      {pages.length || links.length ? (
        <nav className={cls('tabs', 'atlas-tabs')} role="tablist">
          <button
            className={tabClass}
            role="tab"
            aria-selected={tab === 0}
            onClick={() => setTab(0)}
          >
            {t('userProfile.title')}
          </button>
          {pages.map((p, i) => (
            <button
              key={`p${i}`}
              className={tabClass}
              role="tab"
              aria-selected={tab === i + 1}
              onClick={() => setTab(i + 1)}
            >
              {p.labelIcon}
              {p.label}
            </button>
          ))}
          {links.map((l, i) => (
            <a key={`l${i}`} className={tabClass} href={l.url}>
              {l.labelIcon}
              {l.label}
            </a>
          ))}
        </nav>
      ) : null}

      {tab === 0 ? (
        <div data-atlas="user-profile-account" role="tabpanel">
          <ProfileCard />
          <ManagePhoneNumbers />
          <ManageMfa />
          <ManageSecurityQuestions />
          <ManagePasskeys />
          <ManageCiba />
          <ActiveSessions />
        </div>
      ) : (
        <div data-atlas="user-profile-custom" role="tabpanel">
          {pages[tab - 1]?.children}
        </div>
      )}
    </div>
  );
}
UserProfile.Page = UserProfilePage;
UserProfile.Link = UserProfileLink;

/**
 * Post-sign-in "add a passkey" nudge. Renders nothing unless the instance's
 * rollout says this user should see it (`accountUx.passkeyAdoption`) and the
 * per-device cooldown has passed. "Add a passkey" runs the add ceremony;
 * dismissing starts the cooldown. `onDecision` receives the rollout variant tag
 * so the app can attach it to its own analytics.
 */
export function PasskeyPrompt({ onDecision, onAdded }: { onDecision?: (d: PasskeyPromptDecision) => void; onAdded?: () => void } = {}) {
  const client = useMeClient();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!passkeysSupported()) return;
    void (async () => {
      const res = await client.get<PasskeyPromptDecision>('/v1/client/me/passkeys/prompt');
      if (!res.ok || !res.data) return;
      onDecision?.(res.data);
      const due = passkeyPromptDue(res.data);
      setShow(due);
      if (due) void reportPasskeyPromptEvent(client, 'shown');
    })();
  }, [client]);

  if (!show) return null;
  const add = async () => {
    setBusy(true);
    try {
      const begin = await client.post<Record<string, unknown>>('/v1/client/me/passkeys/begin');
      if (!begin.ok || !begin.data) return;
      const finish = await client.post('/v1/client/me/passkeys/finish', await createPasskey(begin.data));
      if (finish.ok) {
        void reportPasskeyPromptEvent(client, 'accepted');
        setShow(false);
        onAdded?.();
      }
    } catch {
      // A cancelled WebAuthn prompt is not an error.
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    void reportPasskeyPromptEvent(client, 'dismissed');
    dismissPasskeyPrompt();
    setShow(false);
  };
  return (
    <section className={cardClass} data-atlas="passkey-prompt">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>Sign in faster with a passkey</h2>
      <button className={cls('formButtonPrimary', 'atlas-button')} type="button" disabled={busy} onClick={() => void add()}>
        Add a passkey
      </button>
      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={dismiss}>
        Not now
      </button>
    </section>
  );
}
