import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * `<atlas-user-profile>` — the signed-in user's account surface (emails,
 * security). The Angular peer of React's `<UserProfile/>`. Renders nothing when
 * there is no user.
 */
@Component({
  selector: 'atlas-user-profile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (atlas.user(); as user) {
      <div [class]="cls('card', 'atlas-card')">
        <h1>{{ t('userProfile.title') }}</h1>

        <section>
          <h2>{{ t('userProfile.emailsSection') }}</h2>
          <ul>
            @for (email of user.email_addresses ?? []; track email.id) {
              <li>
                {{ email.email_address }}
                @if (!email.verified) {
                  <em> — {{ t('userProfile.unverified') }}</em>
                }
              </li>
            }
          </ul>
        </section>

        <section>
          <h2>{{ t('userProfile.securitySection') }}</h2>
          <p>{{ user.mfa_enabled ? '2FA on' : '2FA off' }}</p>
        </section>
      </div>
    }
  `,
})
export class UserProfileComponent {
  protected readonly atlas = inject(AtlasService);

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
