import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  Input,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { emailLinkFromUrl, type EmailLink } from '@atlasauth/js';
import { awaitingPasskey, existingAccountResetUrl, localizedErrorMessage, passkeysSupported, signInAfterProofUrl, signUpProvedByLink, type FieldError } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';
import { AttemptFlowComponent } from './attempt-flow.component';
import { EmailLinkComponent } from './email-link.component';
import { RecoveryCodesComponent } from './recovery-codes.component';
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
  imports: [EmailLinkComponent, AttemptFlowComponent, RecoveryCodesComponent, SignUpFormComponent],
  template: `
    @if (emailLink(); as link) {
      <atlas-email-link [link]="link"></atlas-email-link>
    } @else {
    @if (flow.recoveryCodes(); as codes) {
      <atlas-recovery-codes [codes]="codes" [busy]="flow.state().busy" (saved)="flow.saveRecoveryCodes()"></atlas-recovery-codes>
    } @else if (flow.existingAccountNotice()) {
      <div [class]="cls('card', 'atlas-card')" data-atlas-existing-account="">
        <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('signUp.title') }}</h1>
        <p class="atlas-text">{{ t('signUp.existingAccount') }}</p>
        @if (resetHref(); as href) {
          <p class="atlas-text"><a class="atlas-link" [href]="href">{{ t('signIn.forgotPassword') }}</a></p>
        }
        <button
          [class]="cls('formButtonPrimary', 'atlas-button')"
          type="button"
          [disabled]="flow.state().busy"
          (click)="flow.continueAfterExistingAccount()"
        >
          {{ t('signUp.submit') }}
        </button>
      </div>
    } @else if (awaitingPasskey()) {
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
    } @else if (emailConfirmed()) {
      <div [class]="cls('card', 'atlas-card')" data-atlas-email-confirmed="">
        <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('signUp.title') }}</h1>
        <p class="atlas-text" role="status">{{ t('signUp.emailConfirmed') }}</p>
        @if (signInHref(); as href) {
          <a [class]="cls('formButtonPrimary', 'atlas-button')" [href]="href">{{ t('signIn.title') }}</a>
        }
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
        [matchCode]="flow.state().matchCode ?? null"
        [offerEmailSecondFactor]="flow.settings()?.account?.emailSecondFactor === true"
        [emailedSecondFactor]="flow.emailSecondFactor()"
        [offerSmsSecondFactor]="flow.settings() !== null && flow.mfaChoices().sms"
        [textedSecondFactor]="flow.smsSecondFactor()"
        [enrollment]="flow.enrollment"
        [enrollmentState]="flow.enrollmentState()"
        (emailSecondFactor)="flow.sendEmailSecondFactor()"
        (smsSecondFactor)="flow.sendSmsSecondFactor()"
        (policyDeclined)="flow.declinePolicy($event)"
        [signInHref]="signInHref()"
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
    }
  `,
})
export class SignUpComponent implements OnInit, OnDestroy {
  private readonly atlas = inject(AtlasService);

  /** Opened from a mailed link: that page, not the flow. Read after the first render, so hydration matches. */
  protected readonly emailLink = signal<EmailLink | null>(null);

  constructor() {
    afterNextRender(() => this.emailLink.set(emailLinkFromUrl(undefined, 'sign_up')));
  }

  /** Where to send the user once the flow completes. Reserved for host routing. */
  @Input() afterUrl?: string;

  /** Where the existing-account notice's "Forgot password?" goes. Default: the hosted sign-in page; `null` hides it. */
  @Input() resetPasswordUrl?: string | null;

  /** Where "Sign in" goes once an emailed link confirmed the address and made no session here. Default: the hosted sign-in page; `null` hides it. */
  @Input() signInUrl?: string | null;

  protected readonly flow = new AtlasFlowController(
    this.atlas.createFapiClient(),
    () => this.atlas.reload(),
    this.atlas.pendingAttempt,
    (key) => translate(this.atlas.localization, key),
    true,
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

  protected resetHref(): string | null {
    return existingAccountResetUrl({ url: this.resetPasswordUrl, frontendApi: this.atlas.frontendApi, redirectUrl: this.afterUrl });
  }

  /** A link confirmed the address and made no session here. Says the same for any address. */
  protected emailConfirmed(): boolean {
    return signUpProvedByLink(this.flow.state().attempt);
  }

  protected signInHref(): string | null {
    return signInAfterProofUrl({ url: this.signInUrl, frontendApi: this.atlas.frontendApi, redirectUrl: this.afterUrl });
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
