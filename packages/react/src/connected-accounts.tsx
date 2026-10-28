'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  connectMyConnection,
  connectOrganizationConnection,
  listMyConnections,
  listOrganizationConnections,
  setOrganizationConnectionCredentials,
  shareOrganizationConnection,
  type AppConnection,
} from '@atlasauth/js';
import { navigateTo, useClass, useClasses, useErrorText, useMeClient } from './components-shared';

/**
 * Connected accounts: the connections an app defined for the signed-in user (or,
 * with `organizationId`, their active organization), each with its live status.
 * `useConnectedAccounts()` is the headless half; `<ConnectedAccounts/>` is the
 * drop-in list with Connect, Reauthorize, credential entry and Share actions.
 */
export interface UseConnectedAccountsResult {
  status: 'loading' | 'ready' | 'error';
  connections: AppConnection[];
  error: string | null;
  reload(): Promise<void>;
  /** Start (or restart) the provider authorization of a connection and navigate to it. Stores the tokens on the connection; adds no sign-in method. */
  authorize(connection: AppConnection, redirectUrl: string): Promise<void>;
  /** Enter an organization connection's credential (api_key / client_credentials). */
  saveCredentials(connection: AppConnection, input: { apiKey?: string; clientId?: string; clientSecret?: string; tokenUrl?: string }): Promise<void>;
  /** Share the signed-in admin's own linked account with the organization (oauth). */
  share(connection: AppConnection): Promise<void>;
}

export function useConnectedAccounts(options: { organizationId?: string } = {}): UseConnectedAccountsResult {
  const { organizationId } = options;
  const client = useMeClient();
  const errorText = useErrorText();
  const [status, setStatus] = useState<UseConnectedAccountsResult['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<AppConnection[]>([]);

  const reload = useCallback(async () => {
    try {
      setConnections(organizationId ? await listOrganizationConnections(client, organizationId) : await listMyConnections(client));
      setStatus('ready');
      setError(null);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? errorText(err) : String(err));
    }
  }, [client, errorText, organizationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const authorize = useCallback(
    async (connection: AppConnection, redirectUrl: string) => {
      const start = organizationId
        ? await connectOrganizationConnection(client, organizationId, connection.id, { redirectUrl })
        : await connectMyConnection(client, connection.id, { redirectUrl });
      navigateTo(start.authorization_url);
    },
    [client, organizationId],
  );

  const saveCredentials = useCallback(
    async (connection: AppConnection, input: Parameters<UseConnectedAccountsResult['saveCredentials']>[1]) => {
      if (!organizationId) throw new Error('Credentials are entered on organization connections.');
      await setOrganizationConnectionCredentials(client, organizationId, connection.id, input);
      await reload();
    },
    [client, organizationId, reload],
  );

  const share = useCallback(
    async (connection: AppConnection) => {
      if (!organizationId) throw new Error('Only organization connections are shared.');
      await shareOrganizationConnection(client, organizationId, connection.id);
      await reload();
    },
    [client, organizationId, reload],
  );

  return { status, connections, error, reload, authorize, saveCredentials, share };
}

export interface ConnectedAccountsProps {
  /** Show this (active) organization's connections instead of the user's own. */
  organizationId?: string;
  /** Where a provider returns after authorizing; defaults to the current page. */
  redirectUrl?: string;
  /** Override the English labels. */
  labels?: Partial<Record<'title' | 'empty' | 'connect' | 'reauthorize' | 'share' | 'save' | 'apiKey' | 'clientId' | 'clientSecret' | 'tokenUrl' | 'connected' | 'not_connected' | 'needs_reauth' | 'revoked' | 'error', string>>;
}

const DEFAULT_LABELS = {
  title: 'Connected accounts',
  empty: 'No connections are set up yet.',
  connect: 'Connect',
  reauthorize: 'Reauthorize',
  share: 'Share my account',
  save: 'Save',
  apiKey: 'API key',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  tokenUrl: 'Token URL',
  connected: 'Connected',
  not_connected: 'Not connected',
  needs_reauth: 'Needs reauthorization',
  revoked: 'Disconnected',
  error: 'Error',
};

export function ConnectedAccounts({ organizationId, redirectUrl, labels }: ConnectedAccountsProps) {
  const api = useConnectedAccounts({ organizationId });
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const l = { ...DEFAULT_LABELS, ...labels };
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});

  if (api.status === 'loading') return null;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setFormError(null);
    try {
      await fn();
    } catch (err) {
      setFormError(err instanceof Error ? errorText(err) : String(err));
    } finally {
      setBusy(null);
    }
  };
  const field = (c: AppConnection, name: string) => draft[c.id]?.[name] ?? '';
  const setField = (c: AppConnection, name: string, value: string) => setDraft((d) => ({ ...d, [c.id]: { ...d[c.id], [name]: value } }));
  const back = redirectUrl ?? (typeof window !== 'undefined' ? window.location.href : '');
  const secretInput = (c: AppConnection, name: string, label: string, type = 'password') => (
    <label className={cls('formField', 'atlas-field')} key={name}>
      <span className={cls('formFieldLabel', 'atlas-field-label')}>{label}</span>
      <input className={cls('formFieldInput', 'atlas-input')} type={type} autoComplete="off" value={field(c, name)} onChange={(e) => setField(c, name, e.target.value)} />
    </label>
  );

  return (
    <section className={cardClass} data-atlas="connected-accounts">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>{l.title}</h2>
      {api.error || formError ? <p className={cls('alert', 'atlas-alert')} role="alert">{formError ?? api.error}</p> : null}
      {api.connections.length === 0 ? <p className={cls('text', 'atlas-text')}>{l.empty}</p> : null}
      <ul data-atlas="connected-accounts-list">
        {api.connections.map((c) => (
          <li key={c.id} data-atlas="connected-account" data-status={c.status}>
            <p className={cls('text', 'atlas-text')}>
              <strong>{c.name}</strong> <span data-atlas="connected-account-status">{l[c.status]}</span>
            </p>
            {c.kind === 'oauth' ? (
              <>
                <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy === c.id} onClick={() => void run(c.id, () => api.authorize(c, back))}>
                  {c.status === 'connected' || c.status === 'needs_reauth' ? l.reauthorize : l.connect}
                </button>
                {organizationId ? (
                  <button className={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" disabled={busy === c.id} onClick={() => void run(c.id, () => api.share(c))}>
                    {l.share}
                  </button>
                ) : null}
              </>
            ) : organizationId ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(c.id, async () => {
                    await api.saveCredentials(c, c.kind === 'api_key'
                      ? { apiKey: field(c, 'apiKey') }
                      : { clientId: field(c, 'clientId'), clientSecret: field(c, 'clientSecret'), tokenUrl: field(c, 'tokenUrl') });
                    setDraft((d) => ({ ...d, [c.id]: {} }));
                  });
                }}
              >
                {c.kind === 'api_key'
                  ? secretInput(c, 'apiKey', l.apiKey)
                  : [secretInput(c, 'clientId', l.clientId, 'text'), secretInput(c, 'clientSecret', l.clientSecret), secretInput(c, 'tokenUrl', l.tokenUrl, 'url')]}
                <button className={cls('formButtonPrimary', 'atlas-button')} type="submit" disabled={busy === c.id}>{l.save}</button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
