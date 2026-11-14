import { createSignal, type JSX } from 'solid-js';
import {
  API_KEYS_LABELS,
  REVERIFICATION_LABELS,
  apiKeyInputFromDraft,
  apiKeyStatus,
  apiKeysAtCap,
  formatLabel,
  scopePickerModel,
  toggleScope,
  type ApiKeysLabels,
  type ApiKeyDraft,
  type CreatedUserApiKey,
  type ReverificationLabels,
} from '@atlasauth/js';
import { h } from './h';
import { createApiKeys } from './managed';

export interface ApiKeysProps {
  /** Manage this (active) organization's keys instead of the user's own. */
  organizationId?: string;
  /** Expiry choices offered, in days. `0` means never. Default `[0, 30, 90, 365]`. */
  expiryOptionsDays?: number[];
  labels?: ApiKeysLabels & { reverification?: ReverificationLabels };
  /** Called with the newly created key (including its one-time `secret`). */
  onCreate?: (key: CreatedUserApiKey) => void;
}

/**
 * `<ApiKeys/>` — the signed-in user's own API keys (or, with `organizationId`, the active organization's): list,
 * create (with the "confirm it's you" prompt when the session is stale), the new secret shown once with a copy
 * button, rename, and revoke with a confirmation. Claim fields the application allows render as plain inputs.
 */
export function ApiKeys(props: ApiKeysProps = {}): JSX.Element {
  const { state, controller } = createApiKeys({ organizationId: props.organizationId });
  const options = props.expiryOptionsDays ?? [0, 30, 90, 365];
  const blank = (): ApiKeyDraft => ({ name: '', expiryDays: options[0] ?? 0, scopes: [], claims: {} });
  const [creating, setCreating] = createSignal(false);
  const [draft, setDraft] = createSignal<ApiKeyDraft>(blank());
  const [copied, setCopied] = createSignal(false);
  const [renaming, setRenaming] = createSignal<{ id: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal('');
  const [reauthError, setReauthError] = createSignal<string | null>(null);

  const reset = () => {
    setCreating(false);
    setDraft(blank());
  };
  const submit = async () => {
    const created = await controller.createKey(apiKeyInputFromDraft(draft()));
    if (created) {
      setCopied(false);
      reset();
      props.onCreate?.(created);
    }
  };
  const confirmIdentity = async () => {
    setReauthError(null);
    try {
      await controller.completeReverification(password());
      setPassword('');
    } catch (e) {
      setReauthError(e instanceof Error ? e.message : 'Re-authentication failed.');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(state().secret ?? '');
      setCopied(true);
    } catch {
      /* the secret stays visible for manual copy */
    }
  };
  const secondary = 'atlas-button-secondary';
  const button = (label: string, onClick: () => void, cls = secondary, extra: Record<string, unknown> = {}) => h('button', { type: 'button', class: cls, onClick, ...extra }, label);
  const input = (p: Record<string, unknown>) => h('input', { class: 'atlas-account-input', ...p });

  return (() => {
    const s = state();
    const l = { ...API_KEYS_LABELS, ...props.labels };
    const r = { ...REVERIFICATION_LABELS, ...props.labels?.reverification };
    if (s.status === 'loading') return null;
    const section = (...children: unknown[]) => h('section', { class: 'atlas-card', 'data-atlas': 'api-keys' }, [h('h2', { class: 'atlas-section-title' }, l.title), ...children]);
    if (s.status === 'disabled') return section(h('p', { class: 'atlas-text', 'data-atlas': 'api-keys-disabled' }, l.disabled));

    const model = scopePickerModel(s.allowedScopes, s.scopeImplications, draft().scopes);
    const box = (b: { scope: string; checked: boolean; locked: boolean } | null) =>
      b
        ? h('input', { type: 'checkbox', 'aria-label': b.scope, 'data-atlas-scope': b.scope, checked: b.checked, disabled: b.locked, onChange: (e: Event) => setDraft({ ...draft(), scopes: toggleScope(draft().scopes, b.scope, (e.target as HTMLInputElement).checked) }) })
        : null;

    return section(
      h('p', { class: 'atlas-text' }, props.organizationId ? l.organizationSubtitle : l.subtitle),
      s.status === 'error' && s.error ? h('p', { class: 'atlas-alert', role: 'alert' }, s.error) : null,
      s.secret
        ? h('div', { 'data-atlas': 'api-key-secret', role: 'status' }, [
            h('p', h('strong', l.secretTitle)),
            h('p', l.secretHint),
            h('code', { 'data-atlas': 'api-key-secret-value' }, s.secret),
            button(copied() ? l.copied : l.copy, () => void copy()),
            button(l.done, () => controller.dismissSecret()),
          ])
        : null,
      s.needsReverification
        ? h('div', { 'data-atlas': 'api-keys-reverification', role: 'dialog', 'aria-label': r.title }, [
            h('p', h('strong', r.title)),
            h('p', r.subtitle),
            h('label', { class: 'atlas-field' }, [h('span', { class: 'atlas-field-label' }, r.passwordLabel), input({ type: 'password', autocomplete: 'current-password', value: password(), onInput: (e: Event) => setPassword((e.target as HTMLInputElement).value) })]),
            reauthError() ? h('p', { class: 'atlas-error', role: 'alert' }, reauthError()) : null,
            button(r.submit, () => void confirmIdentity(), 'atlas-button'),
            button(r.cancel, () => {
              setPassword('');
              setReauthError(null);
              controller.cancelReverification();
            }),
          ])
        : null,
      s.keys.length === 0
        ? h('p', { class: 'atlas-text', 'data-atlas': 'api-keys-empty' }, l.empty)
        : h(
            'ul',
            { class: 'atlas-list', 'data-atlas': 'api-keys-list' },
            s.keys.map((key) => {
              const st = apiKeyStatus(key);
              const limits = key.limits && typeof key.limits === 'object' ? Object.entries(key.limits) : [];
              const editing = renaming()?.id === key.id;
              return h('li', { class: 'atlas-list-item', 'data-atlas': 'api-key' }, [
                editing
                  ? h('span', [
                      input({ 'aria-label': l.nameLabel, value: renaming()!.name, onInput: (e: Event) => setRenaming({ id: key.id, name: (e.target as HTMLInputElement).value }) }),
                      button(l.save, () => void controller.renameKey(key.id, renaming()!.name.trim() || null).then((ok) => ok && setRenaming(null)), secondary, { disabled: s.busy }),
                      button(l.cancel, () => setRenaming(null)),
                    ])
                  : h('strong', key.name ?? l.unnamed),
                ' ',
                h('code', `${key.prefix}…`),
                st !== 'active' ? h('em', ` — ${st === 'revoked' ? l.revoked : l.expired}`) : null,
                h(
                  'div',
                  { class: 'atlas-text' },
                  [
                    key.last_used_at ? formatLabel(l.lastUsed, { date: new Date(key.last_used_at).toLocaleDateString() }) : l.neverUsed,
                    key.expires_at ? formatLabel(l.expiresOn, { date: new Date(key.expires_at).toLocaleDateString() }) : null,
                    key.scopes && key.scopes.length > 0 ? key.scopes.join(', ') : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
                limits.length > 0 ? h('div', { class: 'atlas-text', 'data-atlas': 'api-key-limits' }, `${l.limits}: ${limits.map(([k, v]) => `${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}`).join(' · ')}`) : null,
                !key.revoked_at && !editing
                  ? confirmRevoke() === key.id
                    ? h('span', { 'data-atlas': 'api-key-revoke-confirm' }, [
                        h('span', l.revokeConfirm),
                        button(l.revokeConfirmButton, () => void controller.revokeKey(key.id).then((ok) => ok && setConfirmRevoke(null)), secondary, { disabled: s.busy }),
                        button(l.cancel, () => setConfirmRevoke(null)),
                      ])
                    : h('span', [button(l.rename, () => setRenaming({ id: key.id, name: key.name ?? '' })), button(l.revoke, () => setConfirmRevoke(key.id))])
                  : null,
              ]);
            }),
          ),
      s.actionError ? h('p', { class: 'atlas-alert', role: 'alert' }, s.actionError) : null,
      creating()
        ? h('div', { 'data-atlas': 'api-key-create' }, [
            h('label', { class: 'atlas-field' }, [h('span', { class: 'atlas-field-label' }, l.nameLabel), input({ value: draft().name, maxlength: 100, placeholder: l.namePlaceholder, onInput: (e: Event) => setDraft({ ...draft(), name: (e.target as HTMLInputElement).value }) })]),
            h('label', { class: 'atlas-field' }, [
              h('span', { class: 'atlas-field-label' }, l.expiresLabel),
              h(
                'select',
                { class: 'atlas-account-input', value: String(draft().expiryDays), onChange: (e: Event) => setDraft({ ...draft(), expiryDays: Number((e.target as HTMLSelectElement).value) }) },
                options.map((d) => h('option', { value: String(d) }, d > 0 ? formatLabel(l.expiresDays, { days: d }) : l.expiresNever)),
              ),
            ]),
            s.allowedScopes.length > 0
              ? h('fieldset', { class: 'atlas-field' }, [
                  h('legend', { class: 'atlas-field-label' }, l.scopesLabel),
                  model.rows.length
                    ? h('table', { 'data-atlas': 'api-key-scope-grid' }, [
                        h('thead', h('tr', [h('th', { scope: 'col' }), h('th', { scope: 'col' }, 'read'), h('th', { scope: 'col' }, 'write')])),
                        h('tbody', model.rows.map((row) => h('tr', [h('th', { scope: 'row' }, row.resource), h('td', box(row.read)), h('td', box(row.write))]))),
                      ])
                    : null,
                  ...model.other.map((b) => h('label', [box(b), ` ${b.scope}`])),
                ])
              : null,
            ...s.allowedClaims.map((name) =>
              h('label', { class: 'atlas-field' }, [h('span', { class: 'atlas-field-label' }, name), input({ 'data-atlas-claim': name, value: draft().claims[name] ?? '', onInput: (e: Event) => setDraft({ ...draft(), claims: { ...draft().claims, [name]: (e.target as HTMLInputElement).value } }) })]),
            ),
            button(l.submit, () => void submit(), 'atlas-button', { disabled: s.busy }),
            button(l.cancel, reset),
          ])
        : apiKeysAtCap(s)
          ? h('p', { class: 'atlas-text', 'data-atlas': 'api-keys-limit' }, formatLabel(l.limitReached, { max: s.maxActiveKeys }))
          : button(l.create, () => setCreating(true), 'atlas-button'),
    );
  }) as unknown as JSX.Element;
}
