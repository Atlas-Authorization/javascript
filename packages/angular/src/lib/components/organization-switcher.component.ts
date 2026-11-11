import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { activateOrgOrStepUp, orgStepUpOptions, runOrgStepUp, type OrgStepUpError } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * `<atlas-organization-switcher>` — switch the active organization (or the
 * personal account). The Angular peer of React's `<OrganizationSwitcher/>`.
 */
@Component({
  selector: 'atlas-organization-switcher',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="cls('menu', 'atlas-menu')">
      <button [class]="cls('menuItem', 'atlas-menu-item')" (click)="setActive(null)">
        {{ t('organization.personal') }}
      </button>
      @for (membership of atlas.memberships(); track membership.organization.id) {
        <button
          [class]="cls('menuItem', 'atlas-menu-item')"
          [disabled]="membership.organization.id === atlas.organization()?.organization?.id"
          (click)="setActive(membership.organization.id)"
        >
          {{ membership.organization.name }}
        </button>
      }
      @if (pending(); as p) {
        <div data-atlas="organization-step-up" role="dialog" [attr.aria-label]="t('mfa.title')">
          <p>{{ t('mfa.subtitle') }}</p>
          @if (options(p).totp) {
            <input
              [attr.aria-label]="t('mfa.codeLabel')"
              inputmode="numeric"
              autocomplete="one-time-code"
              [value]="code()"
              (input)="code.set($any($event.target).value)"
            />
            <button type="button" (click)="confirm({ code: code() })">{{ t('mfa.submit') }}</button>
          }
          @if (options(p).passkey) {
            <button type="button" (click)="confirm({ passkey: true })">{{ t('mfa.usePasskey') }}</button>
          }
          @if (error(); as e) {
            <p role="alert">{{ e }}</p>
          }
          <button type="button" (click)="cancel()">{{ t('organization.cancel') }}</button>
        </div>
      }
    </div>
  `,
})
export class OrganizationSwitcherComponent {
  protected readonly atlas = inject(AtlasService);
  private readonly client = this.atlas.createFapiClient();
  protected readonly pending = signal<{ id: string | null; err: OrgStepUpError } | null>(null);
  protected readonly code = signal('');
  protected readonly error = signal<string | null>(null);

  protected options(p: { err: OrgStepUpError }) {
    return orgStepUpOptions(p.err);
  }

  protected cancel(): void {
    this.pending.set(null);
    this.code.set('');
    this.error.set(null);
  }

  // An org whose policy needs a fresh second factor: show the prompt, step up, retry.
  protected async confirm(input: { code: string } | { passkey: true }): Promise<void> {
    const p = this.pending();
    if (!p) return;
    this.error.set(null);
    const res = await runOrgStepUp(this.client, input, this.t('error.generic'));
    // `in` narrows under the library build's settings too (a boolean discriminant does not there).
    if ('message' in res) {
      this.error.set(res.message);
      return;
    }
    this.cancel();
    await this.setActive(p.id);
  }

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected async setActive(organizationId: string | null): Promise<void> {
    const err = await activateOrgOrStepUp((id) => this.atlas.setActiveOrganization(id), organizationId);
    if (err) this.pending.set({ id: organizationId, err });
  }
}
