<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import {
    API_KEYS_LABELS,
    REVERIFICATION_LABELS,
    apiKeyInputFromDraft,
    apiKeyStatus,
    apiKeysAtCap,
    formatLabel,
    scopePickerModel,
    toggleScope,
    type ApiKeyDraft,
    type ApiKeysLabels,
    type CreatedUserApiKey,
    type ReverificationLabels,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor } from '../appearance';
  import { controllerStore, createApiKeysController } from '../managed';

  /**
   * The signed-in user's own API keys (or, with `organizationId`, the active organization's): list, create (with
   * the "confirm it's you" prompt when the session is stale), the new secret shown once with a copy button,
   * rename, and revoke with a confirmation. Claim fields the application allows render as plain inputs.
   * Dispatches `create` with the new key.
   */
  export let organizationId: string | undefined = undefined;
  /** Expiry choices offered, in days. `0` means never. */
  export let expiryOptionsDays: number[] = [0, 30, 90, 365];
  export let labels: ApiKeysLabels & { reverification?: ReverificationLabels } = {};

  const atlas = useAtlas();
  const controller = createApiKeysController({ organizationId });
  const state = controllerStore(controller);
  const dispatch = createEventDispatcher<{ create: CreatedUserApiKey }>();
  onMount(() => void controller.load());

  const blank = (): ApiKeyDraft => ({ name: '', expiryDays: expiryOptionsDays[0] ?? 0, scopes: [], claims: {} });
  let creating = false;
  let draft = blank();
  let copied = false;
  let renaming: { id: string; name: string } | null = null;
  let confirmRevoke: string | null = null;
  let password = '';
  let reauthError: string | null = null;

  $: l = { ...API_KEYS_LABELS, ...labels };
  $: r = { ...REVERIFICATION_LABELS, ...labels.reverification };
  $: model = scopePickerModel($state.allowedScopes, $state.scopeImplications, draft.scopes);
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
  $: primary = classFor('formButtonPrimary', atlas.appearance, 'atlas-button');
  $: secondary = classFor('formButtonSecondary', atlas.appearance, 'atlas-button-secondary');
  $: inputClass = classFor('formFieldInput', atlas.appearance, 'atlas-account-input');

  function reset() {
    creating = false;
    draft = blank();
  }
  async function submit() {
    const created = await controller.createKey(apiKeyInputFromDraft(draft));
    if (created) {
      copied = false;
      reset();
      dispatch('create', created);
    }
  }
  async function confirmIdentity() {
    reauthError = null;
    try {
      await controller.completeReverification(password);
      password = '';
    } catch (e) {
      reauthError = e instanceof Error ? e.message : 'Re-authentication failed.';
    }
  }
  async function copy() {
    try {
      await navigator.clipboard?.writeText($state.secret ?? '');
      copied = true;
    } catch {
      /* the secret stays visible for manual copy */
    }
  }
  async function saveRename() {
    if (renaming && (await controller.renameKey(renaming.id, renaming.name.trim() || null))) renaming = null;
  }
  async function revoke(id: string) {
    if (await controller.revokeKey(id)) confirmRevoke = null;
  }
  function tick(scope: string, e: Event) {
    draft = { ...draft, scopes: toggleScope(draft.scopes, scope, (e.target as HTMLInputElement).checked) };
  }
  function setClaim(name: string, e: Event) {
    draft = { ...draft, claims: { ...draft.claims, [name]: (e.target as HTMLInputElement).value } };
  }
  const limitText = (limits: Record<string, unknown>) =>
    Object.entries(limits).map(([k, v]) => `${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}`).join(' · ');
  const detail = (key: { last_used_at: number | null; expires_at: number | null; scopes: string[] | null }) =>
    [
      key.last_used_at ? formatLabel(l.lastUsed, { date: new Date(key.last_used_at).toLocaleDateString() }) : l.neverUsed,
      key.expires_at ? formatLabel(l.expiresOn, { date: new Date(key.expires_at).toLocaleDateString() }) : null,
      key.scopes && key.scopes.length > 0 ? key.scopes.join(', ') : null,
    ].filter(Boolean).join(' · ');
</script>

{#if $state.status !== 'loading'}
  <section class={cardClass} data-atlas="api-keys">
    <h2 class="atlas-section-title">{l.title}</h2>
    {#if $state.status === 'disabled'}
      <p class="atlas-text" data-atlas="api-keys-disabled">{l.disabled}</p>
    {:else}
      <p class="atlas-text">{organizationId ? l.organizationSubtitle : l.subtitle}</p>
      {#if $state.status === 'error' && $state.error}<p class="atlas-alert" role="alert">{$state.error}</p>{/if}

      {#if $state.secret}
        <div data-atlas="api-key-secret" role="status">
          <p><strong>{l.secretTitle}</strong></p>
          <p>{l.secretHint}</p>
          <code data-atlas="api-key-secret-value">{$state.secret}</code>
          <button class={secondary} type="button" on:click={() => void copy()}>{copied ? l.copied : l.copy}</button>
          <button class={secondary} type="button" on:click={() => controller.dismissSecret()}>{l.done}</button>
        </div>
      {/if}

      {#if $state.needsReverification}
        <div data-atlas="api-keys-reverification" role="dialog" aria-label={r.title}>
          <p><strong>{r.title}</strong></p>
          <p>{r.subtitle}</p>
          <label class="atlas-field">
            <span class="atlas-field-label">{r.passwordLabel}</span>
            <input class={inputClass} type="password" autocomplete="current-password" bind:value={password} />
          </label>
          {#if reauthError}<p class="atlas-error" role="alert">{reauthError}</p>{/if}
          <button class={primary} type="button" on:click={() => void confirmIdentity()}>{r.submit}</button>
          <button class={secondary} type="button" on:click={() => { password = ''; reauthError = null; controller.cancelReverification(); }}>{r.cancel}</button>
        </div>
      {/if}

      {#if $state.keys.length === 0}
        <p class="atlas-text" data-atlas="api-keys-empty">{l.empty}</p>
      {:else}
        <ul class="atlas-list" data-atlas="api-keys-list">
          {#each $state.keys as key (key.id)}
            {@const st = apiKeyStatus(key)}
            <li class="atlas-list-item" data-atlas="api-key">
              {#if renaming && renaming.id === key.id}
                <span>
                  <input class={inputClass} aria-label={l.nameLabel} bind:value={renaming.name} />
                  <button class={secondary} type="button" disabled={$state.busy} on:click={() => void saveRename()}>{l.save}</button>
                  <button class={secondary} type="button" on:click={() => (renaming = null)}>{l.cancel}</button>
                </span>
              {:else}
                <strong>{key.name ?? l.unnamed}</strong>
              {/if}
              <code>{key.prefix}…</code>
              {#if st !== 'active'}<em> — {st === 'revoked' ? l.revoked : l.expired}</em>{/if}
              <div class="atlas-text">{detail(key)}</div>
              {#if key.limits && typeof key.limits === 'object' && Object.keys(key.limits).length > 0}
                <div class="atlas-text" data-atlas="api-key-limits">{l.limits}: {limitText(key.limits)}</div>
              {/if}
              {#if !key.revoked_at && !(renaming && renaming.id === key.id)}
                {#if confirmRevoke === key.id}
                  <span data-atlas="api-key-revoke-confirm">
                    <span>{l.revokeConfirm}</span>
                    <button class={secondary} type="button" disabled={$state.busy} on:click={() => void revoke(key.id)}>{l.revokeConfirmButton}</button>
                    <button class={secondary} type="button" on:click={() => (confirmRevoke = null)}>{l.cancel}</button>
                  </span>
                {:else}
                  <span>
                    <button class={secondary} type="button" on:click={() => (renaming = { id: key.id, name: key.name ?? '' })}>{l.rename}</button>
                    <button class={secondary} type="button" on:click={() => (confirmRevoke = key.id)}>{l.revoke}</button>
                  </span>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if $state.actionError}<p class="atlas-alert" role="alert">{$state.actionError}</p>{/if}

      {#if creating}
        <div data-atlas="api-key-create">
          <label class="atlas-field">
            <span class="atlas-field-label">{l.nameLabel}</span>
            <input class={inputClass} maxlength="100" placeholder={l.namePlaceholder} bind:value={draft.name} />
          </label>
          <label class="atlas-field">
            <span class="atlas-field-label">{l.expiresLabel}</span>
            <select class={inputClass} bind:value={draft.expiryDays}>
              {#each expiryOptionsDays as d (d)}
                <option value={d}>{d > 0 ? formatLabel(l.expiresDays, { days: d }) : l.expiresNever}</option>
              {/each}
            </select>
          </label>
          {#if $state.allowedScopes.length > 0}
            <fieldset class="atlas-field">
              <legend class="atlas-field-label">{l.scopesLabel}</legend>
              {#if model.rows.length}
                <table data-atlas="api-key-scope-grid">
                  <thead><tr><th scope="col"></th><th scope="col">read</th><th scope="col">write</th></tr></thead>
                  <tbody>
                    {#each model.rows as row (row.resource)}
                      {@const scopeR = row.read?.scope ?? ""}
                      {@const scopeW = row.write?.scope ?? ""}
                      <tr>
                        <th scope="row">{row.resource}</th>
                        <td>{#if row.read}<input type="checkbox" aria-label={row.read.scope} data-atlas-scope={row.read.scope} checked={row.read.checked} disabled={row.read.locked} on:change={(e) => tick(scopeR, e)} />{/if}</td>
                        <td>{#if row.write}<input type="checkbox" aria-label={row.write.scope} data-atlas-scope={row.write.scope} checked={row.write.checked} disabled={row.write.locked} on:change={(e) => tick(scopeW, e)} />{/if}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#each model.other as b (b.scope)}
                <label><input type="checkbox" aria-label={b.scope} data-atlas-scope={b.scope} checked={b.checked} disabled={b.locked} on:change={(e) => tick(b.scope, e)} /> {b.scope}</label>
              {/each}
            </fieldset>
          {/if}
          {#each $state.allowedClaims as name (name)}
            <label class="atlas-field">
              <span class="atlas-field-label">{name}</span>
              <input class={inputClass} data-atlas-claim={name} value={draft.claims[name] ?? ''} on:input={(e) => setClaim(name, e)} />
            </label>
          {/each}
          <button class={primary} type="button" disabled={$state.busy} on:click={() => void submit()}>{l.submit}</button>
          <button class={secondary} type="button" on:click={reset}>{l.cancel}</button>
        </div>
      {:else if apiKeysAtCap($state)}
        <p class="atlas-text" data-atlas="api-keys-limit">{formatLabel(l.limitReached, { max: $state.maxActiveKeys })}</p>
      {:else}
        <button class={primary} type="button" on:click={() => (creating = true)}>{l.create}</button>
      {/if}
    {/if}
  </section>
{/if}
