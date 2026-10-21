import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
                  @if (verifying() === email.id) {
                    <span data-atlas="email-verify">
                      <input
                        [class]="cls('formFieldInput', 'atlas-account-input')"
                        inputmode="numeric"
                        autocomplete="one-time-code"
                        [placeholder]="t('userProfile.verifyCodePlaceholder')"
                        [value]="code()"
                        (input)="code.set($any($event.target).value)"
                      />
                      <button
                        [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                        type="button"
                        [disabled]="busy()"
                        (click)="confirmCode()"
                      >
                        {{ t('userProfile.verifyConfirm') }}
                      </button>
                    </span>
                  } @else {
                    <button
                      [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                      type="button"
                      [disabled]="busy()"
                      (click)="sendCode(email.id)"
                    >
                      {{ t('userProfile.verify') }}
                    </button>
                  }
                }
              </li>
            }
          </ul>
          @if (verifyError(); as message) {
            <p role="alert">{{ message }}</p>
          }
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
  // An unverified address (added and never confirmed, or the sign-up address on
  // an app that did not require verification) can be proven here: send a code,
  // then enter it.
  protected readonly verifying = signal<string | null>(null);
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly verifyError = signal<string | null>(null);
  private readonly client = this.atlas.createFapiClient();

  protected async sendCode(id: string): Promise<void> {
    this.verifyError.set(null);
    this.busy.set(true);
    const res = await this.client.post(`/v1/client/me/email_addresses/${id}/prepare_verification`);
    this.busy.set(false);
    if (!res.ok) {
      this.verifyError.set(this.t('userProfile.verifySendFailed'));
      return;
    }
    this.code.set('');
    this.verifying.set(id);
  }

  protected async confirmCode(): Promise<void> {
    const id = this.verifying();
    if (!id) return;
    this.verifyError.set(null);
    this.busy.set(true);
    const res = await this.client.post(`/v1/client/me/email_addresses/${id}/attempt_verification`, {
      code: this.code(),
    });
    this.busy.set(false);
    if (!res.ok) {
      this.verifyError.set(this.t('userProfile.verifyCodeRejected'));
      return;
    }
    this.verifying.set(null);
    await this.atlas.reload();
  }

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
