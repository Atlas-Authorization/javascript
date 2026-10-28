import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { awaitingPasskey, localizedErrorMessage, passkeysSupported, type FieldError } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';
import { AttemptFlowComponent } from './attempt-flow.component';
import { SignUpFormComponent } from './sign-up-form.component';
import { AtlasFlowController } from './flow-controller';

/**
 * `<atlas-sign-up>` — creates an account. The Angular peer of React's
 * `<SignUp/>`. The first step is the create-account form (the instance's
 * configured fields, email, password, legal consent and — when required — the
 * captcha), which POSTs `/v1/client/sign_ups`; from there it shares the flow
 * engine with `<atlas-sign-in>` (the emailed-code step, then the ticket
 * exchange), because the sequence of steps is decided by the server.
 *
 * ```html
 * <atlas-sign-up *atlasSignedOut></atlas-sign-up>
 * ```
 */
@Component({
  selector: 'atlas-sign-up',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AttemptFlowComponent, SignUpFormComponent],
  template: `
    @if (awaitingPasskey()) {
      <div [class]="cls('card', 'atlas-card')" data-atlas-passkey-sign-up="">
        <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('signUp.title') }}</h1>
        @for (error of flow.state().errors; track error.code) {
          <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ errorText(error) }}</p>
        }
        <p class="atlas-text">{{ t('signUp.passkeyPrompt') }}</p>
        <button
          [class]="cls('formButtonPrimary', 'atlas-button')"
          type="button"
          [disabled]="flow.state().busy"
          (click)="flow.createPasskey()"
        >
          {{ t('signUp.passkeyCreate') }}
        </button>
      </div>
    } @else if (flow.state().attempt) {
      <atlas-attempt-flow
        [attempt]="flow.state().attempt"
        [busy]="flow.state().busy"
        [errors]="flow.state().errors"
        [sessionKept]="flow.state().sessionKept"
        titleKey="signUp.title"
        [emailVerification]="flow.settings()?.account?.emailVerification ?? 'code'"
        (submitFlow)="flow.submit($event)"
        (resend)="flow.resendSignUp()"
      ></atlas-attempt-flow>
    } @else {
      <atlas-sign-up-form
        [settings]="flow.settings()"
        [busy]="flow.state().busy"
        [errors]="flow.state().errors"
        [captcha]="flow.signUpCaptchaDrawn() ? flow.signUpCaptcha : null"
        [policies]="flow.policies"
        [passkey]="passkeyForm()"
        [switchable]="canPasskey()"
        (switchMode)="toggleMode()"
        (submitSignUp)="
          passkeyForm() ? flow.createWithPasskey($event.values, $event.consent) : flow.create($event.values, $event.consent)
        "
      ></atlas-sign-up-form>
    }
  `,
})
export class SignUpComponent implements OnInit, OnDestroy {
  private readonly atlas = inject(AtlasService);

  /** Where to send the user once the flow completes. Reserved for host routing. */
  @Input() afterUrl?: string;

  protected readonly flow = new AtlasFlowController(
    this.atlas.createFapiClient(),
    () => this.atlas.reload(),
    this.atlas.pendingAttempt,
    (key) => translate(this.atlas.localization, key),
  );

  /** Password or passkey-only sign-up (the latter when the instance offers it). */
  protected readonly mode = signal<'password' | 'passkey'>('password');

  protected canPasskey(): boolean {
    return !!this.flow.settings()?.account.passkeySignUp && passkeysSupported();
  }

  protected passkeyForm(): { email: 'off' | 'optional' | 'required' } | null {
    const offer = this.flow.settings()?.account.passkeySignUp ?? null;
    return this.mode() === 'passkey' && offer && this.canPasskey() ? { email: offer.email } : null;
  }

  protected toggleMode(): void {
    this.flow.state.update((current) => ({ ...current, errors: [] }));
    this.mode.set(this.passkeyForm() ? 'password' : 'passkey');
  }

  protected awaitingPasskey(): boolean {
    return awaitingPasskey(this.flow.state().attempt);
  }

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected errorText(error: FieldError): string {
    const layer = (this.atlas as { errorLocalization?: Record<string, string> }).errorLocalization;
    return localizedErrorMessage(error, layer ?? this.atlas.localization, this.atlas.localization);
  }

  ngOnInit(): void {
    // §5 the instance's sign-up fields, consent policy and captcha settings.
    if (typeof window !== 'undefined') {
      void this.flow.loadSettings();
      void this.flow.loadPolicies(this.atlas.locale ?? undefined);
    }
  }

  ngOnDestroy(): void {
    this.flow.destroy();
  }
}
