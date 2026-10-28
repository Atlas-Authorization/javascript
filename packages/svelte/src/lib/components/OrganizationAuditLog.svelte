<script lang="ts">
  import { describeAuditAction } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { getOrganization, getOrganizationAuditLog } from '../accessors';
  import { classFor, type ElementKey } from '../appearance';

  /**
   * `<OrganizationAuditLog/>` — the active organization's audit trail for its
   * admins, next to `<OrganizationProfile/>`. Renders nothing for a member who
   * may not read it (the server is the authority; the component just follows
   * it). Labels are props so an app can localise them.
   */
  export let pageSize: number | undefined = undefined;
  export let action: string | undefined = undefined;
  export let labels: { title?: string; empty?: string; loadMore?: string; actor?: string } = {};
  export let formatDate: (ms: number) => string = (ms) => new Date(ms).toLocaleString();

  const atlas = useAtlas();
  const org = getOrganization();
  const log = getOrganizationAuditLog({ pageSize, action });

  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
</script>

{#if $org.organization && !$log.forbidden}
  <div class={cls('card', 'atlas-card')} data-atlas="organization-audit-log">
    <h2 class={cls('headerTitle', 'atlas-title')}>{labels.title ?? 'Audit log'}</h2>
    {#if $log.entries.length === 0 && !$log.loading}
      <p class={cls('headerSubtitle', 'atlas-subtitle')}>{labels.empty ?? 'No activity recorded yet.'}</p>
    {:else}
      <ul class={cls('list', 'atlas-audit-list')}>
        {#each $log.entries as entry (entry.id)}
          <li class={cls('listItem', 'atlas-audit-item')} data-action={entry.action}>
            <strong>{describeAuditAction(entry.action)}</strong>
            <span class="atlas-audit-meta">
              · {formatDate(entry.created_at)}{entry.actor.id
                ? ` · ${labels.actor ?? 'by'} ${entry.actor.type} ${entry.actor.id}`
                : ''}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if $log.hasMore}
      <button
        type="button"
        class={cls('formButtonSecondary', 'atlas-button-secondary')}
        disabled={$log.loading}
        on:click={() => void log.loadMore()}
      >
        {labels.loadMore ?? 'Load more'}
      </button>
    {/if}
  </div>
{/if}
