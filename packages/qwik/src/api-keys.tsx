import { component$, noSerialize, useSignal, useStore, useVisibleTask$, type NoSerialize, type PropFunction } from '@builder.io/qwik';
import {
  API_KEYS_LABELS,
  ApiKeysController,
  REVERIFICATION_LABELS,
  apiKeyInputFromDraft,
  apiKeyStatus,
  apiKeysAtCap,
  formatLabel,
  scopePickerModel,
  toggleScope,
  type ApiKeysLabels,
  type ApiKeysState,
  type CreatedUserApiKey,
  type ReverificationLabels,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { meClients } from './managed';

export interface ApiKeysProps {
  /** Manage this (active) organization's keys instead of the user's own. */
  organizationId?: string;
  /** Expiry choices offered, in days. `0` means never. Default `[0, 30, 90, 365]`. */
  expiryOptionsDays?: number[];
  labels?: ApiKeysLabels & { reverification?: ReverificationLabels };
  /** Called with the newly created key (including its one-time `secret`). */
  onCreate$?: PropFunction<(key: CreatedUserApiKey) => void>;
}

const INITIAL: ApiKeysState = {
  status: 'loading', keys: [], allowedScopes: [], allowedClaims: [], scopeImplications: {}, maxActiveKeys: 0, activeCount: 0,
  error: null, actionError: null, busy: false, secret: null, needsReverification: false,
};

/**
 * `<ApiKeys>` — the signed-in user's own API keys (or, with `organizationId`, the active organization's): list,
 * create (with the "confirm it's you" prompt when the session is stale), the new secret shown once with a copy
 * button, rename, and revoke with a confirmation. Claim fields the application allows render as plain inputs.
 * The controller is a live object, so it is held `noSerialize`d and created client-side.
 */
export const ApiKeys = component$<ApiKeysProps>((props) => {
  const store = useAtlas();
  const controller = useSignal<NoSerialize<ApiKeysController>>();
  const snap = useSignal<ApiKeysState>(INITIAL);
  const ui = useStore({ creating: false, name: '', expiryDays: props.expiryOptionsDays?.[0] ?? 0, scopes: [] as string[], claims: {} as Record<string, string>, copied: false, renamingId: '', renamingName: '', confirmRevoke: '', password: '', reauthError: '' });

  // eslint-disable-next-line qwik/no-use-visible-task -- the controller is a live object the optimizer must not resume.
  useVisibleTask$(({ cleanup }) => {
    const { client, reauth } = meClients(store);
    const c = new ApiKeysController(client, reauth, { organizationId: props.organizationId });
    controller.value = noSerialize(c);
    cleanup(c.subscribe((s) => (snap.value = s)));
    void c.load();
  });

  const s = snap.value;
  if (s.status === 'loading') return <>{null}</>;
  const l = { ...API_KEYS_LABELS, ...props.labels };
  const r = { ...REVERIFICATION_LABELS, ...props.labels?.reverification };
  const options = props.expiryOptionsDays ?? [0, 30, 90, 365];
  const reset = () => {
    ui.creating = false;
    ui.name = '';
    ui.expiryDays = options[0] ?? 0;
    ui.scopes = [];
    ui.claims = {};
  };

  if (s.status === 'disabled')
    return (
      <section class="atlas-card" data-atlas="api-keys">
        <h2 class="atlas-section-title">{l.title}</h2>
        <p class="atlas-text" data-atlas="api-keys-disabled">{l.disabled}</p>
      </section>
    );

  const model = scopePickerModel(s.allowedScopes, s.scopeImplications, ui.scopes);
  const box = (b: { scope: string; checked: boolean; locked: boolean } | null) =>
    b ? (
      <input
        type="checkbox"
        aria-label={b.scope}
        data-atlas-scope={b.scope}
        checked={b.checked}
        disabled={b.locked}
        onChange$={(_, el) => (ui.scopes = toggleScope(ui.scopes, b.scope, el.checked))}
      />
    ) : null;

  return (
    <section class="atlas-card" data-atlas="api-keys">
      <h2 class="atlas-section-title">{l.title}</h2>
      <p class="atlas-text">{props.organizationId ? l.organizationSubtitle : l.subtitle}</p>
      {s.status === 'error' && s.error ? <p class="atlas-alert" role="alert">{s.error}</p> : null}

      {s.secret ? (
        <div data-atlas="api-key-secret" role="status">
          <p><strong>{l.secretTitle}</strong></p>
          <p>{l.secretHint}</p>
          <code data-atlas="api-key-secret-value">{s.secret}</code>
          <button
            class="atlas-button-secondary"
            type="button"
            onClick$={async () => {
              try {
                await navigator.clipboard?.writeText(snap.value.secret ?? '');
                ui.copied = true;
              } catch {
                /* the secret stays visible for manual copy */
              }
            }}
          >
            {ui.copied ? l.copied : l.copy}
          </button>
          <button class="atlas-button-secondary" type="button" onClick$={() => controller.value?.dismissSecret()}>{l.done}</button>
        </div>
      ) : null}

      {s.needsReverification ? (
        <div data-atlas="api-keys-reverification" role="dialog" aria-label={r.title}>
          <p><strong>{r.title}</strong></p>
          <p>{r.subtitle}</p>
          <label class="atlas-field">
            <span class="atlas-field-label">{r.passwordLabel}</span>
            <input class="atlas-account-input" type="password" autocomplete="current-password" value={ui.password} onInput$={(_, el) => (ui.password = el.value)} />
          </label>
          {ui.reauthError ? <p class="atlas-error" role="alert">{ui.reauthError}</p> : null}
          <button
            class="atlas-button"
            type="button"
            onClick$={async () => {
              ui.reauthError = '';
              try {
                await controller.value?.completeReverification(ui.password);
                ui.password = '';
              } catch (e) {
                ui.reauthError = e instanceof Error ? e.message : 'Re-authentication failed.';
              }
            }}
          >
            {r.submit}
          </button>
          <button class="atlas-button-secondary" type="button" onClick$={() => { ui.password = ''; ui.reauthError = ''; controller.value?.cancelReverification(); }}>{r.cancel}</button>
        </div>
      ) : null}

      {s.keys.length === 0 ? (
        <p class="atlas-text" data-atlas="api-keys-empty">{l.empty}</p>
      ) : (
        <ul class="atlas-list" data-atlas="api-keys-list">
          {s.keys.map((key) => {
            const st = apiKeyStatus(key);
            const editing = ui.renamingId === key.id;
            const limits = key.limits && typeof key.limits === 'object' ? Object.entries(key.limits) : [];
            return (
              <li class="atlas-list-item" data-atlas="api-key" key={key.id}>
                {editing ? (
                  <span>
                    <input class="atlas-account-input" aria-label={l.nameLabel} value={ui.renamingName} onInput$={(_, el) => (ui.renamingName = el.value)} />
                    <button
                      class="atlas-button-secondary"
                      type="button"
                      disabled={s.busy}
                      onClick$={async () => {
                        if (await controller.value?.renameKey(key.id, ui.renamingName.trim() || null)) ui.renamingId = '';
                      }}
                    >
                      {l.save}
                    </button>
                    <button class="atlas-button-secondary" type="button" onClick$={() => (ui.renamingId = '')}>{l.cancel}</button>
                  </span>
                ) : (
                  <strong>{key.name ?? l.unnamed}</strong>
                )}{' '}
                <code>{key.prefix}…</code>
                {st !== 'active' ? <em> — {st === 'revoked' ? l.revoked : l.expired}</em> : null}
                <div class="atlas-text">
                  {[
                    key.last_used_at ? formatLabel(l.lastUsed, { date: new Date(key.last_used_at).toLocaleDateString() }) : l.neverUsed,
                    key.expires_at ? formatLabel(l.expiresOn, { date: new Date(key.expires_at).toLocaleDateString() }) : null,
                    key.scopes && key.scopes.length > 0 ? key.scopes.join(', ') : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                {limits.length > 0 ? (
                  <div class="atlas-text" data-atlas="api-key-limits">
                    {l.limits}: {limits.map(([k, v]) => `${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}`).join(' · ')}
                  </div>
                ) : null}
                {!key.revoked_at && !editing ? (
                  ui.confirmRevoke === key.id ? (
                    <span data-atlas="api-key-revoke-confirm">
                      <span>{l.revokeConfirm}</span>
                      <button
                        class="atlas-button-secondary"
                        type="button"
                        disabled={s.busy}
                        onClick$={async () => {
                          if (await controller.value?.revokeKey(key.id)) ui.confirmRevoke = '';
                        }}
                      >
                        {l.revokeConfirmButton}
                      </button>
                      <button class="atlas-button-secondary" type="button" onClick$={() => (ui.confirmRevoke = '')}>{l.cancel}</button>
                    </span>
                  ) : (
                    <span>
                      <button class="atlas-button-secondary" type="button" onClick$={() => { ui.renamingId = key.id; ui.renamingName = key.name ?? ''; }}>{l.rename}</button>
                      <button class="atlas-button-secondary" type="button" onClick$={() => (ui.confirmRevoke = key.id)}>{l.revoke}</button>
                    </span>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {s.actionError ? <p class="atlas-alert" role="alert">{s.actionError}</p> : null}

      {ui.creating ? (
        <div data-atlas="api-key-create">
          <label class="atlas-field">
            <span class="atlas-field-label">{l.nameLabel}</span>
            <input class="atlas-account-input" maxLength={100} placeholder={l.namePlaceholder} value={ui.name} onInput$={(_, el) => (ui.name = el.value)} />
          </label>
          <label class="atlas-field">
            <span class="atlas-field-label">{l.expiresLabel}</span>
            <select class="atlas-account-input" onChange$={(_, el) => (ui.expiryDays = Number(el.value))}>
              {options.map((d) => (
                <option key={d} value={String(d)} selected={d === ui.expiryDays}>
                  {d > 0 ? formatLabel(l.expiresDays, { days: d }) : l.expiresNever}
                </option>
              ))}
            </select>
          </label>
          {s.allowedScopes.length > 0 ? (
            <fieldset class="atlas-field">
              <legend class="atlas-field-label">{l.scopesLabel}</legend>
              {model.rows.length ? (
                <table data-atlas="api-key-scope-grid">
                  <thead><tr><th scope="col" /><th scope="col">read</th><th scope="col">write</th></tr></thead>
                  <tbody>
                    {model.rows.map((row) => (
                      <tr key={row.resource}>
                        <th scope="row">{row.resource}</th>
                        <td>{box(row.read)}</td>
                        <td>{box(row.write)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {model.other.map((b) => (
                <label key={b.scope}>{box(b)} {b.scope}</label>
              ))}
            </fieldset>
          ) : null}
          {s.allowedClaims.map((name) => (
            <label class="atlas-field" key={name}>
              <span class="atlas-field-label">{name}</span>
              <input class="atlas-account-input" data-atlas-claim={name} value={ui.claims[name] ?? ''} onInput$={(_, el) => (ui.claims = { ...ui.claims, [name]: el.value })} />
            </label>
          ))}
          <button
            class="atlas-button"
            type="button"
            disabled={s.busy}
            onClick$={async () => {
              const created = await controller.value?.createKey(apiKeyInputFromDraft({ name: ui.name, expiryDays: ui.expiryDays, scopes: ui.scopes, claims: ui.claims }));
              if (created) {
                ui.copied = false;
                reset();
                await props.onCreate$?.(created);
              }
            }}
          >
            {l.submit}
          </button>
          <button class="atlas-button-secondary" type="button" onClick$={reset}>{l.cancel}</button>
        </div>
      ) : apiKeysAtCap(s) ? (
        <p class="atlas-text" data-atlas="api-keys-limit">{formatLabel(l.limitReached, { max: s.maxActiveKeys })}</p>
      ) : (
        <button class="atlas-button" type="button" onClick$={() => (ui.creating = true)}>{l.create}</button>
      )}
    </section>
  );
});
