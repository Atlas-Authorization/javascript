import { computed, defineComponent, h, ref, type PropType, type VNode } from 'vue';
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
  type CreatedUserApiKey,
  type ReverificationLabels,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { classFor, type ElementKey } from './appearance';
import { useApiKeys } from './managed-components';

/**
 * `<ApiKeys/>` — the signed-in user's own API keys (or, with `organizationId`, the active organization's): list,
 * create (with the "confirm it's you" prompt when the session is stale), the new secret shown once with a copy
 * button, rename, and revoke with a confirmation. Claim fields the application allows render as plain inputs.
 * Emits `create` with the new key.
 */
export const ApiKeys = defineComponent({
  name: 'ApiKeys',
  props: {
    organizationId: { type: String, default: undefined },
    /** Expiry choices offered, in days. `0` means never. */
    expiryOptionsDays: { type: Array as PropType<number[]>, default: () => [0, 30, 90, 365] },
    labels: { type: Object as PropType<ApiKeysLabels & { reverification?: ReverificationLabels }>, default: () => ({}) },
  },
  emits: { create: (_key: CreatedUserApiKey) => true },
  setup(props, { emit }) {
    const atlas = useAtlas();
    const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
    const { state, controller } = useApiKeys({ organizationId: props.organizationId });
    const L = computed(() => ({ ...API_KEYS_LABELS, ...props.labels }));
    const R = computed(() => ({ ...REVERIFICATION_LABELS, ...props.labels.reverification }));

    const creating = ref(false);
    const draft = ref({ name: '', expiryDays: props.expiryOptionsDays[0] ?? 0, scopes: [] as string[], claims: {} as Record<string, string> });
    const copied = ref(false);
    const renaming = ref<{ id: string; name: string } | null>(null);
    const confirmRevoke = ref<string | null>(null);
    const password = ref('');
    const reauthError = ref<string | null>(null);

    const reset = () => {
      creating.value = false;
      draft.value = { name: '', expiryDays: props.expiryOptionsDays[0] ?? 0, scopes: [], claims: {} };
    };
    const submit = async () => {
      const created = await controller.createKey(apiKeyInputFromDraft(draft.value));
      if (created) {
        copied.value = false;
        reset();
        emit('create', created);
      }
    };
    const confirmIdentity = async () => {
      reauthError.value = null;
      try {
        await controller.completeReverification(password.value);
        password.value = '';
      } catch (e) {
        reauthError.value = e instanceof Error ? e.message : 'Re-authentication failed.';
      }
    };
    const copy = async () => {
      try {
        await navigator.clipboard?.writeText(state.value.secret ?? '');
        copied.value = true;
      } catch {
        /* the secret stays visible for manual copy */
      }
    };
    const button = (label: string, onClick: () => void, key: ElementKey = 'formButtonSecondary', extra: Record<string, unknown> = {}) =>
      h('button', { type: 'button', class: key === 'formButtonPrimary' ? cls(key, 'atlas-button') : cls(key, 'atlas-button-secondary'), onClick, ...extra }, label);
    const input = (props2: Record<string, unknown>) => h('input', { class: cls('formFieldInput', 'atlas-account-input'), ...props2 });

    return () => {
      const s = state.value;
      const l = L.value;
      if (s.status === 'loading') return null;
      const section = (children: Array<VNode | null>) =>
        h('section', { class: cls('card', 'atlas-card'), 'data-atlas': 'api-keys' }, [h('h2', { class: 'atlas-section-title' }, l.title), ...children]);
      if (s.status === 'disabled') return section([h('p', { class: cls('text', 'atlas-text'), 'data-atlas': 'api-keys-disabled' }, l.disabled)]);

      const scopeModel = scopePickerModel(s.allowedScopes, s.scopeImplications, draft.value.scopes);
      const scopeBox = (b: { scope: string; checked: boolean; locked: boolean } | null) =>
        b
          ? h('input', {
              type: 'checkbox',
              'aria-label': b.scope,
              'data-atlas-scope': b.scope,
              checked: b.checked,
              disabled: b.locked,
              onChange: (e: Event) => {
                draft.value = { ...draft.value, scopes: toggleScope(draft.value.scopes, b.scope, (e.target as HTMLInputElement).checked) };
              },
            })
          : null;

      return section([
        h('p', { class: cls('text', 'atlas-text') }, props.organizationId ? l.organizationSubtitle : l.subtitle),
        s.status === 'error' && s.error ? h('p', { class: 'atlas-alert', role: 'alert' }, s.error) : null,

        s.secret
          ? h('div', { 'data-atlas': 'api-key-secret', role: 'status' }, [
              h('p', h('strong', l.secretTitle)),
              h('p', l.secretHint),
              h('code', { 'data-atlas': 'api-key-secret-value' }, s.secret),
              button(copied.value ? l.copied : l.copy, () => void copy()),
              button(l.done, () => controller.dismissSecret()),
            ])
          : null,

        s.needsReverification
          ? h('div', { 'data-atlas': 'api-keys-reverification', role: 'dialog', 'aria-label': R.value.title }, [
              h('p', h('strong', R.value.title)),
              h('p', R.value.subtitle),
              h('label', { class: cls('formField', 'atlas-field') }, [
                h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, R.value.passwordLabel),
                input({ type: 'password', autocomplete: 'current-password', value: password.value, onInput: (e: Event) => (password.value = (e.target as HTMLInputElement).value) }),
              ]),
              reauthError.value ? h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert' }, reauthError.value) : null,
              button(R.value.submit, () => void confirmIdentity(), 'formButtonPrimary'),
              button(R.value.cancel, () => {
                password.value = '';
                reauthError.value = null;
                controller.cancelReverification();
              }),
            ])
          : null,

        s.keys.length === 0
          ? h('p', { class: cls('text', 'atlas-text'), 'data-atlas': 'api-keys-empty' }, l.empty)
          : h(
              'ul',
              { class: cls('list', 'atlas-list'), 'data-atlas': 'api-keys-list' },
              s.keys.map((key) => {
                const st = apiKeyStatus(key);
                const limits = key.limits && typeof key.limits === 'object' ? Object.entries(key.limits) : [];
                const editing = renaming.value?.id === key.id;
                return h('li', { key: key.id, class: cls('listItem', 'atlas-list-item'), 'data-atlas': 'api-key' }, [
                  editing
                    ? h('span', [
                        input({ 'aria-label': l.nameLabel, value: renaming.value!.name, onInput: (e: Event) => (renaming.value = { id: key.id, name: (e.target as HTMLInputElement).value }) }),
                        button(l.save, () => void controller.renameKey(key.id, renaming.value!.name.trim() || null).then((ok) => ok && (renaming.value = null)), 'formButtonSecondary', { disabled: s.busy }),
                        button(l.cancel, () => (renaming.value = null)),
                      ])
                    : h('strong', key.name ?? l.unnamed),
                  ' ',
                  h('code', `${key.prefix}…`),
                  st !== 'active' ? h('em', ` — ${st === 'revoked' ? l.revoked : l.expired}`) : null,
                  h(
                    'div',
                    { class: cls('text', 'atlas-text') },
                    [
                      key.last_used_at ? formatLabel(l.lastUsed, { date: new Date(key.last_used_at).toLocaleDateString() }) : l.neverUsed,
                      key.expires_at ? formatLabel(l.expiresOn, { date: new Date(key.expires_at).toLocaleDateString() }) : null,
                      key.scopes && key.scopes.length > 0 ? key.scopes.join(', ') : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                  limits.length > 0
                    ? h('div', { class: cls('text', 'atlas-text'), 'data-atlas': 'api-key-limits' }, `${l.limits}: ${limits.map(([k, v]) => `${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}`).join(' · ')}`)
                    : null,
                  !key.revoked_at && !editing
                    ? confirmRevoke.value === key.id
                      ? h('span', { 'data-atlas': 'api-key-revoke-confirm' }, [
                          h('span', l.revokeConfirm),
                          button(l.revokeConfirmButton, () => void controller.revokeKey(key.id).then((ok) => ok && (confirmRevoke.value = null)), 'formButtonSecondary', { disabled: s.busy }),
                          button(l.cancel, () => (confirmRevoke.value = null)),
                        ])
                      : h('span', [button(l.rename, () => (renaming.value = { id: key.id, name: key.name ?? '' })), button(l.revoke, () => (confirmRevoke.value = key.id))])
                    : null,
                ]);
              }),
            ),

        s.actionError ? h('p', { class: 'atlas-alert', role: 'alert' }, s.actionError) : null,

        creating.value
          ? h('div', { 'data-atlas': 'api-key-create' }, [
              h('label', { class: cls('formField', 'atlas-field') }, [
                h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, l.nameLabel),
                input({ value: draft.value.name, maxlength: 100, placeholder: l.namePlaceholder, onInput: (e: Event) => (draft.value = { ...draft.value, name: (e.target as HTMLInputElement).value }) }),
              ]),
              h('label', { class: cls('formField', 'atlas-field') }, [
                h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, l.expiresLabel),
                h(
                  'select',
                  { class: cls('formFieldInput', 'atlas-account-input'), value: String(draft.value.expiryDays), onChange: (e: Event) => (draft.value = { ...draft.value, expiryDays: Number((e.target as HTMLSelectElement).value) }) },
                  props.expiryOptionsDays.map((d) => h('option', { key: d, value: String(d) }, d > 0 ? formatLabel(l.expiresDays, { days: d }) : l.expiresNever)),
                ),
              ]),
              s.allowedScopes.length > 0
                ? h('fieldset', { class: cls('formField', 'atlas-field') }, [
                    h('legend', { class: cls('formFieldLabel', 'atlas-field-label') }, l.scopesLabel),
                    scopeModel.rows.length
                      ? h('table', { 'data-atlas': 'api-key-scope-grid' }, [
                          h('thead', h('tr', [h('th', { scope: 'col' }), h('th', { scope: 'col' }, 'read'), h('th', { scope: 'col' }, 'write')])),
                          h('tbody', scopeModel.rows.map((r) => h('tr', { key: r.resource }, [h('th', { scope: 'row' }, r.resource), h('td', [scopeBox(r.read)]), h('td', [scopeBox(r.write)])]))),
                        ])
                      : null,
                    ...scopeModel.other.map((b) => h('label', { key: b.scope }, [scopeBox(b), ` ${b.scope}`])),
                  ])
                : null,
              ...s.allowedClaims.map((name) =>
                h('label', { key: name, class: cls('formField', 'atlas-field') }, [
                  h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, name),
                  input({ 'data-atlas-claim': name, value: draft.value.claims[name] ?? '', onInput: (e: Event) => (draft.value = { ...draft.value, claims: { ...draft.value.claims, [name]: (e.target as HTMLInputElement).value } }) }),
                ]),
              ),
              button(l.submit, () => void submit(), 'formButtonPrimary', { disabled: s.busy }),
              button(l.cancel, reset),
            ])
          : apiKeysAtCap(s)
            ? h('p', { class: cls('text', 'atlas-text'), 'data-atlas': 'api-keys-limit' }, formatLabel(l.limitReached, { max: s.maxActiveKeys }))
            : button(l.create, () => (creating.value = true), 'formButtonPrimary'),
      ]);
    };
  },
});
