'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  OrganizationProfileController,
  deleteOrganization,
  type OrganizationMember,
  type OrganizationProfileState,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useAuth, useOrganization } from './hooks';
import { useClass, useClasses, useErrorText, useMeClient, useText } from './components-shared';
import { useReverification } from './reverification';
import {
  OrganizationApiKeys,
  OrganizationDirectory,
  OrganizationDomains,
  OrganizationIpAllowlist,
  OrganizationLogStreams,
  OrganizationSsoConnection,
  OrganizationWebhooks,
  AppWebhookEndpoints,
} from './organization-admin';

export function OrganizationSwitcher() {
  const { memberships, organization, setActive } = useOrganization();
  const t = useText();
  const menuClass = useClass('menu', 'atlas-menu');
  const itemClass = useClass('menuItem', 'atlas-menu-item');

  return (
    <div className={menuClass}>
      <button className={itemClass} onClick={() => void setActive(null)}>
        {t('organization.personal')}
      </button>
      {memberships.map((membership) => (
        <button
          key={membership.organization.id}
          className={itemClass}
          disabled={membership.organization.id === organization?.id}
          onClick={() => void setActive(membership.organization.id)}
        >
          {membership.organization.name}
        </button>
      ))}
    </div>
  );
}

/**
 * Clerk-parity `useOrganizationList()`. The memberships the signed-in user
 * belongs to, plus a `createOrganization(name)` that creates one through FAPI and
 * re-boots the provider so the new membership appears everywhere. `memberships`
 * comes straight from {@link useOrganization} (the same list `<OrganizationSwitcher>`
 * renders), so there is one source of truth for what the user belongs to.
 */
export function useOrganizationList(): {
  memberships: ReturnType<typeof useOrganization>['memberships'];
  createOrganization(name: string): Promise<{ id: string; name: string } | null>;
} {
  const { memberships } = useOrganization();
  const { reload } = useAtlas();
  const client = useMeClient();

  const createOrganization = useCallback(
    async (name: string) => {
      const res = await client.post<{ id: string; name: string }>('/v1/client/organizations', {
        name,
      });
      // Re-boot so the new membership lands in `memberships` for the whole app,
      // not just this hook's caller.
      await reload();
      return res.data;
    },
    [client, reload],
  );

  return { memberships, createOrganization };
}

/**
 * Clerk-parity `<CreateOrganization>`. A small name-and-submit form that creates
 * an organization via {@link useOrganizationList} and immediately makes it the
 * active org, so the user drops straight into the org they just made. Styled like
 * the `<SignUp>` card. `onCreate` fires with the created org for a caller that
 * wants to route afterwards.
 */
export function CreateOrganization({
  onCreate,
}: {
  onCreate?(organization: { id: string; name: string }): void;
} = {}) {
  const { createOrganization } = useOrganizationList();
  const { setActive } = useOrganization();
  const t = useText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const org = await createOrganization(trimmed);
      if (!org) {
        setError(t('error.generic'));
        return;
      }
      await setActive(org.id);
      setName('');
      onCreate?.(org);
    } catch {
      setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={cardClass}
      data-atlas="create-organization"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className={titleClass}>{t('organization.createTitle')}</h2>
      <label className={cls('formField', 'atlas-field')}>
        <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.nameLabel')}</span>
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {error ? (
        <p className={errorClass} role="alert">
          {error}
        </p>
      ) : null}
      <button className={buttonClass} type="submit" disabled={busy || !name.trim()}>
        {t('organization.create')}
      </button>
    </form>
  );
}

/**
 * Clerk-parity `<OrganizationList>`. Every organization the user belongs to as a
 * button that switches to it (mirroring `<OrganizationSwitcher>`'s markup), plus
 * an inline `<CreateOrganization>` so a user with no orgs — or who wants another —
 * can make one without leaving the list.
 */
export function OrganizationList() {
  const { memberships, organization, setActive } = useOrganization();
  const t = useText();
  const menuClass = useClass('menu', 'atlas-menu');
  const itemClass = useClass('menuItem', 'atlas-menu-item');

  return (
    <div className={menuClass} data-atlas="organization-list">
      {memberships.map((membership) => (
        <button
          key={membership.organization.id}
          className={itemClass}
          disabled={membership.organization.id === organization?.id}
          onClick={() => void setActive(membership.organization.id)}
        >
          {membership.organization.name}
        </button>
      ))}
      <span className={itemClass} data-atlas="organization-list-divider">
        {t('organization.orCreate')}
      </span>
      <CreateOrganization />
    </div>
  );
}

/**
 * Headless state for the active organization's profile: members, pending
 * invitations and roles, with the admin actions (change role, remove, invite,
 * revoke, resend) and the member actions (leave; delete for an admin, which
 * parks for a password re-authentication on a stale session). The same
 * `OrganizationProfileController` backs every SDK's `<OrganizationProfile>`.
 */
export function useOrganizationProfile(): {
  organizationId: string | null;
  state: OrganizationProfileState;
  canManage: boolean;
  isAdmin: boolean;
  controller: OrganizationProfileController | null;
  deleteOrganization(): Promise<boolean>;
  reverification: ReturnType<typeof useReverification>;
} {
  const { organization, membership } = useOrganization();
  const { has } = useAuth();
  const { reload } = useAtlas();
  const client = useMeClient();
  const reverification = useReverification();
  const canManage = has({ permission: 'org:sys_memberships:manage' });
  const isAdmin = membership?.role === 'org:admin';
  const organizationId = organization?.id ?? null;

  const controller = useMemo(
    () =>
      organizationId
        ? new OrganizationProfileController(client, organizationId, {
            canManage,
            onChange: async () => {
              await reload();
            },
          })
        : null,
    [client, organizationId, canManage, reload],
  );

  useEffect(() => {
    void controller?.load();
  }, [controller]);

  const empty = useMemo<OrganizationProfileState>(
    () => ({ status: 'idle', members: [], membersTotal: 0, invitations: [], roles: [], permissions: [], error: null, busy: null }),
    [],
  );
  const state = useSyncExternalStore(
    useCallback((cb: () => void) => (controller ? controller.subscribe(cb) : () => undefined), [controller]),
    () => controller?.getState() ?? empty,
    () => controller?.getState() ?? empty,
  );

  const { withReverification } = reverification;
  const remove = useCallback(async () => {
    if (!organizationId) return false;
    await withReverification(() => deleteOrganization(client, organizationId));
    await reload();
    return true;
  }, [client, organizationId, reload, withReverification]);

  return { organizationId, state, canManage, isAdmin, controller, deleteOrganization: remove, reverification };
}

function memberName(member: OrganizationMember, fallback: string): string {
  const name = [member.user?.first_name, member.user?.last_name].filter(Boolean).join(' ');
  return name || fallback;
}

export interface OrganizationProfileProps {
  /** Called after the user leaves or deletes the organization (e.g. to navigate away). */
  onExit?(reason: 'left' | 'deleted'): void;
  /**
   * Tenant-admin sections to show under the profile for members who manage the
   * organization: SSO, directory sync, domains, log streams, API keys, sign-in
   * IP allowlist, webhooks and the audit log. Off by default.
   */
  adminSections?: OrganizationAdminSection[];
}

export type OrganizationAdminSection =
  | 'sso'
  | 'directory'
  | 'domains'
  | 'logStreams'
  | 'apiKeys'
  | 'ipAllowlist'
  | 'webhooks'
  | 'appWebhooks'
  | 'auditLog';

const ADMIN_SECTIONS: Record<OrganizationAdminSection, () => ReactNode> = {
  sso: () => <OrganizationSsoConnection />,
  directory: () => <OrganizationDirectory />,
  domains: () => <OrganizationDomains />,
  logStreams: () => <OrganizationLogStreams />,
  apiKeys: () => <OrganizationApiKeys />,
  ipAllowlist: () => <OrganizationIpAllowlist />,
  webhooks: () => <OrganizationWebhooks />,
  appWebhooks: () => <AppWebhookEndpoints />,
  auditLog: () => <OrganizationAuditLog />,
};

/**
 * Clerk-parity `<OrganizationProfile>`: the active organization's members
 * (admins change roles and remove), invitations (admins invite, revoke and
 * resend) and settings (leave; an admin deletes, after re-authenticating).
 * Every control is gated on the ACTIVE org role, matching the server's rule.
 */
export function OrganizationProfile({ onExit, adminSections = [] }: OrganizationProfileProps = {}) {
  const { organization, membership } = useOrganization();
  const { userId } = useAuth();
  const t = useText();
  const errorText = useErrorText();
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();
  const profile = useOrganizationProfile();
  const { state, controller, canManage, isAdmin, reverification } = profile;

  const [tab, setTab] = useState<'members' | 'invitations' | 'roles' | 'settings'>('members');
  // The custom-role editor: null = creating a new role, else the id being edited.
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [roleKey, setRoleKey] = useState('');
  const [roleName, setRoleName] = useState('');
  const [rolePerms, setRolePerms] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('org:member');
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  if (!organization || !controller) return null;

  const buttonSecondary = cls('formButtonSecondary', 'atlas-button-secondary');
  const buttonPrimary = cls('formButtonPrimary', 'atlas-button');
  const busy = (key: string) => state.busy === key;
  const error = localError ?? (state.error ? errorText(state.error) : null);

  const sendInvite = async () => {
    const address = email.trim();
    if (!address) return;
    const out = await controller.invite(address, inviteRole);
    if (out) setEmail('');
  };

  const doLeave = async () => {
    setLocalError(null);
    if (await controller.leave()) onExit?.('left');
    setConfirm(null);
  };

  const doDelete = async () => {
    setLocalError(null);
    try {
      if (await profile.deleteOrganization()) onExit?.('deleted');
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Reverification cancelled.')) {
        setLocalError(err instanceof Error ? errorText(err) : t('error.generic'));
      }
    }
    setConfirm(null);
  };

  const roleOptions = state.roles.length > 0 ? state.roles : [{ key: 'org:member', name: 'org:member' }];
  const customRoles = state.roles.filter((r) => Boolean(r.organization_id));

  const resetRoleForm = () => {
    setEditingRole(null);
    setRoleKey('');
    setRoleName('');
    setRolePerms([]);
  };

  const saveRole = async () => {
    const out = editingRole
      ? await controller.updateRole(editingRole, { name: roleName.trim(), permissions: rolePerms })
      : await controller.createRole({ key: roleKey.trim(), name: roleName.trim(), permissions: rolePerms });
    if (out) resetRoleForm();
  };

  return (
    <div className={cardClass} data-atlas="organization-profile">
      <h1 className={cls('headerTitle', 'atlas-heading')}>{organization.name}</h1>
      <p className={cls('headerSubtitle', 'atlas-subtitle')}>
        {t('organization.roleLabel')}: {membership?.role}
      </p>

      <div className={cls('menu', 'atlas-menu')} role="tablist">
        {(['members', ...(canManage ? ['invitations', 'roles'] : []), 'settings'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cls('menuItem', 'atlas-menu-item')}
            data-atlas={`organization-tab-${key}`}
            onClick={() => setTab(key as typeof tab)}
          >
            {t(`organization.${key}`)}
          </button>
        ))}
      </div>

      {error ? (
        <p className={cls('alert', 'atlas-alert')} role="alert">
          {error}
        </p>
      ) : null}

      {tab === 'members' ? (
        <ul className={cls('list', 'atlas-list')} data-atlas="organization-members">
          {state.members.map((member) => {
            const self = member.user?.id === userId;
            const id = member.user?.id ?? member.id;
            return (
              <li key={member.id} data-atlas="organization-member">
                <span>
                  {memberName(member, t('organization.unnamedMember'))}
                  {self ? ` ${t('organization.you')}` : ''}
                </span>
                {canManage && !self && member.user ? (
                  <>
                    <select
                      aria-label={t('organization.roleLabel')}
                      className={cls('formFieldInput', 'atlas-input')}
                      value={member.role}
                      disabled={busy(`role:${id}`)}
                      onChange={(event) => void controller.changeRole(id, event.target.value)}
                    >
                      {roleOptions.map((role) => (
                        <option key={role.key} value={role.key}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={buttonSecondary}
                      disabled={busy(`remove:${id}`)}
                      onClick={() => void controller.removeMember(id)}
                    >
                      {t('organization.remove')}
                    </button>
                  </>
                ) : (
                  <span> · {member.role}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {tab === 'invitations' && canManage ? (
        <div data-atlas="organization-invitations">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendInvite();
            }}
          >
            <label className={cls('formField', 'atlas-field')}>
              <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.emailLabel')}</span>
              <input
                className={cls('formFieldInput', 'atlas-input')}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className={cls('formField', 'atlas-field')}>
              <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.roleLabel')}</span>
              <select
                className={cls('formFieldInput', 'atlas-input')}
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value)}
              >
                {roleOptions.map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonPrimary} disabled={busy('invite') || !email.trim()}>
              {t('organization.sendInvite')}
            </button>
          </form>
          {state.invitations.length === 0 ? (
            <p className={cls('text', 'atlas-text')}>{t('organization.noInvitations')}</p>
          ) : (
            <ul className={cls('list', 'atlas-list')}>
              {state.invitations.map((inv) => (
                <li key={inv.id} data-atlas="organization-invitation">
                  <span>
                    {inv.email_address} · {inv.role}
                  </span>
                  <button
                    type="button"
                    className={buttonSecondary}
                    disabled={busy(`resend:${inv.id}`)}
                    onClick={() => void controller.resendInvitation(inv.id)}
                  >
                    {t('organization.resend')}
                  </button>
                  <button
                    type="button"
                    className={buttonSecondary}
                    disabled={busy(`revoke:${inv.id}`)}
                    onClick={() => void controller.revokeInvitation(inv.id)}
                  >
                    {t('organization.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === 'roles' && canManage ? (
        <div data-atlas="organization-roles">
          {customRoles.length === 0 ? (
            <p className={cls('text', 'atlas-text')}>{t('organization.noCustomRoles')}</p>
          ) : (
            <ul className={cls('list', 'atlas-list')}>
              {customRoles.map((role) => (
                <li key={role.id ?? role.key} data-atlas="organization-role">
                  <span>
                    {role.name} · {role.key}
                  </span>
                  <button
                    type="button"
                    className={buttonSecondary}
                    onClick={() => {
                      setEditingRole(role.id ?? null);
                      setRoleKey(role.key);
                      setRoleName(role.name);
                      setRolePerms(role.permissions ?? []);
                    }}
                  >
                    {t('organization.editRole')}
                  </button>
                  <button
                    type="button"
                    className={buttonSecondary}
                    disabled={!role.id || busy(`role:delete:${role.id}`)}
                    onClick={() => role.id && void controller.deleteRole(role.id)}
                  >
                    {t('organization.deleteRole')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            data-atlas="organization-role-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveRole();
            }}
          >
            {editingRole ? null : (
              <label className={cls('formField', 'atlas-field')}>
                <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.roleKey')}</span>
                <input
                  className={cls('formFieldInput', 'atlas-input')}
                  name="role_key"
                  value={roleKey}
                  onChange={(event) => setRoleKey(event.target.value)}
                />
              </label>
            )}
            <label className={cls('formField', 'atlas-field')}>
              <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.roleName')}</span>
              <input
                className={cls('formFieldInput', 'atlas-input')}
                name="role_name"
                value={roleName}
                onChange={(event) => setRoleName(event.target.value)}
              />
            </label>
            <fieldset className={cls('formField', 'atlas-field')}>
              <legend className={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.rolePermissions')}</legend>
              {state.permissions.map((permission) => (
                <label key={permission.key} data-atlas="organization-role-permission">
                  <input
                    type="checkbox"
                    value={permission.key}
                    checked={rolePerms.includes(permission.key)}
                    onChange={(event) =>
                      setRolePerms((current) =>
                        event.target.checked
                          ? [...current, permission.key]
                          : current.filter((key) => key !== permission.key),
                      )
                    }
                  />{' '}
                  {permission.name}
                </label>
              ))}
            </fieldset>
            <button
              type="submit"
              className={buttonPrimary}
              disabled={!roleName.trim() || (!editingRole && !roleKey.trim()) || state.busy?.startsWith('role:') === true}
            >
              {editingRole ? t('organization.saveRole') : t('organization.createRole')}
            </button>
            {editingRole ? (
              <button type="button" className={buttonSecondary} onClick={resetRoleForm}>
                {t('organization.cancel')}
              </button>
            ) : null}
          </form>
        </div>
      ) : null}

      {tab === 'settings' ? (
        <div data-atlas="organization-settings">
          {confirm ? (
            <div role="dialog" data-atlas={`organization-confirm-${confirm}`}>
              <p className={cls('text', 'atlas-text')}>
                {t(confirm === 'leave' ? 'organization.leaveConfirm' : 'organization.deleteConfirm', {
                  name: organization.name,
                })}
              </p>
              <button
                type="button"
                className={buttonPrimary}
                disabled={busy('leave') || busy('delete')}
                onClick={() => void (confirm === 'leave' ? doLeave() : doDelete())}
              >
                {t('organization.confirm')}
              </button>
              <button type="button" className={buttonSecondary} onClick={() => setConfirm(null)}>
                {t('organization.cancel')}
              </button>
            </div>
          ) : (
            <>
              <button type="button" className={buttonSecondary} onClick={() => setConfirm('leave')}>
                {t('organization.leave')}
              </button>
              {isAdmin ? (
                <button type="button" className={buttonSecondary} onClick={() => setConfirm('delete')}>
                  {t('organization.delete')}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {reverification.needsReverification ? (
        <div data-atlas="organization-reverification" role="dialog" aria-label={t('reverification.title')}>
          <p className={cls('text', 'atlas-text')}>
            <strong>{t('reverification.title')}</strong>
          </p>
          <p className={cls('text', 'atlas-text')}>{t('reverification.subtitle')}</p>
          <label className={cls('formField', 'atlas-field')}>
            <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('reverification.passwordLabel')}</span>
            <input
              className={cls('formFieldInput', 'atlas-account-input')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={buttonPrimary}
            onClick={() =>
              void reverification
                .completeReverification({ strategy: 'password', password })
                .then(() => setPassword(''))
                .catch((err: unknown) => setLocalError(err instanceof Error ? errorText(err) : t('error.generic')))
            }
          >
            {t('reverification.submit')}
          </button>
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => {
              setPassword('');
              reverification.cancelReverification();
            }}
          >
            {t('reverification.cancel')}
          </button>
        </div>
      ) : null}

      {canManage
        ? adminSections.map((section) => <div key={section} data-atlas={`organization-admin-${section}`}>{ADMIN_SECTIONS[section]()}</div>)
        : null}
    </div>
  );
}

/** One entry of an organization's audit trail, as the Frontend API returns it. */
export interface OrganizationAuditLogEntry {
  object: 'audit_log';
  id: string;
  action: string;
  actor: { type: string; id: string | null };
  target: { type: string | null; id: string | null };
  organization_id: string;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
}

/**
 * The active organization's audit trail, for org admins: one page at a time,
 * newest first, with a "load more" cursor. `action` narrows it (exact, or a
 * prefix ending in `.`). Returns `forbidden: true` when the signed-in member is
 * not allowed to read it, so the caller can hide the surface.
 */
export function useOrganizationAuditLog(options: { pageSize?: number; action?: string } = {}): {
  entries: OrganizationAuditLogEntry[];
  loading: boolean;
  forbidden: boolean;
  hasMore: boolean;
  loadMore(): Promise<void>;
  reload(): Promise<void>;
} {
  const { organization } = useOrganization();
  const client = useMeClient();
  const [entries, setEntries] = useState<OrganizationAuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const orgId = organization?.id;
  const pageSize = options.pageSize ?? 20;
  const action = options.action;

  const fetchPage = useCallback(
    async (after: string | null) => {
      if (!orgId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(pageSize) });
        if (after) params.set('starting_after', after);
        if (action) params.set('action', action);
        const res = await client.get<{ data: OrganizationAuditLogEntry[]; has_more: boolean; next_cursor: string | null }>(
          `/v1/client/organizations/${encodeURIComponent(orgId)}/audit_logs?${params.toString()}`,
        );
        if (!res.ok || !res.data) {
          setForbidden(res.status === 403 || res.status === 404);
          return;
        }
        const page = res.data;
        setForbidden(false);
        setEntries((prev) => (after ? [...prev, ...page.data] : page.data));
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      } finally {
        setLoading(false);
      }
    },
    [client, orgId, pageSize, action],
  );

  useEffect(() => {
    setEntries([]);
    setCursor(null);
    void fetchPage(null);
  }, [fetchPage]);

  return {
    entries,
    loading,
    forbidden,
    hasMore,
    loadMore: async () => {
      if (cursor) await fetchPage(cursor);
    },
    reload: () => fetchPage(null),
  };
}

/** `organization_invitation.created` → `Organization invitation created`. */
function describeAction(action: string): string {
  const text = action.replace(/[._]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `<OrganizationAuditLog/>` — the active organization's audit trail for its
 * admins, next to `<OrganizationProfile/>`. Renders nothing for a member who may
 * not read it (the server is the authority; the component just follows it).
 * Labels are props so an app can localise them.
 */
export function OrganizationAuditLog({
  pageSize,
  action,
  labels = {},
  formatDate = (ms) => new Date(ms).toLocaleString(),
}: {
  pageSize?: number;
  action?: string;
  labels?: { title?: string; empty?: string; loadMore?: string; actor?: string };
  formatDate?(ms: number): string;
} = {}) {
  const { organization } = useOrganization();
  const log = useOrganizationAuditLog({ pageSize, action });
  const cardClass = useClass('card', 'atlas-card');
  const cls = useClasses();

  if (!organization || log.forbidden) return null;

  return (
    <div className={cardClass} data-atlas="organization-audit-log">
      <h2 className={cls('headerTitle', 'atlas-title')}>{labels.title ?? 'Audit log'}</h2>
      {log.entries.length === 0 && !log.loading ? (
        <p className={cls('headerSubtitle', 'atlas-subtitle')}>{labels.empty ?? 'No activity recorded yet.'}</p>
      ) : (
        <ul className={cls('list', 'atlas-audit-list')}>
          {log.entries.map((entry) => (
            <li key={entry.id} className={cls('listItem', 'atlas-audit-item')} data-action={entry.action}>
              <strong>{describeAction(entry.action)}</strong>
              <span className="atlas-audit-meta">
                {' · '}
                {formatDate(entry.created_at)}
                {entry.actor.id ? ` · ${labels.actor ?? 'by'} ${entry.actor.type} ${entry.actor.id}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {log.hasMore ? (
        <button
          className={cls('formButtonSecondary', 'atlas-button-secondary')}
          disabled={log.loading}
          onClick={() => void log.loadMore()}
        >
          {labels.loadMore ?? 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
