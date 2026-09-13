<script lang="ts">
  import { useAtlas } from '../context';
  import { getUser } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';

  /** §10.2 `<UserButton/>` — the avatar + account menu. */
  const atlas = useAtlas();
  const user = getUser();
  const cls = classFor;
  const t = (key: string) => translate(atlas.catalog, key);

  let open = false;

  $: current = $user.user;
  $: label =
    current
      ? [current.first_name, current.last_name].filter(Boolean).join(' ') ||
        current.username ||
        ''
      : '';
</script>

{#if current}
  <div class="atlas-user-button">
    <button
      class={cls('avatar', atlas.appearance, 'atlas-avatar')}
      on:click={() => (open = !open)}
      aria-expanded={open}
    >
      {#if current.image_url}
        <img alt="" src={current.image_url} />
      {:else}
        <span>{label.slice(0, 1)}</span>
      {/if}
    </button>

    {#if open}
      <div class={cls('menu', atlas.appearance, 'atlas-menu')} role="menu">
        <span class={cls('menuItem', atlas.appearance, 'atlas-menu-item')}>{label}</span>
        <button
          class={cls('menuItem', atlas.appearance, 'atlas-menu-item')}
          on:click={() => void atlas.signOut()}
        >
          {t('userButton.signOut')}
        </button>
      </div>
    {/if}
  </div>
{/if}
