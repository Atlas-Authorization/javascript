<script lang="ts">
  import { useAtlas } from '../context';
  import { getOrganization } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';
  import Protect from './Protect.svelte';

  /** §10.2 `<OrganizationProfile/>` — the active organization's card. */
  const atlas = useAtlas();
  const org = getOrganization();
  const t = (key: string) => translate(atlas.catalog, key);

  $: cardClass = classFor('card', atlas.appearance, 'atlas-card');
</script>

{#if $org.organization}
  <div class={cardClass}>
    <h1>{$org.organization.name}</h1>
    <p>{t('organization.roleLabel')}: {$org.membership?.role}</p>
    <!-- Management controls are gated on the ACTIVE org role, matching the
         server's §9.2 rule rather than duplicating a looser one. -->
    <Protect permission="org:sys_memberships:manage">
      <button>{t('organization.invite')}</button>
    </Protect>
  </div>
{/if}
