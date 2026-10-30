'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  OrganizationRequestError,
  organizationAdmin,
  type FapiClient,
  type OrganizationApiKey,
  type OrganizationDirectory as DirectoryData,
  type OrganizationDomain,
  type OrganizationIpAllowlist as AllowlistData,
  type OrganizationLogStream,
  type OrganizationSsoInput,
  type OrganizationSsoView,
  type OrganizationAppEventType,
  type OrganizationWebhookDelivery,
  type OrganizationWebhookEndpoint,
} from '@atlasauth/js';
import { useOrganization } from './hooks';
import { useClass, useClasses, useMeClient } from './components-shared';

/**
 * The tenant-admin widgets that sit inside `<OrganizationProfile adminSections>`
 * (or alone, next to it): SSO connection, directory sync, domains, log streams,
 * API keys, sign-in IP allowlist and webhooks. Each one works on the ACTIVE
 * organization, follows the server's permission gate (it renders nothing for a
 * member who may not manage the organization) and takes its labels as props so
 * an app can localise them. Secrets the server returns once are shown once.
 */

type Labels = Record<string, string | undefined>;

interface AdminData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  forbidden: boolean;
  reload(): Promise<void>;
  /** Run a mutation, surface its error, then reload. Resolves to its result (or null on error). */
  act<R>(fn: () => Promise<R>): Promise<R | null>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'The request failed.');

/** Load one admin resource for the active organization and re-load it after each mutation. */
function useAdminData<T>(load: (client: FapiClient, organizationId: string) => Promise<T>): AdminData<T> {
  const { organization } = useOrganization();
  const client = useMeClient();
  const orgId = organization?.id;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const reload = useCallback(async () => {
    if (!orgId) return;
    try {
      setData(await load(client, orgId));
      setForbidden(false);
      setError(null);
    } catch (err) {
      if (err instanceof OrganizationRequestError && (err.status === 403 || err.status === 404)) setForbidden(true);
      else setError(messageOf(err));
    } finally {
      setLoading(false);
    }
    // `load` is a module-level function in every caller; the org and client drive reloads.
  }, [client, orgId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const act = useCallback(
    async <R,>(fn: () => Promise<R>): Promise<R | null> => {
      try {
        const out = await fn();
        setError(null);
        await reload();
        return out;
      } catch (err) {
        setError(messageOf(err));
        return null;
      }
    },
    [reload],
  );

  return { data, loading, error, forbidden, reload, act };
}

function Section({
  name,
  title,
  admin,
  children,
}: {
  name: string;
  title: string;
  admin: Pick<AdminData<unknown>, 'forbidden' | 'error' | 'loading'>;
  children: ReactNode;
}) {
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  if (admin.forbidden) return null;
  return (
    <div className={cardClass} data-atlas={name}>
      <h2 className={cls('headerTitle', 'atlas-title')}>{title}</h2>
      {admin.error ? (
        <p className={cls('alert', 'atlas-alert')} role="alert">
          {admin.error}
        </p>
      ) : null}
      {admin.loading ? null : children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const cls = useClasses();
  return (
    <label className={cls('formField', 'atlas-field')}>
      <span className={cls('formFieldLabel', 'atlas-field-label')}>{label}</span>
      {children}
    </label>
  );
}

/** A value shown exactly once (a new secret) with a note to copy it now. */
function OneTimeSecret({ value, note }: { value: string | null; note: string }) {
  const cls = useClasses();
  if (!value) return null;
  return (
    <p className={cls('text', 'atlas-text')} data-atlas="one-time-secret">
      <input className={cls('formFieldInput', 'atlas-input')} readOnly value={value} aria-label={note} onFocus={(e) => e.currentTarget.select()} />
      <small>{note}</small>
    </p>
  );
}

/** `<OrganizationSsoConnection/>` — set up the organization's own OIDC or SAML sign-in. */
export function OrganizationSsoConnection({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<OrganizationSsoView>(organizationAdmin.getSso);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [form, setForm] = useState<Record<string, string>>({});
  const [type, setType] = useState<'oidc' | 'saml'>('oidc');
  const conn = admin.data?.connection ?? null;

  useEffect(() => {
    if (conn) setType(conn.type);
  }, [conn]);

  if (!organization) return null;
  const set = (key: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const sp = admin.data?.sp;

  const save = () => {
    const input: OrganizationSsoInput = { type };
    for (const [k, v] of Object.entries(form)) if (v !== '') (input as unknown as Record<string, string>)[k] = v;
    return admin.act(() => organizationAdmin.saveSso(client, organization.id, input)).then(() => setForm({}));
  };

  return (
    <Section name="organization-sso-connection" title={labels.title ?? 'Single sign-on'} admin={admin}>
      <p className={cls('headerSubtitle', 'atlas-subtitle')}>
        {conn ? `${conn.type.toUpperCase()} — ${conn.status}` : (labels.none ?? 'No connection yet.')}
      </p>
      {sp ? (
        <>
          <Field label={labels.acsUrl ?? 'ACS URL (SAML)'}>
            <input className={cls('formFieldInput', 'atlas-input')} readOnly value={sp.acs_url} />
          </Field>
          <Field label={labels.redirectUri ?? 'Redirect URI (OIDC)'}>
            <input className={cls('formFieldInput', 'atlas-input')} readOnly value={sp.oidc_redirect_uri} />
          </Field>
          {sp.sp_entity_id ? (
            <Field label={labels.entityId ?? 'SP entity ID / metadata URL'}>
              <input className={cls('formFieldInput', 'atlas-input')} readOnly value={sp.sp_entity_id} />
            </Field>
          ) : null}
        </>
      ) : null}
      {conn ? null : (
        <div role="radiogroup">
          {(['oidc', 'saml'] as const).map((t) => (
            <label key={t}>
              <input type="radio" name="sso-type" checked={type === t} onChange={() => setType(t)} /> {t.toUpperCase()}
            </label>
          ))}
        </div>
      )}
      {type === 'oidc' ? (
        <>
          <Field label={labels.issuer ?? 'Issuer URL'}>
            <input className={cls('formFieldInput', 'atlas-input')} placeholder={conn?.oidc_issuer ?? ''} value={form.oidc_issuer ?? ''} onChange={set('oidc_issuer')} />
          </Field>
          <Field label={labels.clientId ?? 'Client ID'}>
            <input className={cls('formFieldInput', 'atlas-input')} placeholder={conn?.oidc_client_id ?? ''} value={form.oidc_client_id ?? ''} onChange={set('oidc_client_id')} />
          </Field>
          <Field label={labels.clientSecret ?? 'Client secret'}>
            <input className={cls('formFieldInput', 'atlas-input')} type="password" autoComplete="off" placeholder={conn?.has_secret ? '••••••••' : ''} value={form.oidc_client_secret ?? ''} onChange={set('oidc_client_secret')} />
          </Field>
        </>
      ) : (
        <>
          <Field label={labels.metadataXml ?? 'IdP metadata XML'}>
            <textarea className={cls('formFieldInput', 'atlas-input')} rows={4} value={form.saml_metadata_xml ?? ''} onChange={set('saml_metadata_xml')} />
          </Field>
          <Field label={labels.certificate ?? 'IdP signing certificate (PEM)'}>
            <textarea className={cls('formFieldInput', 'atlas-input')} rows={4} placeholder={conn?.has_saml_certificate ? '••••••••' : ''} value={form.saml_idp_certificate ?? ''} onChange={set('saml_idp_certificate')} />
          </Field>
        </>
      )}
      <button type="button" className={cls('formButtonPrimary', 'atlas-button')} onClick={() => void save()}>
        {labels.save ?? 'Save connection'}
      </button>
    </Section>
  );
}

/** `<OrganizationDirectory/>` — directory sync (SCIM): the endpoint to point the IdP at and its tokens. */
export function OrganizationDirectory({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<DirectoryData>(organizationAdmin.getDirectory);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [secret, setSecret] = useState<string | null>(null);
  if (!organization) return null;
  return (
    <Section name="organization-directory" title={labels.title ?? 'Directory sync'} admin={admin}>
      {admin.data ? (
        <Field label={labels.baseUrl ?? 'SCIM base URL'}>
          <input className={cls('formFieldInput', 'atlas-input')} readOnly value={admin.data.base_url} />
        </Field>
      ) : null}
      <ul className={cls('list', 'atlas-list')}>
        {admin.data?.tokens.map((t) => (
          <li key={t.id} className={cls('listItem', 'atlas-audit-item')}>
            <code>{t.prefix}</code>
            <button type="button" className={cls('formButtonSecondary', 'atlas-button-secondary')} onClick={() => void admin.act(() => organizationAdmin.revokeDirectoryToken(client, organization.id, t.id))}>
              {labels.revoke ?? 'Revoke'}
            </button>
          </li>
        ))}
      </ul>
      <OneTimeSecret value={secret} note={labels.copyNow ?? 'Copy this token now — it will not be shown again.'} />
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        onClick={() => void admin.act(() => organizationAdmin.createDirectoryToken(client, organization.id)).then((r) => r && setSecret(r.token))}
      >
        {labels.generate ?? 'Generate token'}
      </button>
    </Section>
  );
}

/** `<OrganizationDomains/>` — claim email domains and verify them with a DNS TXT record. */
export function OrganizationDomains({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<OrganizationDomain[]>(organizationAdmin.listDomains);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [domain, setDomain] = useState('');
  const [note, setNote] = useState<string | null>(null);
  if (!organization) return null;
  return (
    <Section name="organization-domains" title={labels.title ?? 'Domains'} admin={admin}>
      <ul className={cls('list', 'atlas-list')}>
        {admin.data?.map((d) => (
          <li key={d.id} className={cls('listItem', 'atlas-audit-item')} data-status={d.status}>
            <strong>{d.domain}</strong> — {d.status}
            {d.status === 'verified' ? null : (
              <small>
                {' '}
                {labels.txtHint ?? 'Publish a TXT record'} <code>{d.verification.record_name}</code> = <code>{d.verification.record_value}</code>
              </small>
            )}
            {d.status === 'verified' ? null : (
              <button
                type="button"
                className={cls('formButtonSecondary', 'atlas-button-secondary')}
                onClick={() =>
                  void admin
                    .act(() => organizationAdmin.verifyDomain(client, organization.id, d.id))
                    .then((r) => r && setNote(r.verified ? (labels.verified ?? 'Verified.') : (labels.notFound ?? 'Not found yet — DNS can take a few minutes.')))
                }
              >
                {labels.verify ?? 'Verify'}
              </button>
            )}
            <button type="button" className={cls('formButtonSecondary', 'atlas-button-secondary')} onClick={() => void admin.act(() => organizationAdmin.removeDomain(client, organization.id, d.id))}>
              {labels.remove ?? 'Remove'}
            </button>
          </li>
        ))}
      </ul>
      {note ? <p role="status">{note}</p> : null}
      <Field label={labels.domain ?? 'Email domain'}>
        <input className={cls('formFieldInput', 'atlas-input')} placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
      </Field>
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        disabled={!domain.trim()}
        onClick={() => void admin.act(() => organizationAdmin.addDomain(client, organization.id, domain.trim())).then((r) => r && setDomain(''))}
      >
        {labels.add ?? 'Add domain'}
      </button>
    </Section>
  );
}

/** `<OrganizationLogStreams/>` — send the organization's audit events to its own SIEM. */
export function OrganizationLogStreams({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<OrganizationLogStream[]>(organizationAdmin.listLogStreams);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  if (!organization) return null;
  return (
    <Section name="organization-log-streams" title={labels.title ?? 'Log streams'} admin={admin}>
      <ul className={cls('list', 'atlas-list')}>
        {admin.data?.map((s) => (
          <li key={s.id} className={cls('listItem', 'atlas-audit-item')}>
            {s.url}
            <button type="button" className={cls('formButtonSecondary', 'atlas-button-secondary')} onClick={() => void admin.act(() => organizationAdmin.removeLogStream(client, organization.id, s.id))}>
              {labels.remove ?? 'Remove'}
            </button>
          </li>
        ))}
      </ul>
      <Field label={labels.url ?? 'HTTPS endpoint'}>
        <input className={cls('formFieldInput', 'atlas-input')} type="url" placeholder="https://siem.example.com/ingest" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <OneTimeSecret value={secret} note={labels.copyNow ?? 'Copy the signing secret now — it will not be shown again.'} />
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        disabled={!url.trim()}
        onClick={() => void admin.act(() => organizationAdmin.addLogStream(client, organization.id, { url: url.trim() })).then((r) => { if (r) { setUrl(''); setSecret(r.secret); } })}
      >
        {labels.add ?? 'Add destination'}
      </button>
    </Section>
  );
}

/** `<OrganizationApiKeys/>` — keys bound to the organization, shown once on creation. */
export function OrganizationApiKeys({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<OrganizationApiKey[]>(organizationAdmin.listApiKeys);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  if (!organization) return null;
  return (
    <Section name="organization-api-keys" title={labels.title ?? 'API keys'} admin={admin}>
      <ul className={cls('list', 'atlas-list')}>
        {admin.data?.map((k) => (
          <li key={k.id} className={cls('listItem', 'atlas-audit-item')}>
            <strong>{k.name || k.prefix}</strong> <code>{k.prefix}</code>
            <button type="button" className={cls('formButtonSecondary', 'atlas-button-secondary')} onClick={() => void admin.act(() => organizationAdmin.revokeApiKey(client, organization.id, k.id))}>
              {labels.revoke ?? 'Revoke'}
            </button>
          </li>
        ))}
      </ul>
      <Field label={labels.name ?? 'Key name'}>
        <input className={cls('formFieldInput', 'atlas-input')} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <OneTimeSecret value={secret} note={labels.copyNow ?? 'Copy this key now — it will not be shown again.'} />
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        onClick={() => void admin.act(() => organizationAdmin.createApiKey(client, organization.id, { name: name.trim() || undefined })).then((r) => { if (r) { setName(''); setSecret(r.secret); } })}
      >
        {labels.create ?? 'Create key'}
      </button>
    </Section>
  );
}

/** `<OrganizationIpAllowlist/>` — limit where members of the organization may sign in from. */
export function OrganizationIpAllowlist({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<AllowlistData>(organizationAdmin.getIpAllowlist);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [draft, setDraft] = useState<string | null>(null);
  if (!organization) return null;
  const text = draft ?? (admin.data?.entries ?? []).join('\n');
  const save = () =>
    admin
      .act(() => organizationAdmin.setIpAllowlist(client, organization.id, text.split(/[\s,]+/).filter(Boolean)))
      .then((r) => r && setDraft(null));
  return (
    <Section name="organization-ip-allowlist" title={labels.title ?? 'Sign-in IP allowlist'} admin={admin}>
      <p className={cls('headerSubtitle', 'atlas-subtitle')}>
        {labels.hint ?? 'One IP address or CIDR range per line. Empty means members can sign in from anywhere.'}
        {admin.data ? ` ${labels.yourIp ?? 'Your IP:'} ${admin.data.your_ip}` : ''}
      </p>
      <textarea className={cls('formFieldInput', 'atlas-input')} rows={5} aria-label={labels.title ?? 'Sign-in IP allowlist'} value={text} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className={cls('formButtonPrimary', 'atlas-button')} onClick={() => void save()}>
        {labels.save ?? 'Save'}
      </button>
    </Section>
  );
}

/** `<OrganizationWebhooks/>` — the organization's own signed event endpoints. */
export function OrganizationWebhooks({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<OrganizationWebhookEndpoint[]>(organizationAdmin.listWebhooks);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  if (!organization) return null;
  return (
    <Section name="organization-webhooks" title={labels.title ?? 'Webhooks'} admin={admin}>
      <ul className={cls('list', 'atlas-list')}>
        {admin.data?.map((w) => (
          <li key={w.id} className={cls('listItem', 'atlas-audit-item')} data-health={w.health}>
            {w.url} — {w.health}
            <button
              type="button"
              className={cls('formButtonSecondary', 'atlas-button-secondary')}
              onClick={() => void admin.act(() => organizationAdmin.rotateWebhookSecret(client, organization.id, w.id)).then((r) => r && setSecret(r.secret))}
            >
              {labels.rotate ?? 'Rotate secret'}
            </button>
            <button type="button" className={cls('formButtonSecondary', 'atlas-button-secondary')} onClick={() => void admin.act(() => organizationAdmin.deleteWebhook(client, organization.id, w.id))}>
              {labels.remove ?? 'Remove'}
            </button>
          </li>
        ))}
      </ul>
      <Field label={labels.url ?? 'HTTPS endpoint'}>
        <input className={cls('formFieldInput', 'atlas-input')} type="url" placeholder="https://example.com/hooks/atlas" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <OneTimeSecret value={secret} note={labels.copyNow ?? 'Copy the signing secret now — it will not be shown again.'} />
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        disabled={!url.trim()}
        onClick={() => void admin.act(() => organizationAdmin.createWebhook(client, organization.id, { url: url.trim() })).then((r) => { if (r) { setUrl(''); setSecret(r.secret); } })}
      >
        {labels.add ?? 'Add endpoint'}
      </button>
    </Section>
  );
}

interface AppWebhooksData {
  endpoints: OrganizationWebhookEndpoint[];
  types: OrganizationAppEventType[];
}

const loadAppWebhooks = async (c: FapiClient, org: string): Promise<AppWebhooksData> => {
  const [endpoints, types] = await Promise.all([organizationAdmin.listAppWebhooks(c, org), organizationAdmin.listAppEventTypes(c, org)]);
  return { endpoints, types };
};

/**
 * `<AppWebhookEndpoints/>` — the drop-in portal where your customer's admins
 * register endpoints for YOUR app's events (published with `POST /v1/app_events`):
 * add or edit an endpoint with an event-type picker from your catalog, reveal or
 * rotate its `whsec_` secret, send a signed test, read the delivery log,
 * redeliver one delivery, and re-enable plus replay an endpoint that was
 * auto-disabled. Needs `org:webhooks:manage` (or the admin role) in the active
 * organization; renders nothing otherwise.
 */
export function AppWebhookEndpoints({ labels = {} }: { labels?: Labels } = {}) {
  const admin = useAdminData<AppWebhooksData>(loadAppWebhooks);
  const client = useMeClient();
  const { organization } = useOrganization();
  const cls = useClasses();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<OrganizationWebhookDelivery[]>([]);
  if (!organization) return null;
  const org = organization.id;
  const types = admin.data?.types ?? [];
  const button = cls('formButtonSecondary', 'atlas-button-secondary');

  const showDeliveries = async (endpointId: string) => {
    if (open === endpointId) return setOpen(null);
    const rows = await admin.act(() => organizationAdmin.appWebhookDeliveries(client, org, endpointId));
    setDeliveries(rows ?? []);
    setOpen(endpointId);
  };
  const toggle = (type: string) => setPicked((p) => (p.includes(type) ? p.filter((t) => t !== type) : [...p, type]));

  return (
    <Section name="app-webhook-endpoints" title={labels.title ?? 'Webhooks'} admin={admin}>
      {notice ? (
        <p className={cls('text', 'atlas-text')} role="status">
          {notice}
        </p>
      ) : null}
      <ul className={cls('list', 'atlas-list')}>
        {admin.data?.endpoints.map((w) => (
          <li key={w.id} className={cls('listItem', 'atlas-audit-item')} data-health={w.health}>
            <div>
              <strong>{w.url}</strong> — {w.health === 'disabled' ? (labels.disabled ?? 'disabled after repeated failures') : w.health}
              {w.description ? <small> {w.description}</small> : null}
              <small> {w.enabled_events.includes('*') ? (labels.allEvents ?? 'All events') : w.enabled_events.join(', ')}</small>
            </div>
            <button
              type="button"
              className={button}
              onClick={() =>
                void admin
                  .act(() => organizationAdmin.testAppWebhook(client, org, w.id))
                  .then((r) => r && setNotice(r.status === 'success' ? (labels.testOk ?? `Test delivered (HTTP ${r.http_status}).`) : `${labels.testFailed ?? 'Test failed'}: ${r.error ?? `HTTP ${r.http_status}`}`))
              }
            >
              {labels.test ?? 'Send test'}
            </button>
            {w.active ? (
              <button type="button" className={button} onClick={() => void admin.act(() => organizationAdmin.updateAppWebhook(client, org, w.id, { active: false }))}>
                {labels.pause ?? 'Pause'}
              </button>
            ) : (
              <button
                type="button"
                className={button}
                onClick={() =>
                  void admin
                    .act(async () => {
                      await organizationAdmin.updateAppWebhook(client, org, w.id, { active: true });
                      // Re-send what it missed while failing or disabled; nothing when it never failed.
                      return w.health === 'healthy' ? null : organizationAdmin.replayAppWebhook(client, org, w.id);
                    })
                    .then((r) => r && setNotice(`${labels.replayed ?? 'Re-enabled; events queued again'}: ${r.queued}`))
                }
              >
                {labels.enable ?? 'Enable'}
              </button>
            )}
            <button type="button" className={button} onClick={() => void admin.act(() => organizationAdmin.revealAppWebhookSecret(client, org, w.id)).then((r) => r && setSecret(r.secret))}>
              {labels.reveal ?? 'Reveal secret'}
            </button>
            <button type="button" className={button} onClick={() => void admin.act(() => organizationAdmin.rotateAppWebhookSecret(client, org, w.id)).then((r) => r && setSecret(r.secret))}>
              {labels.rotate ?? 'Rotate secret'}
            </button>
            <button type="button" className={button} aria-expanded={open === w.id} onClick={() => void showDeliveries(w.id)}>
              {labels.deliveries ?? 'Deliveries'}
            </button>
            <button type="button" className={button} onClick={() => void admin.act(() => organizationAdmin.deleteAppWebhook(client, org, w.id))}>
              {labels.remove ?? 'Remove'}
            </button>
            {open === w.id ? (
              <ul className={cls('list', 'atlas-list')} data-atlas="app-webhook-deliveries">
                {deliveries.length === 0 ? <li className={cls('text', 'atlas-text')}>{labels.noDeliveries ?? 'No deliveries yet.'}</li> : null}
                {deliveries.map((d) => (
                  <li key={d.id} className={cls('listItem', 'atlas-audit-item')} data-status={d.status}>
                    {d.event_type ?? '—'} · {d.status}
                    {d.http_status ? ` · HTTP ${d.http_status}` : ''} · {new Date(d.created_at).toLocaleString()}
                    <button
                      type="button"
                      className={button}
                      onClick={() =>
                        void admin
                          .act(() => organizationAdmin.redeliverAppWebhook(client, org, w.id, d.id))
                          .then((r) => r && setNotice(labels.redelivered ?? 'Queued for redelivery.'))
                      }
                    >
                      {labels.redeliver ?? 'Redeliver'}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <OneTimeSecret value={secret} note={labels.copyNow ?? 'Copy the signing secret (whsec_…) now and store it with your receiver.'} />
      <Field label={labels.url ?? 'HTTPS endpoint'}>
        <input className={cls('formFieldInput', 'atlas-input')} type="url" placeholder="https://example.com/webhooks" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label={labels.description ?? 'Description'}>
        <input className={cls('formFieldInput', 'atlas-input')} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <fieldset className={cls('formField', 'atlas-field')} data-atlas="app-event-picker">
        <legend className={cls('formFieldLabel', 'atlas-field-label')}>{labels.events ?? 'Events (none selected = all)'}</legend>
        {types.map((t) => (
          <label key={t.id} className={cls('text', 'atlas-text')}>
            <input type="checkbox" checked={picked.includes(t.type)} onChange={() => toggle(t.type)} /> {t.type}
            {t.description ? <small> — {t.description}</small> : null}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        className={cls('formButtonPrimary', 'atlas-button')}
        disabled={!url.trim()}
        onClick={() =>
          void admin
            .act(() =>
              organizationAdmin.createAppWebhook(client, org, {
                url: url.trim(),
                enabled_events: picked.length ? picked : ['*'],
                ...(description.trim() ? { description: description.trim() } : {}),
              }),
            )
            .then((r) => {
              if (r) {
                setUrl('');
                setDescription('');
                setPicked([]);
                setSecret(r.secret);
              }
            })
        }
      >
        {labels.add ?? 'Add endpoint'}
      </button>
    </Section>
  );
}
