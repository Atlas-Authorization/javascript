<script lang="ts">
  import { onMount } from 'svelte';
  import {
    clearCibaPin,
    decideCibaRequest,
    getCibaPin,
    listCibaRequests,
    setCibaPin,
    type CibaPinStatus,
    type CibaRequest,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor } from '../appearance';
  import { FapiClient } from '../fapi';
  import { ATLAS_SVELTE_SDK } from '../version';

  /**
   * Sign-in requests apps start on the user's behalf (CIBA), with approve and deny, and the optional CIBA PIN
   * apps must send as the user code. Renders nothing when there is no request, no PIN and no app that could ask.
   */
  const atlas = useAtlas();
  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
    locale: atlas.locale,
    sdk: ATLAS_SVELTE_SDK,
  });
  let requests: CibaRequest[] = [];
  let pin: CibaPinStatus | null = null;
  let newPin = '';
  let password = '';
  let message: string | null = null;

  async function load() {
    const [r, p] = await Promise.all([listCibaRequests(client).catch(() => []), getCibaPin(client).catch(() => null)]);
    requests = r;
    pin = p;
  }
  onMount(load);

  async function run(fn: () => Promise<unknown>, fallback: string) {
    message = null;
    try {
      await fn();
      newPin = '';
      password = '';
      await load();
    } catch (e) {
      message = e instanceof Error && e.message ? e.message : fallback;
    }
  }

  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
  $: buttonClass = classFor('formButtonSecondary', atlas.appearance, 'atlas-button-secondary');
</script>

{#if requests.length || (pin && (pin.set || pin.available))}
  <section class={cardClass} data-atlas="manage-ciba">
    {#if requests.length}
      <h2>Sign-in requests from apps</h2>
      <ul>
        {#each requests as r (r.id)}
          <li>
            <strong>{r.client_name}</strong>
            {#if r.binding_message}<div>{r.binding_message}</div>{/if}
            <small>{r.scope.join(', ')}</small>
            <button class={buttonClass} type="button" on:click={() => void run(() => decideCibaRequest(client, r.id, 'approve'), 'Could not approve.')}>Approve</button>
            <button class={buttonClass} type="button" on:click={() => void run(() => decideCibaRequest(client, r.id, 'deny'), 'Could not deny.')}>Deny</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if pin && (pin.set || pin.available)}
      <form on:submit|preventDefault={() => void run(() => setCibaPin(client, { pin: newPin, currentPassword: password }), 'Could not save the PIN.')}>
        <h2>CIBA PIN</h2>
        <p>{pin.set ? 'You have a CIBA PIN.' : 'You have not set a CIBA PIN.'} Apps that start a sign-in request for you must send it.</p>
        <input type="password" autocomplete="current-password" placeholder="Current password" aria-label="Current password" bind:value={password} />
        <input type="password" inputmode="numeric" autocomplete="off" placeholder="6 to 12 digits" aria-label="New CIBA PIN" bind:value={newPin} />
        <button class={buttonClass} type="submit">{pin.set ? 'Change PIN' : 'Set PIN'}</button>
        {#if pin.set}
          <button class={buttonClass} type="button" on:click={() => void run(() => clearCibaPin(client, { currentPassword: password }), 'Could not remove the PIN.')}>Remove PIN</button>
        {/if}
        {#if message}<small role="status">{message}</small>{/if}
      </form>
    {:else if message}
      <small role="status">{message}</small>
    {/if}
  </section>
{/if}
