'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  enrollYubikey,
  finishDuoEnrollment,
  getSecurityQuestions,
  removeSecurityQuestions,
  setSecurityQuestions,
  startDuoEnrollment,
  startHotp,
  verifyHotp,
  type FieldError,
  type SecurityQuestions,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';
import { ReverificationPrompt, isReverificationCancelled, useReverification } from './reverification';

interface Factor {
  id: string;
  type: string;
  verified: boolean;
  public_id?: string;
}

const LABEL_TYPES = ['hotp', 'yubikey', 'duo'];

type Pending =
  | { kind: 'hotp'; id: string; secret: string; uri: string; digits: number }
  | { kind: 'yubikey' }
  | { kind: 'duo'; id: string };

/**
 * More second factors for the signed-in user: a counter-based token (HOTP), a YubiKey (Yubico
 * OTP) and Duo, each shown only when the application turned it on. Rendered inside
 * `<ManageMfa/>`; it can also be used on its own.
 */
export function ManageMoreFactors({ onChanged }: { onChanged?: () => void } = {}) {
  const t = useText();
  const client = useMeClient();
  const errorText = useErrorText();
  const cls = useClasses();
  const inputClass = useClass('formFieldInput', 'atlas-account-input');
  const { instanceSettings } = useAtlas();
  const offered = instanceSettings?.account?.mfa;
  const reverification = useReverification();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await client.get<{ data?: Factor[] }>('/v1/client/me/mfa');
    setFactors((res.data?.data ?? []).filter((f) => f.verified && LABEL_TYPES.includes(f.type)));
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!offered?.hotp && !offered?.yubikey && !offered?.duo && factors.length === 0) return null;

  const fail = (res: { errors: FieldError[] }, fallback: string) =>
    setError(res.errors[0] ? errorText(res.errors[0]) : fallback);

  const finished = async (codes?: string[]) => {
    setPending(null);
    setInput('');
    if (codes?.length) setBackupCodes(codes);
    await load();
    onChanged?.();
  };

  /** Run a step-up-gated request; a cancelled re-verification is not an error. */
  const run = async <T,>(step: () => Promise<T>): Promise<T | null> => {
    setError(null);
    setBusy(true);
    try {
      return await reverification.withReverification(step);
    } catch (err) {
      if (!isReverificationCancelled(err)) setError(t('mfa.manageErrorGeneric'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const beginHotp = async () => {
    const res = await run(() => startHotp(client));
    if (!res) return;
    if (!res.ok || !res.data) return fail(res, t('mfa.manageErrorStart'));
    setPending({ kind: 'hotp', id: res.data.id, secret: res.data.secret, uri: res.data.uri, digits: res.data.digits });
  };
  const confirmHotp = async () => {
    if (pending?.kind !== 'hotp') return;
    const res = await run(() => verifyHotp(client, pending.id, input.trim()));
    if (!res) return;
    if (!res.ok) return fail(res, t('mfa.manageErrorCode'));
    await finished(res.data?.backup_codes);
  };
  const addYubikey = async () => {
    const res = await run(() => enrollYubikey(client, input.trim()));
    if (!res) return;
    if (!res.ok) return fail(res, t('mfa.manageErrorYubikey'));
    await finished(res.data?.backup_codes);
  };
  const beginDuo = async () => {
    // Open the window from the click, before the request resolves, so it is not blocked.
    const popup = typeof window !== 'undefined' ? window.open('', 'atlas_duo', 'width=480,height=720') : null;
    const res = await run(() => startDuoEnrollment(client));
    if (!res || !res.ok || !res.data) {
      popup?.close();
      if (res) fail(res, t('mfa.manageErrorDuoStart'));
      return;
    }
    if (popup) popup.location.href = res.data.authorization_url;
    else if (typeof window !== 'undefined') window.location.assign(res.data.authorization_url);
    setPending({ kind: 'duo', id: res.data.id });
  };
  const confirmDuo = async () => {
    if (pending?.kind !== 'duo') return;
    const res = await run(() => finishDuoEnrollment(client, pending.id));
    if (!res) return;
    if (!res.ok) return fail(res, t('mfa.manageErrorDuoPending'));
    await finished(res.data?.backup_codes);
  };
  const remove = async (id: string) => {
    const res = await run(() => client.request(`/v1/client/me/mfa/${id}`, { method: 'DELETE' }));
    if (res && !res.ok) fail(res, t('mfa.manageErrorRemove'));
    await finished();
  };

  const button = (label: string, onClick: () => void) => (
    <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={onClick}>
      {label}
    </button>
  );
  const labelFor = (type: string) => (type === 'hotp' ? t('mfa.manageHotpLabel') : type === 'yubikey' ? 'YubiKey' : 'Duo');
  const have = (type: string) => factors.some((f) => f.type === type);

  return (
    <div data-atlas="manage-more-factors">
      {factors.map((f) => (
        <p key={f.id} className={cls('text', 'atlas-text')}>
          {t('mfa.manageIsOn', { name: `${labelFor(f.type)}${f.public_id ? ` (${f.public_id})` : ''}` })} {button(t('mfa.manageRemove'), () => void remove(f.id))}
        </p>
      ))}
      {pending?.kind === 'hotp' ? (
        <div data-atlas="hotp-setup">
          <p className={cls('text', 'atlas-text')}>{t('mfa.manageHotpHelp')}</p>
          <code data-atlas="hotp-secret">{pending.secret}</code>
          <p className={cls('text', 'atlas-text')}>
            <a className={cls('link', 'atlas-link')} href={pending.uri}>{t('mfa.manageHotpOpenApp')}</a>
          </p>
          <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={input} placeholder={t('mfa.manageHotpPlaceholder', { digits: String(pending.digits) })} onChange={(e) => setInput(e.target.value)} />
          {button(t('mfa.manageVerifyEnable'), () => void confirmHotp())}
        </div>
      ) : pending?.kind === 'yubikey' ? (
        <div data-atlas="yubikey-setup">
          <p className={cls('text', 'atlas-text')}>{t('mfa.manageYubikeyHelp')}</p>
          <input
            className={inputClass}
            autoFocus
            autoComplete="off"
            value={input}
            placeholder={t('mfa.manageYubikeyPlaceholder')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addYubikey();
              }
            }}
          />
          {button(t('mfa.manageYubikeyAdd'), () => void addYubikey())}
        </div>
      ) : pending?.kind === 'duo' ? (
        <div data-atlas="duo-setup">
          <p className={cls('text', 'atlas-text')}>{t('mfa.manageDuoHelp')}</p>
          {button(t('mfa.manageDuoApproved'), () => void confirmDuo())}
        </div>
      ) : (
        <>
          {offered?.hotp && !have('hotp') ? button(t('mfa.manageAddHotp'), () => void beginHotp()) : null}
          {offered?.yubikey && !have('yubikey') ? button(t('mfa.manageAddYubikey'), () => setPending({ kind: 'yubikey' })) : null}
          {offered?.duo && !have('duo') ? button(t('mfa.manageAddDuo'), () => void beginDuo()) : null}
        </>
      )}
      {backupCodes ? (
        <div>
          <p className={cls('text', 'atlas-text')}>{t('mfa.manageBackupCodes')}</p>
          <ul className={cls('list', 'atlas-list')} data-atlas="backup-codes">
            {backupCodes.map((c) => (
              <li className={cls('listItem', 'atlas-list-item')} key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ReverificationPrompt reverification={reverification} name="more-factors-reverification" />
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="more-factors-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Security questions for the signed-in user: pick the number of questions the application asks
 * and answer them. Used only to recover a forgotten password; they never replace a second
 * factor. Renders nothing unless the application offers them.
 */
export function ManageSecurityQuestions() {
  const t = useText();
  const client = useMeClient();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const inputClass = useClass('formFieldInput', 'atlas-account-input');
  const cls = useClasses();
  const reverification = useReverification();
  const [view, setView] = useState<SecurityQuestions | null>(null);
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setView(await getSecurityQuestions(client)), [client]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!view?.enabled) return null;

  const startEdit = () => {
    setChosen(Array.from({ length: view.required }, (_, i) => view.availableQuestions[i] ?? ''));
    setAnswers(Array.from({ length: view.required }, () => ''));
    setEditing(true);
  };
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const { questions, response } = await reverification.withReverification(() =>
        setSecurityQuestions(client, chosen.map((question, i) => ({ question, answer: answers[i] ?? '' }))),
      );
      if (!questions) return setError(response.errors[0] ? errorText(response.errors[0]) : t('securityQuestions.errorSave'));
      setView(questions);
      setEditing(false);
    } catch (err) {
      if (!isReverificationCancelled(err)) setError(t('securityQuestions.errorSave'));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setError(null);
    setBusy(true);
    try {
      await reverification.withReverification(() => removeSecurityQuestions(client));
    } catch (err) {
      if (!isReverificationCancelled(err)) setError(t('securityQuestions.errorRemove'));
    }
    await load();
    setBusy(false);
  };

  return (
    <section className={cardClass} data-atlas="manage-security-questions">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>{t('securityQuestions.title')}</h2>
      <p className={cls('text', 'atlas-text')}>{t('securityQuestions.help')}</p>
      {editing ? (
        <div>
          {chosen.map((q, i) => (
            <div key={i}>
              <select
                className={inputClass}
                aria-label={t('securityQuestions.question', { n: String(i + 1) })}
                value={q}
                onChange={(e) => setChosen((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
              >
                {view.availableQuestions.map((option) => (
                  <option key={option} value={option} disabled={chosen.includes(option) && option !== q}>
                    {option}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                autoComplete="off"
                aria-label={t('securityQuestions.answer', { n: String(i + 1) })}
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
              />
            </div>
          ))}
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void save()}>
            {t('securityQuestions.save')}
          </button>
        </div>
      ) : (
        <>
          <p className={cls('text', 'atlas-text')}>
            {view.answeredQuestions.length > 0 ? t('securityQuestions.answered', { list: view.answeredQuestions.join('; ') }) : t('securityQuestions.none')}
          </p>
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={startEdit}>
            {view.answeredQuestions.length > 0 ? t('securityQuestions.change') : t('securityQuestions.set')}
          </button>
          {view.answeredQuestions.length > 0 ? (
            <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void clear()}>
              {t('mfa.manageRemove')}
            </button>
          ) : null}
        </>
      )}
      <ReverificationPrompt reverification={reverification} name="security-questions-reverification" />
      {error ? (
        <p className={cls('alert', 'atlas-alert')} data-atlas="security-questions-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
