import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
    </div>
  `,
})
export class OrganizationSwitcherComponent {
  protected readonly atlas = inject(AtlasService);

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected setActive(organizationId: string | null): void {
    void this.atlas.setActiveOrganization(organizationId);
  }
}
