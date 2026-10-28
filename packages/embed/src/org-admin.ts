import { organizationAdmin as api, type FapiClient } from '@atlasauth/js';
import { createClient } from './client';
import { getScriptDefaults } from './config';
import type { MountTarget } from './mount';

/** The tenant-admin sections the embed can mount for an organization. */
export type OrgAdminSection = 'sso' | 'directory' | 'domains' | 'logStreams' | 'apiKeys' | 'ipAllowlist' | 'webhooks';

export interface OrgAdminOptions {
  section: OrgAdminSection;
  /** The organization to manage; the signed-in user must be an admin of it (the active one). */
  organizationId: string;
  publishableKey?: string;
  frontendApi?: string;
  locale?: string;
  fetchImpl?: typeof fetch;
}

type El = HTMLElement;
const h = (tag: string, props: Record<string, string> = {}, ...kids: Array<El | string | null>): El => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  for (const kid of kids) if (kid !== null) node.append(kid);
  return node;
};

/** A column of plain-text rows with a trailing action button per row. */
function rows(items: Array<{ id: string; text: string }>, action: string, run: (id: string) => Promise<unknown>): El {
  const list = h('ul', { class: 'atlas-list' });
  for (const item of items) {
    const li = h('li', { 'data-id': item.id }, item.text);
    const btn = h('button', { type: 'button', class: 'atlas-button-secondary' }, action);
    btn.addEventListener('click', () => void run(item.id));
    li.append(' ', btn);
    list.append(li);
  }
  return list;
}

/**
 * Mount one tenant-admin section (SSO, directory sync, domains, log streams, API
 * keys, sign-in IP allowlist or webhooks) into an element. Plain DOM, no
 * framework: it re-renders itself after every change, shows a secret the server
 * returns once exactly once, and renders nothing for a caller the server refuses
 * (not an admin, or not the active organization).
 */
export function mountOrganizationAdmin(target: MountTarget, options: OrgAdminOptions): { destroy(): void } | null {
  const host = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : (target as HTMLElement);
  const defaults = getScriptDefaults();
  const publishableKey = options.publishableKey ?? defaults.publishableKey;
  const frontendApi = options.frontendApi ?? defaults.frontendApi;
  if (!host) return null;
  if (!publishableKey || !frontendApi) {
    host.textContent = 'Atlas: a publishable key and a frontend API origin are required.';
    return null;
  }
  const client: FapiClient = createClient({ publishableKey, frontendApi, locale: options.locale ?? defaults.locale, fetchImpl: options.fetchImpl });
  const org = options.organizationId;
  let secret: string | null = null;
  let message: string | null = null;
  let alive = true;

  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      message = null;
    } catch (err) {
      message = err instanceof Error ? err.message : 'The request failed.';
    }
    await render();
  };
  const withSecret = (fn: () => Promise<{ secret?: string; token?: string }>) =>
    guarded(async () => {
      const out = await fn();
      secret = out.secret ?? out.token ?? null;
    });

  const input = (label: string, type = 'text', placeholder = ''): [El, HTMLInputElement] => {
    const field = h('input', { type, placeholder, 'aria-label': label });
    return [h('label', { class: 'atlas-field' }, h('span', {}, label), field), field as HTMLInputElement];
  };
  const button = (label: string, run: () => void, primary = true): El => {
    const b = h('button', { type: 'button', class: primary ? 'atlas-button' : 'atlas-button-secondary' }, label);
    b.addEventListener('click', run);
    return b;
  };

  async function body(): Promise<El[]> {
    switch (options.section) {
      case 'domains': {
        const list = await api.listDomains(client, org);
        const [label, field] = input('Email domain', 'text', 'acme.com');
        return [
          rows(
            list.map((d) => ({ id: d.id, text: `${d.domain} — ${d.status}${d.status === 'verified' ? '' : ` (TXT ${d.verification.record_name} = ${d.verification.record_value})`}` })),
            'Remove',
            (id) => guarded(() => api.removeDomain(client, org, id)),
          ),
          ...list.filter((d) => d.status !== 'verified').map((d) => button(`Verify ${d.domain}`, () => void guarded(() => api.verifyDomain(client, org, d.id)), false)),
          label,
          button('Add domain', () => void guarded(() => api.addDomain(client, org, field.value.trim()))),
        ];
      }
      case 'logStreams': {
        const list = await api.listLogStreams(client, org);
        const [label, field] = input('HTTPS endpoint', 'url', 'https://siem.example.com/ingest');
        return [
          rows(list.map((s) => ({ id: s.id, text: s.url })), 'Remove', (id) => guarded(() => api.removeLogStream(client, org, id))),
          label,
          button('Add destination', () => void withSecret(() => api.addLogStream(client, org, { url: field.value.trim() }))),
        ];
      }
      case 'apiKeys': {
        const list = await api.listApiKeys(client, org);
        const [label, field] = input('Key name');
        return [
          rows(list.map((k) => ({ id: k.id, text: `${k.name ?? k.prefix} (${k.prefix})` })), 'Revoke', (id) => guarded(() => api.revokeApiKey(client, org, id))),
          label,
          button('Create key', () => void withSecret(() => api.createApiKey(client, org, { name: field.value.trim() || undefined }))),
        ];
      }
      case 'webhooks': {
        const list = await api.listWebhooks(client, org);
        const [label, field] = input('HTTPS endpoint', 'url', 'https://example.com/hooks/atlas');
        return [
          rows(list.map((w) => ({ id: w.id, text: `${w.url} — ${w.health}` })), 'Remove', (id) => guarded(() => api.deleteWebhook(client, org, id))),
          label,
          button('Add endpoint', () => void withSecret(() => api.createWebhook(client, org, { url: field.value.trim() }))),
        ];
      }
      case 'directory': {
        const dir = await api.getDirectory(client, org);
        return [
          h('p', {}, `SCIM base URL: ${dir.base_url}`),
          rows(dir.tokens.map((t) => ({ id: t.id, text: t.prefix })), 'Revoke', (id) => guarded(() => api.revokeDirectoryToken(client, org, id))),
          button('Generate token', () => void withSecret(() => api.createDirectoryToken(client, org))),
        ];
      }
      case 'ipAllowlist': {
        const list = await api.getIpAllowlist(client, org);
        const area = h('textarea', { rows: '5', 'aria-label': 'Sign-in IP allowlist' }) as HTMLTextAreaElement;
        area.value = list.entries.join('\n');
        return [
          h('p', {}, `One IP or CIDR per line; empty allows anywhere. Your IP: ${list.your_ip}`),
          area,
          button('Save', () => void guarded(() => api.setIpAllowlist(client, org, area.value.split(/[\s,]+/).filter(Boolean)))),
        ];
      }
      case 'sso': {
        const view = await api.getSso(client, org);
        const type = view.connection?.type ?? 'oidc';
        const fields: Array<[string, string, string]> =
          type === 'oidc'
            ? [['oidc_issuer', 'Issuer URL', 'text'], ['oidc_client_id', 'Client ID', 'text'], ['oidc_client_secret', 'Client secret', 'password']]
            : [['saml_metadata_xml', 'IdP metadata XML', 'text'], ['saml_idp_certificate', 'IdP certificate (PEM)', 'text']];
        const inputs = fields.map(([key, label, kind]) => {
          const [l, f] = input(label, kind);
          return { key, l, f };
        });
        return [
          h('p', {}, view.connection ? `${view.connection.type.toUpperCase()} — ${view.connection.status}` : 'No connection yet.'),
          h('p', {}, `ACS URL: ${view.sp.acs_url} · Redirect URI: ${view.sp.oidc_redirect_uri}`),
          ...inputs.map((i) => i.l),
          button('Save connection', () => {
            const payload: Record<string, string> = {};
            for (const i of inputs) if (i.f.value) payload[i.key] = i.f.value;
            void guarded(() => api.saveSso(client, org, { type, ...payload }));
          }),
        ];
      }
    }
  }

  async function render() {
    if (!alive) return;
    let children: El[];
    try {
      children = await body();
    } catch (err) {
      // 403/404 → the server says this caller may not manage the organization: show nothing.
      const status = (err as { status?: number }).status;
      host!.replaceChildren(...(status === 403 || status === 404 ? [] : [h('p', { role: 'alert' }, err instanceof Error ? err.message : 'The request failed.')]));
      return;
    }
    const extra: El[] = [];
    if (message) extra.push(h('p', { role: 'alert' }, message));
    if (secret) extra.push(h('p', { 'data-atlas': 'one-time-secret' }, 'Copy this now — it will not be shown again: ', h('code', {}, secret)));
    host!.dataset.atlas = `organization-admin-${options.section}`;
    host!.replaceChildren(...extra, ...children);
  }

  void render();
  return {
    destroy() {
      alive = false;
      host.replaceChildren();
    },
  };
}
