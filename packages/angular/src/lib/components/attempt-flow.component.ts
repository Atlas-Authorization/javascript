import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  inject,
} from '@angular/core';
import {
  awaitingSignUpLink,
  enrollmentSubmitKey,
  groupSetupKey,
  localizedErrorMessage,
  nextStep,
  type AttemptView,
  type CaptchaController,
  type FieldError,
  type MfaEnrollmentController,
  type MfaEnrollmentState,
  type MfaEnrollmentStrategy,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { AtlasCaptchaSlotDirective } from '../directives/captcha-slot.directive';
import { PolicyAcceptStepComponent } from './policy-host';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * One rendered row of the flow. A uniform shape (rather than a discriminated
 * union) so the template accesses only fields that always exist — no reliance on
 * template control-flow narrowing of a loop variable, which varies by Angular
 * minor. For a `message` row, `labelKey` carries the message's i18n key.
 */
interface StepField {
  kind: 'input' | 'message' | 'alert';
  name: string;
  labelKey: string;
  type: string;
}

/**
 * The server-driven flow shell, shared by `<atlas-sign-in>` and
 * `<atlas-sign-up>`. The Angular peer of React's internal `AttemptFlow`.
 *
 * It contains NO decision about what comes next: it renders whatever `status`
 * the server returned, mapped through `nextStep` from `@atlasauth/js` (the same
 * exhaustive mapping the React SDK uses), so adding a step is a server change
 * and an out-of-date client degrades to a visible "please update" message rather
 * than a blank screen.
 */
@Component({
  selector: 'atlas-attempt-flow',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtlasCaptchaSlotDirective, PolicyAcceptStepComponent],
  template: `
    <div [class]="cls('card', 'atlas-card')">
      <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t(titleKey) }}</h1>

      @for (error of formErrors(); track error.code) {
        <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ errorText(error) }}</p>
      }

      <form (submit)="onSubmit($event)">
        @if (codeSentText(); as sentText) {
          <p class="atlas-text" data-atlas-code-sent="">{{ sentText }}</p>
        }
        @if (linkOnly()) {
          <!-- Nothing to type: the flow polls until the emailed link is opened (anywhere). -->
          <p class="atlas-text" data-atlas-link-sent="" aria-live="polite">
            {{ t('signUp.linkSentTo', { email: attempt?.identifier ?? '' }) }}
          </p>
          <button
            [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
            type="button"
            data-atlas-resend=""
            [disabled]="busy"
            (click)="resend.emit()"
          >
            {{ t('signIn.resendLink') }}
          </button>
        }
        @if (enrolling() && enrollmentState; as enrol) {
          @if (enrol.method === null) {
            <p class="atlas-text">{{ t('mfa.enrollChoose') }}</p>
            @for (m of enrol.options; track m) {
              <button
                [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                type="button"
                [attr.data-atlas-mfa-method]="m"
                [disabled]="busy || enrol.busy"
                (click)="chooseMethod(m)"
              >
                {{ t(m === 'totp' ? 'mfa.enrollTotpOption' : 'mfa.enrollSmsOption') }}
              </button>
            }
          } @else if (enrol.method === 'totp') {
            @if (enrol.enrollment; as setup) {
              <p class="atlas-text">{{ t('mfa.enrollScan') }}</p>
              @if (setup.qrCode) {
                <img class="atlas-mfa-qr" data-atlas="mfa-qr" [src]="setup.qrCode" [alt]="t('mfa.enrollQrAlt')" width="180" height="180" />
              }
              @if (setup.secret) {
                <p class="atlas-text" data-atlas="mfa-setup-key">{{ t('mfa.enrollSetupKey') }}: <code>{{ setupKey(setup.secret) }}</code></p>
              }
              <label class="atlas-field">
                <span>{{ t('mfa.enrollFirstCodeLabel') }}</span>
                <input [class]="cls('formFieldInput', 'atlas-input')" type="text" name="code" autocomplete="one-time-code" inputmode="numeric" [value]="values['code'] ?? ''" (input)="setValue('code', $any($event.target).value)" />
              </label>
              @if (enrol.totpCodes >= 2) {
                <label class="atlas-field">
                  <span>{{ t('mfa.enrollSecondCodeLabel') }}</span>
                  <input [class]="cls('formFieldInput', 'atlas-input')" type="text" name="secondCode" autocomplete="one-time-code" inputmode="numeric" [value]="values['secondCode'] ?? ''" (input)="setValue('secondCode', $any($event.target).value)" />
                </label>
              }
            } @else {
              <p class="atlas-text" aria-live="polite">{{ enrol.busy ? t('mfa.enrollPreparing') : '' }}</p>
            }
          } @else {
            @if (enrol.enrollment; as texted) {
              <p class="atlas-text" data-atlas="mfa-code-texted" aria-live="polite">{{ t('mfa.codeTextedTo', { phone: texted.phone ?? '' }) }}</p>
              <label class="atlas-field">
                <span>{{ t('mfa.codeLabel') }}</span>
                <input [class]="cls('formFieldInput', 'atlas-input')" type="text" name="code" autocomplete="one-time-code" inputmode="numeric" [value]="values['code'] ?? ''" (input)="setValue('code', $any($event.target).value)" />
              </label>
              <button
                [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                type="button"
                data-atlas-resend=""
                [disabled]="busy || enrol.busy"
                (click)="resendEnrollment()"
              >
                {{ t('signIn.resendCode') }}
              </button>
            } @else {
              <label class="atlas-field">
                <span>{{ t('mfa.phoneLabel') }}</span>
                <input [class]="cls('formFieldInput', 'atlas-input')" type="tel" name="phone" autocomplete="tel" [value]="values['phone'] ?? ''" (input)="setValue('phone', $any($event.target).value)" />
              </label>
              <p class="atlas-text">{{ t('mfa.phoneHint') }}</p>
            }
          }
          @for (error of enrol.errors; track $index) {
            <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ error.message }}</p>
          }
          @if (enrol.method !== null && enrol.options.length > 1) {
            @for (other of otherMethods(enrol); track other) {
              <button
                [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
                type="button"
                [attr.data-atlas-mfa-method]="other"
                [disabled]="busy || enrol.busy"
                (click)="chooseMethod(other)"
              >
                {{ t(other === 'totp' ? 'mfa.enrollTotpOption' : 'mfa.enrollSmsOption') }}
              </button>
            }
          }
        }
        @for (f of fields(); track $index) {
          @if (f.kind === 'input') {
            <label class="atlas-field">
              <span>{{ t(f.labelKey) }}</span>
              <input
                [class]="cls('formFieldInput', 'atlas-input')"
                [type]="f.type"
                [attr.name]="f.name"
                [value]="values[f.name] ?? ''"
                (input)="setValue(f.name, $any($event.target).value)"
              />
              @for (error of fieldErrorsFor(f.name); track error.code) {
                <span [class]="cls('formFieldError', 'atlas-error')">{{ errorText(error) }}</span>
              }
            </label>
          } @else if (f.kind === 'alert') {
            <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ t(f.labelKey) }}</p>
          } @else {
            <p>{{ t(f.labelKey) }}</p>
          }
        }

        @if (awaitingPolicies()) {
          <!-- A required policy changed: scroll-mode ones in their dialog, the rest as checkboxes. -->
          <atlas-policy-accept-step
            [attempt]="attempt"
            [busy]="busy"
            (submitFlow)="submitFlow.emit($event)"
            (declined)="policyDeclined.emit($event)"
          ></atlas-policy-accept-step>
        }

        @if (showCaptcha()) {
          <div class="atlas-captcha" data-atlas-captcha="" [atlasCaptchaSlot]="captcha"></div>
        }

        @if (showSubmit()) {
          <button [class]="cls('formButtonPrimary', 'atlas-button')" [disabled]="busy || (enrolling() && !!enrollmentState?.busy)" type="submit">
            {{ t(submitKey()) }}
          </button>
        }

        @if (showSmsSecondFactor()) {
          @if (smsSecondFactorSentTo(); as sentTo) {
            <p class="atlas-text" data-atlas="sms-second-factor-sent" aria-live="polite">
              {{ t('mfa.codeTextedTo', { phone: sentTo }) }}
            </p>
          } @else {
            <button
              [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
              type="button"
              data-atlas="sms-second-factor"
              [disabled]="busy || !!textedSecondFactor?.busy"
              (click)="smsSecondFactor.emit()"
            >
              {{ textedSecondFactor?.busy ? t('signIn.sending') : t('mfa.smsCodeOption') }}
            </button>
            @if (textedSecondFactor?.error; as message) {
              <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ message }}</p>
            }
          }
        }

        @if (showEmailSecondFactor()) {
          @if (emailSecondFactorSentTo(); as sentTo) {
            <p class="atlas-text" data-atlas="email-second-factor-sent" aria-live="polite">
              {{ t('signIn.codeSentTo', { email: sentTo }) }}
            </p>
          } @else {
            <button
              [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
              type="button"
              data-atlas="email-second-factor"
              [disabled]="busy || !!emailedSecondFactor?.busy"
              (click)="emailSecondFactor.emit()"
            >
              {{ emailedSecondFactor?.busy ? t('signIn.sending') : t('signIn.emailCodeOption') }}
            </button>
            @if (emailedSecondFactor?.error; as message) {
              <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ message }}</p>
            }
          }
        }

        @if (showEmailCodeOption()) {
          <button
            [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
            [disabled]="busy"
            type="button"
            [attr.data-strategy]="preparedFactor === 'email_code' ? null : 'email_code'"
            [attr.data-atlas-resend]="preparedFactor === 'email_code' ? '' : null"
            (click)="chooseFactor.emit('email_code')"
          >
            {{ t(preparedFactor === 'email_code' ? 'signIn.resendCode' : 'signIn.useEmailCode') }}
          </button>
        }
      </form>
    </div>
  `,
})
export class AttemptFlowComponent {
  private readonly atlas = inject(AtlasService);

  @Input() attempt: AttemptView | null = null;
  @Input() busy = false;
  @Input() errors: FieldError[] = [];
  /** `FlowState.sessionKept`: whether this browser kept the session the sign-in created. */
  @Input() sessionKept: boolean | undefined = undefined;
  @Input() titleKey = 'signIn.title';
  /**
   * The sign-in captcha, drawn above the submit button on the identifier step
   * (an always-on sign-in captcha) and on the challenge step the server demands
   * with `needs_captcha`. Null when the flow draws none.
   */
  @Input() captcha: CaptchaController | null = null;
  /**
   * The first factors to offer on the `needs_first_factor` step — pass
   * `AtlasFlowController.firstFactors()`, which drops email code / link while the
   * app cannot deliver email. Null uses the server's list as-is.
   */
  @Input() firstFactors: string[] | null = null;
  /** The first factor already sent (`AtlasFlowController.preparedFactor()`): its code is collected. */
  @Input() preparedFactor: string | null = null;

  /** Emits the collected field values when the form is submitted. */
  @Output() submitFlow = new EventEmitter<Record<string, string>>();
  /** Emits when the user picks a first factor the server must send first (an emailed code). */
  @Output() chooseFactor = new EventEmitter<'email_code'>();
  /**
   * Offer "Email me a code instead" at the second factor (the instance's
   * `account.emailSecondFactor`); `emailSecondFactor` asks for it and
   * `emailedSecondFactor` reports how it went.
   */
  @Input() offerEmailSecondFactor = false;
  /** `AtlasFlowController.emailSecondFactor()`: in flight, where it went, or why not. */
  @Input() emailedSecondFactor: { busy?: boolean; sentTo?: string; error?: string } | null = null;
  @Output() emailSecondFactor = new EventEmitter<void>();
  /**
   * Offer "Text me a code instead" at the second factor (where the app offers
   * texted codes, `AtlasFlowController.mfaChoices().sms`); `smsSecondFactor`
   * asks for it and `textedSecondFactor` reports how it went.
   */
  @Input() offerSmsSecondFactor = false;
  /** `AtlasFlowController.smsSecondFactor()`: in flight, where it went, or why not. */
  @Input() textedSecondFactor: { busy?: boolean; sentTo?: string; error?: string } | null = null;
  @Output() smsSecondFactor = new EventEmitter<void>();
  /**
   * The MFA enrolment step (`AtlasFlowController.enrollment` and
   * `enrollmentState()`): the authenticator app's QR code and setup key, or a
   * texted code. Null: the step asks for two authenticator codes only.
   */
  @Input() enrollment: MfaEnrollmentController | null = null;
  @Input() enrollmentState: MfaEnrollmentState | null = null;
  /**
   * The instance's `account.emailVerification`. On `link` a sign-up's
   * verification step has nothing to type: it says to open the emailed link
   * while the flow polls, and offers a resend (`resend`).
   */
  @Input() emailVerification: string = 'code';
  @Output() resend = new EventEmitter<void>();
  /** The user declined a policy the sign-in was waiting on (`needs_policy_acceptance`): cancel the attempt. */
  @Output() policyDeclined = new EventEmitter<string>();

  protected values: Record<string, string> = {};

  protected t(key: string, vars?: Record<string, string>): string {
    return translate(this.atlas.localization, key, vars);
  }

  /** A server error in the app's language (`error.<reason>`, else the server's message). */
  protected errorText(error: FieldError): string {
    // `errorLocalization` is read defensively: a stand-in service may lack it.
    const layer = (this.atlas as { errorLocalization?: Record<string, string> }).errorLocalization;
    return localizedErrorMessage(error, layer ?? this.atlas.localization, this.atlas.localization);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected setValue(name: string, value: string): void {
    this.values = { ...this.values, [name]: value };
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    // Enrolment: text the code to the typed number, or confirm the factor.
    if (this.enrolling() && this.enrollment) {
      void this.enrollment.submit(this.values).then((next) => {
        if (next) this.submitFlow.emit(next);
      });
      return;
    }
    this.submitFlow.emit(this.values);
  }

  /** The shared enrolment step is drawn (a controller was passed and the flow is enrolling). */
  protected enrolling(): boolean {
    return this.step().kind === 'enroll_second_factor' && !!this.enrollment && !!this.enrollmentState;
  }

  protected chooseMethod(method: MfaEnrollmentStrategy): void {
    this.values = {};
    void this.enrollment?.choose(method);
  }

  protected resendEnrollment(): void {
    void this.enrollment?.resend();
  }

  protected otherMethods(state: MfaEnrollmentState): MfaEnrollmentStrategy[] {
    return state.options.filter((m) => m !== state.method);
  }

  protected setupKey(secret: string): string {
    return groupSetupKey(secret);
  }

  /** The submit button's label key (enrolment: "Text me a code" before the number is sent). */
  protected submitKey(): string {
    return (this.enrolling() && this.enrollmentState && enrollmentSubmitKey(this.enrollmentState)) || 'signIn.submit';
  }

  protected showSmsSecondFactor(): boolean {
    return this.offerSmsSecondFactor && this.step().kind === 'collect_second_factor';
  }

  /** Where the texted second-factor code went (masked), once it was sent. */
  protected smsSecondFactorSentTo(): string | null {
    const sent = this.textedSecondFactor?.sentTo;
    return typeof sent === 'string' ? sent || ' ' : null;
  }

  protected formErrors(): FieldError[] {
    return this.errors.filter((error) => !error.param);
  }

  protected fieldErrorsFor(name: string): FieldError[] {
    return this.errors.filter((error) => error.param === name);
  }

  private step() {
    return this.attempt ? nextStep(this.attempt) : ({ kind: 'collect_identifier' } as const);
  }

  protected showCaptcha(): boolean {
    const kind = this.step().kind;
    return !!this.captcha && (kind === 'collect_identifier' || kind === 'collect_captcha');
  }

  /** The first factors on offer at a `needs_first_factor` step (empty on any other). */
  private offered(): string[] {
    const step = this.step();
    if (step.kind !== 'collect_first_factor') return [];
    return this.firstFactors ?? step.strategies;
  }

  protected linkOnly(): boolean {
    return awaitingSignUpLink(this.attempt, this.emailVerification);
  }

  protected showEmailSecondFactor(): boolean {
    return this.offerEmailSecondFactor && this.step().kind === 'collect_second_factor';
  }

  /** Where the emailed second-factor code went (masked), once it was sent. */
  protected emailSecondFactorSentTo(): string | null {
    const sent = this.emailedSecondFactor?.sentTo;
    return typeof sent === 'string' ? sent || ' ' : null;
  }

  protected showEmailCodeOption(): boolean {
    // Before the code is sent: the choice (or the retry of a failed automatic
    // send). After: "Resend code".
    return this.offered().includes('email_code');
  }

  /** The "we sent a code to …" line on the code step. */
  protected codeSentText(): string | null {
    if (this.step().kind !== 'collect_first_factor' || this.preparedFactor !== 'email_code') return null;
    return this.t('signIn.codeSentTo', { email: this.attempt?.identifier ?? '' });
  }

  /** The attempt is `needs_policy_acceptance`. */
  protected awaitingPolicies(): boolean {
    return this.step().kind === 'accept_policies';
  }

  protected showSubmit(): boolean {
    const kind = this.step().kind;
    // Nothing to submit on a first-factor step that only offers an emailed code
    // until that code is sent.
    if (kind === 'collect_first_factor') return this.fields().length > 0;
    if (this.linkOnly()) return false;
    // Enrolment: nothing to submit while choosing a method or fetching the setup.
    if (this.enrolling() && this.enrollmentState && !enrollmentSubmitKey(this.enrollmentState)) return false;
    return kind !== 'done' && kind !== 'await_oauth' && kind !== 'accept_policies';
  }

  protected fields(): StepField[] {
    const step = this.step();
    switch (step.kind) {
      case 'collect_identifier':
        return [{ kind: 'input', name: 'identifier', labelKey: 'signIn.identifierLabel', type: 'email' }];
      case 'collect_first_factor': {
        if (this.preparedFactor === 'email_code') {
          return [{ kind: 'input', name: 'code', labelKey: 'signIn.emailCodeLabel', type: 'text' }];
        }
        // The password field unless the only offer is an emailed code (chosen
        // with the button below the form).
        const offered = this.offered();
        return offered.includes('email_code') && !offered.includes('password')
          ? []
          : [{ kind: 'input', name: 'password', labelKey: 'signIn.passwordLabel', type: 'password' }];
      }
      case 'collect_second_factor':
        return [{ kind: 'input', name: 'code', labelKey: 'mfa.codeLabel', type: 'text' }];
      case 'enroll_second_factor':
        // The shared enrolment step draws its own fields (above).
        if (this.enrolling()) return [];
        // Two consecutive codes (§5.6): a phone with a fast clock fails here
        // rather than on every sign-in afterwards.
        return [
          { kind: 'input', name: 'code', labelKey: 'mfa.enrollFirstCodeLabel', type: 'text' },
          { kind: 'input', name: 'secondCode', labelKey: 'mfa.enrollSecondCodeLabel', type: 'text' },
        ];
      case 'collect_email_code':
        return this.linkOnly() ? [] : [{ kind: 'input', name: 'code', labelKey: 'signIn.emailCodeLabel', type: 'text' }];
      case 'collect_new_password':
        return [{ kind: 'input', name: 'password', labelKey: 'reset.newPasswordLabel', type: 'password' }];
      case 'accept_policies':
        // Drawn by <atlas-policy-accept-step> above.
        return [];
      case 'collect_captcha':
        // §5 the server withheld the attempt until a captcha clears. Solving the
        // widget resubmits the identifier on its own; the button retries.
        return [msg('captcha.prompt')];
      case 'await_oauth':
        return [msg('signIn.magicLinkSent')];
      case 'done':
        // Signed in only when this browser holds the session; a blocked cookie is said
        // plainly. "Check the other tab" is for a sign-in completed on another device.
        if (this.sessionKept === true) return [msg('signIn.signedIn')];
        if (this.sessionKept === false) return [{ kind: 'alert', name: '', labelKey: 'signIn.sessionNotKept', type: 'text' }];
        return [msg('signIn.checkOtherTab')];
      case 'restart':
        return [msg('error.generic')];
      default:
        // A status this SDK version does not know. An honest message beats a
        // blank login box the user cannot act on.
        return [msg('error.generic')];
    }
  }
}

/** A read-only message row: `labelKey` holds the i18n key of the text to show. */
function msg(labelKey: string): StepField {
  return { kind: 'message', name: '', labelKey, type: 'text' };
}
