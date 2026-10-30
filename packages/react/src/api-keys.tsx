'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiKeyRequestError,
  createApiKey,
  impliedScopes,
  listApiKeys,
  scopeGrid,
  revokeApiKey,
  updateApiKey,
  type CreateUserApiKeyInput,
  type CreatedUserApiKey,
  type UserApiKey,
} from '@atlasauth/js';
import { useReverification } from './reverification';
import { useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';

/**
 * End-user API key self-service — the signed-in user's OWN `ak_` keys (or, with
 * `organizationId`, their active organization's), over `/v1/client/me/api_keys`.
 *
 * `useApiKeys()` is the headless half: list + create + rename + revoke, with the
 * step-up wired in — creating a key on a stale session parks the call and flips
 * `reverification.needsReverification`; `completeReverification({ strategy:
 * 'password', password })` re-authenticates in place and finishes the create.
 * `<ApiKeys/>` is the drop-in UI built on it.
 */

export type ApiKeysStatus = 'loading' | 'ready' | 'disabled' | 'error';

export interface UseApiKeysResult {
  status: ApiKeysStatus;
  keys: UserApiKey[];
  /** The scopes / claim names a new key may carry (instance allowlists). */
  allowedScopes: string[];
  allowedClaims: string[];
  /** Instance scope implications (`calls:write` ⇒ `calls:read`); `*` = every scope. */
  scopeImplications: Record<string, string[]>;
  maxActiveKeys: number;
  activeCount: number;
  error: string | null;
  reload(): Promise<void>;
  /** Create a key. Resolves with the one-time `secret`; parks for reverification on a stale session. */
  createKey(input?: Omit<CreateUserApiKeyInput, 'organizationId'>): Promise<CreatedUserApiKey>;
  renameKey(id: string, name: string | null): Promise<UserApiKey>;
  revokeKey(id: string): Promise<void>;
  reverification: ReturnType<typeof useReverification>;
}

export function useApiKeys(options: { organizationId?: string } = {}): UseApiKeysResult {
  const { organizationId } = options;
  const client = useMeClient();
  const errorText = useErrorText();
  const reverification = useReverification();
  const { withReverification } = reverification;
  const [status, setStatus] = useState<ApiKeysStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<{
    data: UserApiKey[];
    allowedScopes: string[];
    allowedClaims: string[];
    scopeImplications: Record<string, string[]>;
    maxActiveKeys: number;
    activeCount: number;
  }>({ data: [], allowedScopes: [], allowedClaims: [], scopeImplications: {}, maxActiveKeys: 0, activeCount: 0 });

  const reload = useCallback(async () => {
    try {
      const next = await listApiKeys(client, { organizationId });
      setList(next);
      setStatus('ready');
      setError(null);
    } catch (err) {
      // A 403 on the LIST means the feature is off (or org keys are, or the role
      // lacks the permission) — render nothing actionable rather than an error.
      if (err instanceof ApiKeyRequestError && err.status === 403) {
        setStatus('disabled');
        setError(errorText(err));
        return;
      }
      setStatus('error');
      setError(err instanceof Error ? errorText(err) : String(err));
    }
  }, [client, errorText, organizationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createKey = useCallback(
    async (input: Omit<CreateUserApiKeyInput, 'organizationId'> = {}) => {
      const created = await withReverification(() =>
        createApiKey(client, { ...input, ...(organizationId ? { organizationId } : {}) }),
      );
      await reload();
      return created;
    },
    [client, organizationId, reload, withReverification],
  );

  const renameKey = useCallback(
    async (id: string, name: string | null) => {
      const updated = await updateApiKey(client, id, { name });
      await reload();
      return updated;
    },
    [client, reload],
  );

  const revokeKey = useCallback(
    async (id: string) => {
      await revokeApiKey(client, id);
      await reload();
    },
    [client, reload],
  );

  return {
    status,
    keys: list.data,
    allowedScopes: list.allowedScopes,
    allowedClaims: list.allowedClaims,
    scopeImplications: list.scopeImplications,
    maxActiveKeys: list.maxActiveKeys,
    activeCount: list.activeCount,
    error,
    reload,
    createKey,
    renameKey,
    revokeKey,
    reverification,
  };
}

/** What a claims slot receives: the draft claims and a setter, scoped to the allowlist. */
export interface ApiKeyClaimsFieldsContext {
  claims: Record<string, unknown>;
  /** Set (or, with `undefined`, remove) one claim on the key being created. */
  setClaim(name: string, value: unknown): void;
  /** The claim names the application lets a user set. Others are refused by the server. */
  allowedClaims: string[];
}

export interface ApiKeysProps {
  /** Manage this (active) organization's keys instead of the user's own. */
  organizationId?: string;
  /**
   * Extra create-form fields whose values go into the key's `claims` — e.g. a
   * spend limit. Only claim names the application allows are accepted.
   */
  renderClaimsFields?: (ctx: ApiKeyClaimsFieldsContext) => ReactNode;
  /** Alias of `renderClaimsFields`. */
  claimsForm?: (ctx: ApiKeyClaimsFieldsContext) => ReactNode;
  /** Called with the newly created key (including its one-time `secret`). */
  onCreate?: (key: CreatedUserApiKey) => void;
  /** Expiry choices offered, in days. `0` means never. Default `[0, 30, 90, 365]`. */
  expiryOptionsDays?: number[];
}

function formatLimit(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Drop-in API key manager: list, create (with the reverification prompt when the
 * session is stale), show the new secret once with a copy button, rename, and
 * revoke with a confirmation step.
 */
export function ApiKeys(props: ApiKeysProps) {
  const { organizationId, onCreate, expiryOptionsDays = [0, 30, 90, 365] } = props;
  const renderClaims = props.renderClaimsFields ?? props.claimsForm;
  const api = useApiKeys({ organizationId });
  const t = useText();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiryDays, setExpiryDays] = useState(expiryOptionsDays[0] ?? 0);
  const [scopes, setScopes] = useState<string[]>([]);
  const [claims, setClaims] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);

  const claimsCtx = useMemo<ApiKeyClaimsFieldsContext>(
    () => ({
      claims,
      allowedClaims: api.allowedClaims,
      setClaim: (claim, value) =>
        setClaims((prev) => {
          const next = { ...prev };
          if (value === undefined) delete next[claim];
          else next[claim] = value;
          return next;
        }),
    }),
    [claims, api.allowedClaims],
  );

  if (api.status === 'loading') return null;
  if (api.status === 'disabled') {
    return (
      <section className={cardClass} data-atlas="api-keys">
        <h2 className={cls('sectionTitle', 'atlas-section-title')}>{t('apiKeys.title')}</h2>
        <p className={cls('text', 'atlas-text')} data-atlas="api-keys-disabled">{t('apiKeys.disabled')}</p>
      </section>
    );
  }

  const now = Date.now();
  const atCap = api.maxActiveKeys > 0 && api.activeCount >= api.maxActiveKeys;
  const resetForm = () => {
    setCreating(false);
    setName('');
    setExpiryDays(expiryOptionsDays[0] ?? 0);
    setScopes([]);
    setClaims({});
    setFormError(null);
  };

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const created = await api.createKey({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(expiryDays > 0 ? { expiresInSeconds: expiryDays * 24 * 60 * 60 } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
        ...(Object.keys(claims).length > 0 ? { claims } : {}),
      });
      setSecret(created.secret);
      setCopied(false);
      resetForm();
      onCreate?.(created);
    } catch (err) {
      // A cancelled reverification is not an error worth showing.
      if (!(err instanceof Error && err.message === 'Reverification cancelled.')) {
        setFormError(err instanceof Error ? errorText(err) : t('error.generic'));
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmIdentity = async () => {
    setReauthError(null);
    try {
      await api.reverification.completeReverification({ strategy: 'password', password });
      setPassword('');
    } catch (err) {
      setReauthError(err instanceof Error ? errorText(err) : t('error.generic'));
    }
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard?.writeText(secret);
      setCopied(true);
    } catch {
      /* the secret stays visible for manual copy */
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      await api.renameKey(renaming.id, renaming.name.trim() || null);
      setRenaming(null);
    } catch (err) {
      setFormError(err instanceof Error ? errorText(err) : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api.revokeKey(id);
      setConfirmRevoke(null);
    } catch (err) {
      setFormError(err instanceof Error ? errorText(err) : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const statusOf = (key: UserApiKey): string | null => {
    if (key.revoked_at) return t('apiKeys.revoked');
    if (key.expires_at && key.expires_at <= now) return t('apiKeys.expired');
    return null;
  };

  return (
    <section className={cardClass} data-atlas="api-keys">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>{t('apiKeys.title')}</h2>
      <p className={cls('text', 'atlas-text')}>
        {t(organizationId ? 'apiKeys.organizationSubtitle' : 'apiKeys.subtitle')}
      </p>

      {api.error && api.status === 'error' ? (
        <p className={cls('alert', 'atlas-alert')} role="alert">{api.error}</p>
      ) : null}

      {secret ? (
        <div data-atlas="api-key-secret" role="status">
          <p className={cls('text', 'atlas-text')}><strong>{t('apiKeys.secretTitle')}</strong></p>
          <p className={cls('text', 'atlas-text')}>{t('apiKeys.secretHint')}</p>
          <code data-atlas="api-key-secret-value">{secret}</code>
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={() => void copy()}>
            {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
          </button>
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={() => setSecret(null)}>
            {t('apiKeys.done')}
          </button>
        </div>
      ) : null}

      {api.reverification.needsReverification ? (
        <div data-atlas="api-keys-reverification" role="dialog" aria-label={t('reverification.title')}>
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
            onClick={() => {
              setPassword('');
              setReauthError(null);
              api.reverification.cancelReverification();
            }}
          >
            {t('reverification.cancel')}
          </button>
        </div>
      ) : null}

      {api.keys.length === 0 ? (
        <p className={cls('text', 'atlas-text')} data-atlas="api-keys-empty">{t('apiKeys.empty')}</p>
      ) : (
        <ul className={cls('list', 'atlas-list')} data-atlas="api-keys-list">
          {api.keys.map((key) => {
            const state = statusOf(key);
            const limits = key.limits && typeof key.limits === 'object' ? Object.entries(key.limits) : [];
            return (
              <li className={cls('listItem', 'atlas-list-item')} key={key.id} data-atlas="api-key">
                {renaming?.id === key.id ? (
                  <span>
                    <input
                      className={cls('formFieldInput', 'atlas-account-input')}
                      aria-label={t('apiKeys.nameLabel')}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: key.id, name: e.target.value })}
                    />
                    <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void saveRename()}>
                      {t('apiKeys.save')}
                    </button>
                    <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={() => setRenaming(null)}>
                      {t('apiKeys.cancel')}
                    </button>
                  </span>
                ) : (
                  <strong>{key.name ?? t('apiKeys.unnamed')}</strong>
                )}{' '}
                <code>{key.prefix}…</code>
                {state ? <em> — {state}</em> : null}
                <div className={cls('text', 'atlas-text')}>
                  {[
                    key.last_used_at
                      ? t('apiKeys.lastUsed', { date: new Date(key.last_used_at).toLocaleDateString() })
                      : t('apiKeys.neverUsed'),
                    key.expires_at ? t('apiKeys.expiresOn', { date: new Date(key.expires_at).toLocaleDateString() }) : null,
                    key.scopes && key.scopes.length > 0 ? key.scopes.join(', ') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {limits.length > 0 ? (
                  <div className={cls('text', 'atlas-text')} data-atlas="api-key-limits">
                    {t('apiKeys.limits')}: {limits.map(([k, v]) => `${k} ${formatLimit(v)}`).join(' · ')}
                  </div>
                ) : null}
                {!key.revoked_at && renaming?.id !== key.id ? (
                  confirmRevoke === key.id ? (
                    <span data-atlas="api-key-revoke-confirm">
                      <span className={cls('text', 'atlas-text')}>{t('apiKeys.revokeConfirm')}</span>
                      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy} onClick={() => void revoke(key.id)}>
                        {t('apiKeys.revokeConfirmButton')}
                      </button>
                      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={() => setConfirmRevoke(null)}>
                        {t('apiKeys.cancel')}
                      </button>
                    </span>
                  ) : (
                    <span>
                      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={() => setRenaming({ id: key.id, name: key.name ?? '' })}>
                        {t('apiKeys.rename')}
                      </button>
                      <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={() => setConfirmRevoke(key.id)}>
                        {t('apiKeys.revoke')}
                      </button>
                    </span>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {formError ? <p className={cls('alert', 'atlas-alert')} role="alert">{formError}</p> : null}

      {creating ? (
        <div data-atlas="api-key-create">
          <label className={cls('formField', 'atlas-field')}>
            <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('apiKeys.nameLabel')}</span>
            <input
              className={cls('formFieldInput', 'atlas-account-input')}
              value={name}
              maxLength={100}
              placeholder={t('apiKeys.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className={cls('formField', 'atlas-field')}>
            <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('apiKeys.expiresLabel')}</span>
            <select
              className={cls('formFieldInput', 'atlas-account-input')}
              value={String(expiryDays)}
              onChange={(e) => setExpiryDays(Number(e.target.value))}
            >
              {expiryOptionsDays.map((days) => (
                <option key={days} value={String(days)}>
                  {days > 0 ? t('apiKeys.expiresDays', { days: String(days) }) : t('apiKeys.expiresNever')}
                </option>
              ))}
            </select>
          </label>
          {api.allowedScopes.length > 0 ? (
            <ScopePicker
              allowedScopes={api.allowedScopes}
              implications={api.scopeImplications}
              selected={scopes}
              onChange={setScopes}
              legend={t('apiKeys.scopesLabel')}
              fieldClass={cls('formField', 'atlas-field')}
              legendClass={cls('formFieldLabel', 'atlas-field-label')}
            />
          ) : null}
          {renderClaims ? renderClaims(claimsCtx) : null}
          <button className={cls('formButtonPrimary', 'atlas-button')} type="button" disabled={busy} onClick={() => void submit()}>
            {t('apiKeys.submit')}
          </button>
          <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" onClick={resetForm}>
            {t('apiKeys.cancel')}
          </button>
        </div>
      ) : atCap ? (
        <p className={cls('text', 'atlas-text')} data-atlas="api-keys-limit">
          {t('apiKeys.limitReached', { max: String(api.maxActiveKeys) })}
        </p>
      ) : (
        <button className={cls('formButtonPrimary', 'atlas-button')} type="button" onClick={() => setCreating(true)}>
          {t('apiKeys.create')}
        </button>
      )}
    </section>
  );
}

/**
 * The create form's scope choices. When the vocabulary has `<resource>:read` /
 * `<resource>:write` scopes they render as a resource × read/write grid; any other
 * scope is a plain checkbox below it. A scope implied by a ticked one (per the
 * instance implications, e.g. write ⇒ read) shows ticked and locked: the key gets
 * it anyway, so only the explicitly chosen scopes are sent.
 */
function ScopePicker(props: {
  allowedScopes: string[];
  implications: Record<string, string[]>;
  selected: string[];
  onChange(next: string[]): void;
  legend: string;
  fieldClass: string;
  legendClass: string;
}) {
  const { allowedScopes, implications, selected, onChange } = props;
  const implied = new Set(
    impliedScopes(selected, implications, allowedScopes).filter((s) => !selected.includes(s)),
  );
  const box = (scope: string) => (
    <input
      type="checkbox"
      aria-label={scope}
      data-atlas-scope={scope}
      checked={selected.includes(scope) || implied.has(scope)}
      disabled={implied.has(scope)}
      onChange={(e) =>
        onChange(e.target.checked ? [...selected, scope] : selected.filter((s) => s !== scope))
      }
    />
  );
  const grid = scopeGrid(allowedScopes);
  const flat = grid ? grid.other : allowedScopes;
  return (
    <fieldset className={props.fieldClass}>
      <legend className={props.legendClass}>{props.legend}</legend>
      {grid ? (
        <table data-atlas="api-key-scope-grid">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">read</th>
              <th scope="col">write</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.resource}>
                <th scope="row">{row.resource}</th>
                <td>{row.read ? box(row.read) : null}</td>
                <td>{row.write ? box(row.write) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {flat.map((scope) => (
        <label key={scope}>
          {box(scope)} {scope}
        </label>
      ))}
    </fieldset>
  );
}

// Re-exported so an app can type its own handlers without importing @atlasauth/js.
export type { CreateUserApiKeyInput, CreatedUserApiKey, UserApiKey } from '@atlasauth/js';
