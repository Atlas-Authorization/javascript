import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Output,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  OrganizationProfileController,
  localizedErrorMessage,
  type OrganizationProfileState,
  type OrganizationRequestError,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

type Tab = 'members' | 'invitations' | 'roles' | 'settings';
type ProfileRole = OrganizationProfileState['roles'][number];

/**
 * `<atlas-organization-profile>` — the active organization's members (admins
 * change roles and remove), invitations (admins invite, revoke and resend) and
 * settings (leave; an admin deletes after confirming their password). The
 * Angular peer of React's `<OrganizationProfile/>`, on the same headless
 * controller. Every control is gated on the ACTIVE org role, matching the
 * server's rule. Renders nothing with no active org. Emits `exit` with `left`
 * or `deleted`.
 */
@Component({
  selector: 'atlas-organization-profile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (atlas.organization(); as membership) {
      @if (state(); as st) {
        <div [class]="cls('card', 'atlas-card')" data-atlas="organization-profile">
          <h1>{{ membership.organization.name }}</h1>
          <p>{{ t('organization.roleLabel') }}: {{ membership.role }}</p>

          <div [class]="cls('menu', 'atlas-menu')" role="tablist">
            @for (key of tabs(); track key) {
              <button
                type="button"
                role="tab"
                [attr.aria-selected]="tab() === key"
                [class]="cls('menuItem', 'atlas-menu-item')"
                [attr.data-atlas]="'organization-tab-' + key"
                (click)="tab.set(key)"
              >
                {{ t('organization.' + key) }}
              </button>
            }
          </div>

          @if (errorMessage(); as message) {
            <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ message }}</p>
          }

          @if (tab() === 'members') {
            <ul class="atlas-list" data-atlas="organization-members">
              @for (m of st.members; track m.id) {
                <li data-atlas="organization-member">
                  <span>{{ memberName(m) }}{{ m.user?.id === userId() ? ' ' + t('organization.you') : '' }}</span>
                  @if (canManage() && m.user && m.user.id !== userId()) {
                    <select
                      [attr.aria-label]="t('organization.roleLabel')"
                      [class]="cls('formFieldInput', 'atlas-input')"
                      [disabled]="st.busy === 'role:' + m.user.id"
                      (change)="changeRole(m.user.id, $any($event.target).value)"
                    >
                      @for (r of roles(); track r.key) {
                        <option [value]="r.key" [selected]="r.key === m.role">{{ r.name }}</option>
                      }
                    </select>
                    <button
                      type="button"
                      [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                      [disabled]="st.busy === 'remove:' + m.user.id"
                      (click)="removeMember(m.user.id)"
                    >
                      {{ t('organization.remove') }}
                    </button>
                  } @else {
                    <span> · {{ m.role }}</span>
                  }
                </li>
              }
            </ul>
          }

          @if (tab() === 'invitations' && canManage()) {
            <div data-atlas="organization-invitations">
              <form (submit)="$event.preventDefault(); sendInvite()">
                <label [class]="cls('formField', 'atlas-field')">
                  <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('organization.emailLabel') }}</span>
                  <input
                    type="email"
                    [class]="cls('formFieldInput', 'atlas-input')"
                    [value]="email()"
                    (input)="email.set($any($event.target).value)"
                  />
                </label>
                <label [class]="cls('formField', 'atlas-field')">
                  <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('organization.roleLabel') }}</span>
                  <select [class]="cls('formFieldInput', 'atlas-input')" (change)="inviteRole.set($any($event.target).value)">
                    @for (r of roles(); track r.key) {
                      <option [value]="r.key" [selected]="r.key === inviteRole()">{{ r.name }}</option>
                    }
                  </select>
                </label>
                <button
                  type="submit"
                  [class]="cls('formButtonPrimary', 'atlas-button')"
                  [disabled]="st.busy === 'invite' || !email().trim()"
                >
                  {{ t('organization.sendInvite') }}
                </button>
              </form>
              @if (st.invitations.length === 0) {
                <p class="atlas-text">{{ t('organization.noInvitations') }}</p>
              } @else {
                <ul class="atlas-list">
                  @for (inv of st.invitations; track inv.id) {
                    <li data-atlas="organization-invitation">
                      <span>{{ inv.email_address }} · {{ inv.role }}</span>
                      <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="resend(inv.id)">
                        {{ t('organization.resend') }}
                      </button>
                      <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="revoke(inv.id)">
                        {{ t('organization.revoke') }}
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
          }

          @if (tab() === 'roles' && canManage()) {
            <div data-atlas="organization-roles">
              @if (customRoles().length === 0) {
                <p class="atlas-text">{{ t('organization.noCustomRoles') }}</p>
              } @else {
                <ul class="atlas-list">
                  @for (role of customRoles(); track role.key) {
                    <li data-atlas="organization-role">
                      <span>{{ role.name }} · {{ role.key }}</span>
                      <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="editRole(role)">
                        {{ t('organization.editRole') }}
                      </button>
                      <button
                        type="button"
                        [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                        [disabled]="!role.id || st.busy === 'role:delete:' + role.id"
                        (click)="deleteRole(role)"
                      >
                        {{ t('organization.deleteRole') }}
                      </button>
                    </li>
                  }
                </ul>
              }
              <form data-atlas="organization-role-form" (submit)="$event.preventDefault(); saveRole()">
                @if (!editingRole()) {
                  <label [class]="cls('formField', 'atlas-field')">
                    <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('organization.roleKey') }}</span>
                    <input
                      name="role_key"
                      [class]="cls('formFieldInput', 'atlas-input')"
                      [value]="roleKey()"
                      (input)="roleKey.set($any($event.target).value)"
                    />
                  </label>
                }
                <label [class]="cls('formField', 'atlas-field')">
                  <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('organization.roleName') }}</span>
                  <input
                    name="role_name"
                    [class]="cls('formFieldInput', 'atlas-input')"
                    [value]="roleName()"
                    (input)="roleName.set($any($event.target).value)"
                  />
                </label>
                <fieldset [class]="cls('formField', 'atlas-field')">
                  <legend [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('organization.rolePermissions') }}</legend>
                  @for (p of st.permissions; track p.key) {
                    <label data-atlas="organization-role-permission">
                      <input
                        type="checkbox"
                        [value]="p.key"
                        [checked]="rolePerms().includes(p.key)"
                        (change)="togglePermission(p.key, $any($event.target).checked)"
                      />
                      {{ p.name }}
                    </label>
                  }
                </fieldset>
                <button
                  type="submit"
                  [class]="cls('formButtonPrimary', 'atlas-button')"
                  [disabled]="!roleName().trim() || (!editingRole() && !roleKey().trim()) || (st.busy ?? '').startsWith('role:')"
                >
                  {{ editingRole() ? t('organization.saveRole') : t('organization.createRole') }}
                </button>
                @if (editingRole()) {
                  <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="resetRoleForm()">
                    {{ t('organization.cancel') }}
                  </button>
                }
              </form>
            </div>
          }

          @if (tab() === 'settings') {
            <div data-atlas="organization-settings">
              @if (confirm(); as action) {
                <p class="atlas-text">
                  {{ t(action === 'leave' ? 'organization.leaveConfirm' : 'organization.deleteConfirm', { name: membership.organization.name }) }}
                </p>
                @if (needsPassword()) {
                  <label [class]="cls('formField', 'atlas-field')">
                    <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('organization.passwordPrompt') }}</span>
                    <input
                      type="password"
                      autocomplete="current-password"
                      [class]="cls('formFieldInput', 'atlas-input')"
                      [value]="password()"
                      (input)="password.set($any($event.target).value)"
                    />
                  </label>
                }
                <button
                  type="button"
                  [class]="cls('formButtonPrimary', 'atlas-button')"
                  [disabled]="st.busy === 'leave' || st.busy === 'delete'"
                  (click)="action === 'leave' ? leave() : remove()"
                >
                  {{ t('organization.confirm') }}
                </button>
                <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="cancel()">
                  {{ t('organization.cancel') }}
                </button>
              } @else {
                <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="confirm.set('leave')">
                  {{ t('organization.leave') }}
                </button>
                @if (isAdmin()) {
                  <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" (click)="confirm.set('delete')">
                    {{ t('organization.delete') }}
                  </button>
                }
              }
            </div>
          }
        </div>
      }
    }
  `,
})
export class OrganizationProfileComponent {
  protected readonly atlas = inject(AtlasService);
  @Output() readonly exit = new EventEmitter<'left' | 'deleted'>();

  private readonly client = this.atlas.createFapiClient();
  private controller: OrganizationProfileController | null = null;
  private unsubscribe: (() => void) | null = null;

  protected readonly state = signal<OrganizationProfileState | null>(null);
  protected readonly tab = signal<Tab>('members');
  protected readonly email = signal('');
  protected readonly inviteRole = signal('org:member');
  protected readonly confirm = signal<'leave' | 'delete' | null>(null);
  protected readonly needsPassword = signal(false);
  protected readonly password = signal('');
  // The custom-role editor: null = creating, else the id of the role being edited.
  protected readonly editingRole = signal<string | null>(null);
  protected readonly roleKey = signal('');
  protected readonly roleName = signal('');
  protected readonly rolePerms = signal<string[]>([]);
  protected readonly customRoles = computed(() => (this.state()?.roles ?? []).filter((r) => Boolean(r.organization_id)));

  protected readonly userId = computed(() => (this.atlas.claims()?.sub as string | undefined) ?? null);
  protected readonly canManage = computed(() => {
    this.atlas.claims();
    return this.atlas.has({ permission: 'org:sys_memberships:manage' });
  });
  protected readonly isAdmin = computed(() => this.atlas.organization()?.role === 'org:admin');
  protected readonly tabs = computed<Tab[]>(() => ['members', ...(this.canManage() ? (['invitations', 'roles'] as Tab[]) : []), 'settings']);
  protected readonly roles = computed(() => {
    const roles = this.state()?.roles ?? [];
    return roles.length > 0 ? roles : [{ key: 'org:member', name: 'org:member' }];
  });
  protected readonly errorMessage = computed(() => {
    const err = this.state()?.error;
    if (!err || (err as OrganizationRequestError).needsReverification) return null;
    return localizedErrorMessage(err, this.atlas.errorLocalization, this.atlas.localization);
  });

  constructor() {
    effect(() => {
      const id = this.atlas.organization()?.organization.id ?? null;
      untracked(() => this.bind(id));
    });
    inject(DestroyRef).onDestroy(() => this.unsubscribe?.());
  }

  private bind(id: string | null) {
    if (this.controller?.organizationId === id) return;
    this.unsubscribe?.();
    this.controller = null;
    this.state.set(null);
    if (!id) return;
    const controller = new OrganizationProfileController(this.client, id, {
      canManage: this.canManage(),
      onChange: async () => {
        await this.atlas.reload();
      },
    });
    this.controller = controller;
    this.unsubscribe = controller.subscribe((next) => this.state.set(next));
    this.state.set(controller.getState());
    void controller.load();
  }

  protected t(key: string, vars?: Record<string, string>): string {
    return translate(this.atlas.localization, key, vars);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected memberName(m: OrganizationProfileState['members'][number]): string {
    return [m.user?.first_name, m.user?.last_name].filter(Boolean).join(' ') || this.t('organization.unnamedMember');
  }

  protected changeRole(userId: string, role: string) {
    void this.controller?.changeRole(userId, role);
  }

  protected removeMember(userId: string) {
    void this.controller?.removeMember(userId);
  }

  protected async sendInvite() {
    const address = this.email().trim();
    if (this.controller && address && (await this.controller.invite(address, this.inviteRole()))) this.email.set('');
  }

  protected resend(id: string) {
    void this.controller?.resendInvitation(id);
  }

  protected revoke(id: string) {
    void this.controller?.revokeInvitation(id);
  }

  protected async leave() {
    if (this.controller && (await this.controller.leave())) this.exit.emit('left');
    this.confirm.set(null);
  }

  protected async remove() {
    const controller = this.controller;
    if (!controller) return;
    if (this.needsPassword()) {
      try {
        await this.atlas.reauthenticate(this.password());
      } catch {
        return;
      }
      this.password.set('');
      this.needsPassword.set(false);
    }
    if (await controller.deleteOrganization()) {
      this.exit.emit('deleted');
      this.confirm.set(null);
      return;
    }
    const err = controller.getState().error as OrganizationRequestError | null;
    if (err?.needsReverification) this.needsPassword.set(true);
  }

  protected editRole(role: ProfileRole) {
    this.editingRole.set(role.id ?? null);
    this.roleKey.set(role.key);
    this.roleName.set(role.name);
    this.rolePerms.set([...(role.permissions ?? [])]);
  }

  protected resetRoleForm() {
    this.editingRole.set(null);
    this.roleKey.set('');
    this.roleName.set('');
    this.rolePerms.set([]);
  }

  protected togglePermission(key: string, on: boolean) {
    this.rolePerms.update((current) => (on ? [...current, key] : current.filter((k) => k !== key)));
  }

  protected async saveRole() {
    const controller = this.controller;
    if (!controller) return;
    const editing = this.editingRole();
    const out = editing
      ? await controller.updateRole(editing, { name: this.roleName().trim(), permissions: this.rolePerms() })
      : await controller.createRole({ key: this.roleKey().trim(), name: this.roleName().trim(), permissions: this.rolePerms() });
    if (out) this.resetRoleForm();
  }

  protected deleteRole(role: ProfileRole) {
    if (role.id) void this.controller?.deleteRole(role.id);
  }

  protected cancel() {
    this.confirm.set(null);
    this.needsPassword.set(false);
    this.password.set('');
  }
}
