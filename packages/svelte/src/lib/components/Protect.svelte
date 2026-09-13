<script lang="ts">
  import { get } from 'svelte/store';
  import { useAtlas } from '../context';
  import { evaluate, type ProtectCondition } from '../protect';

  /**
   * §10.2 `<Protect permission="…">` — conditional rendering.
   *
   * A rendering helper, never an authorization boundary: anyone can flip the
   * condition in devtools. The server checking the same permission is what
   * actually stops them, and this component's job is only to avoid showing a
   * button that would fail. The `default` slot renders when allowed; the
   * `fallback` slot renders otherwise.
   */
  export let permission: string | undefined = undefined;
  export let role: string | undefined = undefined;
  export let anyPermission: string[] | undefined = undefined;
  export let allPermissions: string[] | undefined = undefined;

  const atlas = useAtlas();
  const { status, claims } = atlas;

  $: condition = { permission, role, anyPermission, allPermissions } as ProtectCondition;
  $: allowed = $status !== 'loading' && evaluate($claims, condition).allowed;
  $: loading = $status === 'loading';
</script>

{#if loading}
  <!-- nothing while the SDK is still booting -->
{:else if allowed}
  <slot />
{:else}
  <slot name="fallback" />
{/if}
