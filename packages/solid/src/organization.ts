import { createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import {
  FapiClient,
  createOrganizationAuditLog,
  describeAuditAction,
  type OrganizationAuditLogOptions,
  type OrganizationAuditLogState,
} from '@atlasauth/js';
import { h } from './h';
import { useAtlas } from './context';
import type { AtlasClient } from './provider';
import { ATLAS_SOLID_SDK } from './version';

/** The active organization's id: the session's `org_id`, when the user is a member of it. */
function activeOrganizationId(client: AtlasClient): string | null {
  const orgId = client.state.claims?.org_id;
  if (!orgId) return null;
  return client.state.memberships.some((m) => m.organization.id === orgId) ? orgId : null;
}

/**
 * The active organization's audit trail, for its admins: one page at a time,
 * newest first, with `loadMore()`. `action` narrows it (exact, or a prefix
 * ending in `.`). `state().forbidden` is true when the signed-in member may not
 * read it, so the caller can hide the surface. Follows the active organization.
 */
export function useOrganizationAuditLog(options: OrganizationAuditLogOptions = {}): {
  state: () => OrganizationAuditLogState;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const client = useAtlas();
  const log = createOrganizationAuditLog(
    new FapiClient({
      publishableKey: client.publishableKey,
      baseUrl: client.frontendApi,
      locale: client.locale,
      sdk: ATLAS_SOLID_SDK,
    }),
    options,
  );
  const [state, setState] = createSignal(log.getState());
  onCleanup(log.subscribe((next) => setState(next)));
  createEffect(
    on(
      () => activeOrganizationId(client),
      (id) => void log.load(id),
    ),
  );
  return { state, loadMore: log.loadMore, reload: log.reload };
}

export interface OrganizationAuditLogProps extends OrganizationAuditLogOptions {
  labels?: { title?: string; empty?: string; loadMore?: string; actor?: string };
  formatDate?: (ms: number) => string;
}

/**
 * `<OrganizationAuditLog/>` — the active organization's audit trail for its
 * admins. Renders nothing for a member who may not read it (the server is the
 * authority; the component just follows it). Labels are props so an app can
 * localise them.
 */
export function OrganizationAuditLog(props: OrganizationAuditLogProps = {}): JSX.Element {
  const client = useAtlas();
  const log = useOrganizationAuditLog({ pageSize: props.pageSize, action: props.action });
  const formatDate = (ms: number) => (props.formatDate ?? ((v: number) => new Date(v).toLocaleString()))(ms);

  return (() => {
    const state = log.state();
    if (!activeOrganizationId(client) || state.forbidden) return null;
    const labels = props.labels ?? {};
    return h('div', { class: 'atlas-card', 'data-atlas': 'organization-audit-log' }, [
      h('h2', { class: 'atlas-title' }, labels.title ?? 'Audit log'),
      state.entries.length === 0 && !state.loading
        ? h('p', { class: 'atlas-subtitle' }, labels.empty ?? 'No activity recorded yet.')
        : h(
            'ul',
            { class: 'atlas-audit-list' },
            state.entries.map((entry) =>
              h('li', { class: 'atlas-audit-item', 'data-action': entry.action }, [
                h('strong', describeAuditAction(entry.action)),
                h(
                  'span',
                  { class: 'atlas-audit-meta' },
                  ` · ${formatDate(entry.created_at)}` +
                    (entry.actor.id ? ` · ${labels.actor ?? 'by'} ${entry.actor.type} ${entry.actor.id}` : ''),
                ),
              ]),
            ),
          ),
      state.hasMore
        ? h(
            'button',
            {
              type: 'button',
              class: 'atlas-button-secondary',
              disabled: state.loading,
              onClick: () => void log.loadMore(),
            },
            labels.loadMore ?? 'Load more',
          )
        : null,
    ]);
  }) as unknown as JSX.Element;
}
