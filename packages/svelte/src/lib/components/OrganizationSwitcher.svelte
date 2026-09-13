<script lang="ts">
  import { useAtlas } from '../context';
  import { getOrganization } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';

  /** §10.2 `<OrganizationSwitcher/>` — switch the active organization. */
  const atlas = useAtlas();
  const org = getOrganization();
  const t = (key: string) => translate(atlas.catalog, key);

  $: menuClass = classFor('menu', atlas.appearance, 'atlas-menu');
  $: itemClass = classFor('menuItem', atlas.appearance, 'atlas-menu-item');
</script>

<div class={menuClass}>
  <button class={itemClass} on:click={() => void $org.setActive(null)}>
    {t('organization.personal')}
  </button>
  {#each $org.memberships as membership (membership.organization.id)}
    <button
      class={itemClass}
      disabled={membership.organization.id === $org.organization?.id}
      on:click={() => void $org.setActive(membership.organization.id)}
    >
      {membership.organization.name}
    </button>
  {/each}
</div>
