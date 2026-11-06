import { ChangeDetectionStrategy, Component, Input, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { createEmailLinkConfirmation, localizedErrorMessage, type EmailLink, type EmailLinkConfirmationState, type FieldError } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * What `<atlas-sign-in>` / `<atlas-sign-up>` draw when opened from a mailed link:
 * tries this browser's stored secret, then asks for the code the starting tab
 * shows. A success signs nobody in here: the starting tab continues on its own.
 */
@Component({
  selector: 'atlas-email-link',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="cls('card', 'atlas-card')" data-atlas="email-link" [attr.data-atlas-status]="state().status">
      <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('link.title') }}</h1>
      @if (state().status === 'needs_code') {
        <form (submit)="onSubmit($event)">
          <p class="atlas-text">{{ t('link.enterCodeHelp') }}</p>
          <label class="atlas-field">
            <span>{{ t('link.codeLabel') }}</span>
            <input [class]="cls('formFieldInput', 'atlas-input')" type="text" name="match_code" autocomplete="off" inputmode="numeric" required [value]="code" (input)="code = $any($event.target).value" />
          </label>
          @for (error of state().errors; track error.code) {
            <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ errorText(error) }}</p>
          }
          <button [class]="cls('formButtonPrimary', 'atlas-button')" type="submit" [disabled]="state().busy">{{ t('link.confirm') }}</button>
        </form>
      } @else {
        <p class="atlas-text" role="status" aria-live="polite">{{ t(message()) }}</p>
      }
      @if (state().resetUrl; as resetUrl) {
        <p class="atlas-text"><a class="atlas-link" data-atlas-reset-link="" [href]="resetUrl">{{ t('signIn.forgotPassword') }}</a></p>
      }
    </div>
  `,
})
export class EmailLinkComponent implements OnInit, OnDestroy {
  private readonly atlas = inject(AtlasService);

  @Input({ required: true }) link!: EmailLink;

  protected readonly state = signal<EmailLinkConfirmationState>({ status: 'checking', busy: false, errors: [] });
  protected code = '';
  private controller: ReturnType<typeof createEmailLinkConfirmation> | null = null;
  private stop: (() => void) | null = null;

  ngOnInit(): void {
    this.controller = createEmailLinkConfirmation(this.atlas.createFapiClient(), this.link);
    this.stop = this.controller.subscribe((next) => this.state.set(next));
    void this.controller.start();
  }

  ngOnDestroy(): void {
    this.stop?.();
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    void this.controller?.submitCode(this.code);
  }

  protected message(): string {
    const status = this.state().status;
    return status === 'confirmed' ? 'link.confirmed' : status === 'invalid' ? 'link.invalid' : 'link.checking';
  }

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected errorText(error: FieldError): string {
    return localizedErrorMessage(error, this.atlas.localization);
  }
}
