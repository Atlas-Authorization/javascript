<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import {
    DEVICE_AUTH_LABELS,
    REVERIFICATION_LABELS,
    formatLabel,
    formatUserCode,
    userCodeFromUrl,
    type DeviceAuthorization as DeviceAuthorizationRecord,
    type DeviceAuthorizationLabels,
    type ReverificationLabels,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor } from '../appearance';
  import { controllerStore, createDeviceAuthorizationController } from '../managed';

  /**
   * Device sign-in (RFC 8628) on your own page: the signed-in user enters the code their TV, console or terminal
   * shows, sees which app asks for what, and allows or denies it. Reads `?user_code=` from the page URL, so it
   * works as the verification URI too. Dispatches `approved` and `denied`.
   */
  export let userCode: string | undefined = undefined;
  export let labels: DeviceAuthorizationLabels & { reverification?: ReverificationLabels } = {};

  const atlas = useAtlas();
  const controller = createDeviceAuthorizationController();
  const state = controllerStore(controller);
  const dispatch = createEventDispatcher<{ approved: DeviceAuthorizationRecord; denied: DeviceAuthorizationRecord }>();
  let code = userCode ?? '';
  let password = '';
  let reauthError: string | null = null;
  let lastStatus = '';

  onMount(() => {
    const initial = userCode ?? (typeof window !== 'undefined' ? userCodeFromUrl(window.location.href) : null);
    if (initial) {
      code = formatUserCode(initial);
      void controller.lookup(initial);
    }
  });

  $: if ($state.status !== lastStatus) {
    lastStatus = $state.status;
    if ($state.status === 'approved' && $state.authorization) dispatch('approved', $state.authorization);
    if ($state.status === 'denied' && $state.authorization) dispatch('denied', $state.authorization);
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

  $: l = { ...DEVICE_AUTH_LABELS, ...labels };
  $: r = { ...REVERIFICATION_LABELS, ...labels.reverification };
  $: busy = $state.status === 'busy';
  $: a = $state.authorization;
  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
  $: primary = classFor('formButtonPrimary', atlas.appearance, 'atlas-button');
  $: secondary = classFor('formButtonSecondary', atlas.appearance, 'atlas-button-secondary');
  $: inputClass = classFor('formFieldInput', atlas.appearance, 'atlas-account-input');
</script>

<section class={cardClass} data-atlas="device-authorization">
  <h2 class="atlas-section-title">{l.title}</h2>
  {#if $state.status === 'approved'}
    <p class="atlas-text" role="status" data-atlas="device-authorization-approved">{l.approved}</p>
  {:else if $state.status === 'denied'}
    <p class="atlas-text" role="status" data-atlas="device-authorization-denied">{l.denied}</p>
  {:else if a && ($state.status === 'review' || busy)}
    <div data-atlas="device-authorization-review">
      <p class="atlas-text">{formatLabel(l.request, { app: a.client.name })}</p>
      {#if a.scopes.length}
        <p class="atlas-text">{l.scopesTitle}</p>
        <ul class="atlas-list" data-atlas="device-authorization-scopes">
          {#each a.scopes as sc (sc.scope)}<li class="atlas-list-item">{sc.description}</li>{/each}
        </ul>
      {/if}
      <p class="atlas-text" data-atlas="device-authorization-code">{formatLabel(l.checkCode, { code: a.userCode })}</p>
      {#if $state.needsReverification}
        <div data-atlas="device-authorization-reverification" role="dialog" aria-label={r.title}>
          <p><strong>{r.title}</strong></p>
          <p>{r.subtitle}</p>
          <label class="atlas-field">
            <span class="atlas-field-label">{r.passwordLabel}</span>
            <input class={inputClass} type="password" autocomplete="current-password" bind:value={password} />
          </label>
          {#if reauthError}<p class="atlas-error" role="alert">{reauthError}</p>{/if}
          <button class={primary} type="button" on:click={() => void confirmIdentity()}>{r.submit}</button>
          <button class={secondary} type="button" on:click={() => controller.cancelReverification()}>{r.cancel}</button>
        </div>
      {:else}
        <div>
          <button class={primary} type="button" disabled={busy} on:click={() => void controller.approve()}>{l.approve}</button>
          <button class={secondary} type="button" disabled={busy} on:click={() => void controller.deny()}>{l.deny}</button>
        </div>
      {/if}
    </div>
  {:else}
    <form data-atlas="device-authorization-entry" on:submit|preventDefault={() => void controller.lookup(code)}>
      <p class="atlas-text">{l.subtitle}</p>
      <label class="atlas-field">
        <span class="atlas-field-label">{l.codeLabel}</span>
        <input class={inputClass} bind:value={code} autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" />
      </label>
      {#if $state.error}<p class="atlas-error" role="alert">{$state.invalidCode ? l.invalidCode : $state.error}</p>{/if}
      <button class={primary} type="submit" disabled={busy || !code.trim()}>{l.continue}</button>
    </form>
  {/if}
  {#if $state.status === 'approved' || $state.status === 'denied' || $state.status === 'error'}
    <button class={secondary} type="button" on:click={() => { code = ''; controller.reset(); }}>{l.another}</button>
  {/if}
</section>
