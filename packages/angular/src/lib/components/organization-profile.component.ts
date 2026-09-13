import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AtlasService } from '../atlas.service';
import { AtlasProtectDirective } from '../directives/protect.directive';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * `<atlas-organization-profile>` — the active organization's surface. The
 * Angular peer of React's `<OrganizationProfile/>`. Management controls are
 * gated on the ACTIVE org role via `*atlasProtect`, matching the server's rule
 * rather than duplicating a looser one. Renders nothing with no active org.
 */
@Component({
  selector: 'atlas-organization-profile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtlasProtectDirective],
  template: `
    @if (atlas.organization(); as membership) {
      <div [class]="cls('card', 'atlas-card')">
        <h1>{{ membership.organization.name }}</h1>
        <p>{{ t('organization.roleLabel') }}: {{ membership.role }}</p>

        <button *atlasProtect="{ permission: 'org:sys_memberships:manage' }">
          {{ t('organization.invite') }}
        </button>
      </div>
    }
  `,
})
export class OrganizationProfileComponent {
  protected readonly atlas = inject(AtlasService);

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
