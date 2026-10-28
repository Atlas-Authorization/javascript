<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import {
    OrganizationProfileController,
    localizedErrorMessage,
    reauthenticate,
    type OrganizationProfileState,
    type OrganizationRequestError,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { getAuth, getOrganization } from '../accessors';
  import { classFor } from '../appearance';
  import { translate } from '../i18n';
  import { FapiClient } from '../fapi';
  import { ATLAS_SVELTE_SDK } from '../version';

  /**
   * §10.2 `<OrganizationProfile/>` — the active organization's members (admins
   * change roles and remove), invitations (admins invite, revoke, resend) and
   * settings (leave; an admin deletes after confirming their password). Every
   * control is gated on the ACTIVE org role, matching the server's rule.
   * Dispatches `exit` with `'left'` or `'deleted'`.
   */
  const atlas = useAtlas();
  const org = getOrganization();
  const auth = getAuth();
  const dispatch = createEventDispatcher<{ exit: 'left' | 'deleted' }>();
  const t = (key: string, vars?: Record<string, string>) => translate(atlas.catalog, key, vars);
  const cls = (key: Parameters<typeof classFor>[0], base: string) => classFor(key, atlas.appearance, base);
  const errorText = (err: unknown) =>
    localizedErrorMessage(err as Error, atlas.errorCatalog ?? atlas.catalog, atlas.catalog);

  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
    locale: atlas.locale,
    sdk: ATLAS_SVELTE_SDK,
  });

  let controller: OrganizationProfileController | null = null;
  let state: OrganizationProfileState | null = null;
  let unsubscribe: (() => void) | null = null;
  let currentId: string | null = null;
  let tab: 'members' | 'invitations' | 'roles' | 'settings' = 'members';
  // The custom-role editor: null = creating, else the id of the role being edited.
  let editingRole: string | null = null;
  let roleKey = '';
  let roleName = '';
  let rolePerms: string[] = [];
  let email = '';
  let inviteRole = 'org:member';
  let confirm: 'leave' | 'delete' | null = null;
  let needsPassword = false;
  let password = '';

  $: canManage = $auth.has({ permission: 'org:sys_memberships:manage' });
  $: isAdmin = $org.membership?.role === 'org:admin';
  $: roles = state && state.roles.length > 0 ? state.roles : [{ key: 'org:member', name: 'org:member' }];
  $: errorMessage =
    state?.error && !(state.error as OrganizationRequestError).needsReverification ? errorText(state.error) : null;
  $: tabs = ['members', ...(canManage ? ['invitations', 'roles'] : []), 'settings'] as Array<typeof tab>;
  $: customRoles = state ? state.roles.filter((r) => Boolean(r.organization_id)) : [];
  $: {
    const id = $org.organization?.id ?? null;
    if (id !== currentId) {
      currentId = id;
      unsubscribe?.();
      controller = null;
      state = null;
      if (id) {
        controller = new OrganizationProfileController(client, id, {
          canManage,
          onChange: async () => {
            await atlas.reload();
          },
        });
        unsubscribe = controller.subscribe((next) => (state = next));
        state = controller.getState();
        void controller.load();
      }
    }
  }
  onDestroy(() => unsubscribe?.());

  const memberName = (m: OrganizationProfileState['members'][number]) =>
    [m.user?.first_name, m.user?.last_name].filter(Boolean).join(' ') || t('organization.unnamedMember');

  async function sendInvite() {
    const address = email.trim();
    if (controller && address && (await controller.invite(address, inviteRole))) email = '';
  }

  async function leave() {
    if (controller && (await controller.leave())) dispatch('exit', 'left');
    confirm = null;
  }

  async function remove() {
    if (!controller) return;
    if (needsPassword) {
      try {
        await reauthenticate(
          { strategy: 'password', password },
          { api: atlas.frontendApi, publishableKey: atlas.publishableKey, locale: atlas.locale },
        );
      } catch {
        return;
      }
      password = '';
      needsPassword = false;
    }
    if (await controller.deleteOrganization()) {
      dispatch('exit', 'deleted');
      confirm = null;
      return;
    }
    const err = controller.getState().error as OrganizationRequestError | null;
    if (err?.needsReverification) needsPassword = true;
  }

  function resetRoleForm() {
    editingRole = null;
    roleKey = '';
    roleName = '';
    rolePerms = [];
  }

  function editRole(role: OrganizationProfileState['roles'][number]) {
    editingRole = role.id ?? null;
    roleKey = role.key;
    roleName = role.name;
    rolePerms = [...(role.permissions ?? [])];
  }

  function togglePermission(key: string, on: boolean) {
    rolePerms = on ? [...rolePerms, key] : rolePerms.filter((k) => k !== key);
  }

  async function saveRole() {
    if (!controller) return;
    const out = editingRole
      ? await controller.updateRole(editingRole, { name: roleName.trim(), permissions: rolePerms })
      : await controller.createRole({ key: roleKey.trim(), name: roleName.trim(), permissions: rolePerms });
    if (out) resetRoleForm();
  }

  function cancel() {
    confirm = null;
    needsPassword = false;
    password = '';
  }
</script>

{#if $org.organization && controller && state}
  <div class={cls('card', 'atlas-card')} data-atlas="organization-profile">
    <h1>{$org.organization.name}</h1>
    <p>{t('organization.roleLabel')}: {$org.membership?.role}</p>

    <div class={cls('menu', 'atlas-menu')} role="tablist">
      {#each tabs as key}
        <button
          type="button"
          role="tab"
          aria-selected={tab === key}
          class={cls('menuItem', 'atlas-menu-item')}
          data-atlas={`organization-tab-${key}`}
          on:click={() => (tab = key)}
        >
          {t(`organization.${key}`)}
        </button>
      {/each}
    </div>

    {#if errorMessage}
      <p class={cls('formFieldError', 'atlas-error')} role="alert">{errorMessage}</p>
    {/if}

    {#if tab === 'members'}
      <ul class={'atlas-list'} data-atlas="organization-members">
        {#each state.members as m (m.id)}
          <li data-atlas="organization-member">
            <span>{memberName(m)}{m.user?.id === $auth.userId ? ` ${t('organization.you')}` : ''}</span>
            {#if canManage && m.user && m.user.id !== $auth.userId}
              <select
                aria-label={t('organization.roleLabel')}
                class={cls('formFieldInput', 'atlas-input')}
                value={m.role}
                disabled={state.busy === `role:${m.user.id}`}
                on:change={(e) => m.user && controller?.changeRole(m.user.id, e.currentTarget.value)}
              >
                {#each roles as r}<option value={r.key}>{r.name}</option>{/each}
              </select>
              <button
                type="button"
                class={cls('formButtonSecondary', 'atlas-button-secondary')}
                disabled={state.busy === `remove:${m.user.id}`}
                on:click={() => m.user && controller?.removeMember(m.user.id)}
              >
                {t('organization.remove')}
              </button>
            {:else}
              <span> · {m.role}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if tab === 'invitations' && canManage}
      <div data-atlas="organization-invitations">
        <form on:submit|preventDefault={sendInvite}>
          <label class={cls('formField', 'atlas-field')}>
            <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.emailLabel')}</span>
            <input type="email" class={cls('formFieldInput', 'atlas-input')} bind:value={email} />
          </label>
          <label class={cls('formField', 'atlas-field')}>
            <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.roleLabel')}</span>
            <select class={cls('formFieldInput', 'atlas-input')} bind:value={inviteRole}>
              {#each roles as r}<option value={r.key}>{r.name}</option>{/each}
            </select>
          </label>
          <button type="submit" class={cls('formButtonPrimary', 'atlas-button')} disabled={state.busy === 'invite' || !email.trim()}>
            {t('organization.sendInvite')}
          </button>
        </form>
        {#if state.invitations.length === 0}
          <p class={'atlas-text'}>{t('organization.noInvitations')}</p>
        {:else}
          <ul class={'atlas-list'}>
            {#each state.invitations as inv (inv.id)}
              <li data-atlas="organization-invitation">
                <span>{inv.email_address} · {inv.role ?? ''}</span>
                <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={() => controller?.resendInvitation(inv.id)}>
                  {t('organization.resend')}
                </button>
                <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={() => controller?.revokeInvitation(inv.id)}>
                  {t('organization.revoke')}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if tab === 'roles' && canManage}
      <div data-atlas="organization-roles">
        {#if customRoles.length === 0}
          <p class={'atlas-text'}>{t('organization.noCustomRoles')}</p>
        {:else}
          <ul class={'atlas-list'}>
            {#each customRoles as role (role.id ?? role.key)}
              <li data-atlas="organization-role">
                <span>{role.name} · {role.key}</span>
                <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={() => editRole(role)}>
                  {t('organization.editRole')}
                </button>
                <button
                  type="button"
                  class={cls('formButtonSecondary', 'atlas-button-secondary')}
                  disabled={!role.id || state.busy === `role:delete:${role.id}`}
                  on:click={() => role.id && controller?.deleteRole(role.id)}
                >
                  {t('organization.deleteRole')}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <form data-atlas="organization-role-form" on:submit|preventDefault={saveRole}>
          {#if !editingRole}
            <label class={cls('formField', 'atlas-field')}>
              <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.roleKey')}</span>
              <input name="role_key" class={cls('formFieldInput', 'atlas-input')} bind:value={roleKey} />
            </label>
          {/if}
          <label class={cls('formField', 'atlas-field')}>
            <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.roleName')}</span>
            <input name="role_name" class={cls('formFieldInput', 'atlas-input')} bind:value={roleName} />
          </label>
          <fieldset class={cls('formField', 'atlas-field')}>
            <legend class={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.rolePermissions')}</legend>
            {#each state.permissions as p (p.key)}
              <label data-atlas="organization-role-permission">
                <input
                  type="checkbox"
                  value={p.key}
                  checked={rolePerms.includes(p.key)}
                  on:change={(e) => togglePermission(p.key, e.currentTarget.checked)}
                />
                {p.name}
              </label>
            {/each}
          </fieldset>
          <button
            type="submit"
            class={cls('formButtonPrimary', 'atlas-button')}
            disabled={!roleName.trim() || (!editingRole && !roleKey.trim()) || Boolean(state.busy?.startsWith('role:'))}
          >
            {editingRole ? t('organization.saveRole') : t('organization.createRole')}
          </button>
          {#if editingRole}
            <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={resetRoleForm}>
              {t('organization.cancel')}
            </button>
          {/if}
        </form>
      </div>
    {/if}

    {#if tab === 'settings'}
      <div data-atlas="organization-settings">
        {#if confirm}
          <p class={'atlas-text'}>
            {t(confirm === 'leave' ? 'organization.leaveConfirm' : 'organization.deleteConfirm', { name: $org.organization.name })}
          </p>
          {#if needsPassword}
            <label class={cls('formField', 'atlas-field')}>
              <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('organization.passwordPrompt')}</span>
              <input type="password" autocomplete="current-password" class={cls('formFieldInput', 'atlas-input')} bind:value={password} />
            </label>
          {/if}
          <button
            type="button"
            class={cls('formButtonPrimary', 'atlas-button')}
            disabled={state.busy === 'leave' || state.busy === 'delete'}
            on:click={() => (confirm === 'leave' ? leave() : remove())}
          >
            {t('organization.confirm')}
          </button>
          <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={cancel}>
            {t('organization.cancel')}
          </button>
        {:else}
          <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={() => (confirm = 'leave')}>
            {t('organization.leave')}
          </button>
          {#if isAdmin}
            <button type="button" class={cls('formButtonSecondary', 'atlas-button-secondary')} on:click={() => (confirm = 'delete')}>
              {t('organization.delete')}
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}
