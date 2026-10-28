import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  inject,
  type SimpleChanges,
} from '@angular/core';
import {
  confirmPolicies,
  localizedErrorMessage,
  type PolicyAcceptanceController,
  type CaptchaController,
  type FieldError,
  type InstanceSettings,
  type PublicSignUpField,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';
import { AtlasCaptchaSlotDirective } from '../directives/captcha-slot.directive';
import { AtlasPoliciesDirective, policyUi } from './policy-host';

/** What the create-account form emits: the values typed plus the consent tick. */
export interface SignUpFormSubmit {
  values: Record<string, string>;
  consent: boolean;
}

/**
 * The create-account step of `<atlas-sign-up>`: the instance's configured extra
 * fields, email + password, the legal-consent row and — when the instance
 * requires one on sign-up — the captcha widget. Values live on the component so
 * a refused submit never clears them. When the app cannot send the verification
 * email (`settings.emailDelivery.passwordSignUp === false`) it shows the
 * `signUp.emailUnavailable` notice instead of the form.
 */
@Component({
  selector: 'atlas-sign-up-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtlasCaptchaSlotDirective, AtlasPoliciesDirective],
  template: `
    <div [class]="cls('card', 'atlas-card')">
      <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('signUp.title') }}</h1>

      @if (emailUnavailable()) {
        <!-- The app cannot send the verification email, so an email + password
             sign-up could never complete: say so instead of offering the form. -->
        <p [class]="cls('formFieldError', 'atlas-error')" role="alert" data-atlas-email-unavailable="">
          {{ t('signUp.emailUnavailable') }}
        </p>
      } @else {
      @for (error of formErrors(); track error.code) {
        <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ errorText(error) }}</p>
      }

      <form (submit)="onSubmit($event)">
        @for (f of fields(); track f.key) {
          @if (f.type === 'radio' || f.type === 'multiselect') {
            <div [class]="cls('formField', 'atlas-field')">
              <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ label(f) }}</span>
              <span class="atlas-choices">
                @for (o of f.options; track o) {
                  <label class="atlas-choice">
                    <input
                      [type]="f.type === 'radio' ? 'radio' : 'checkbox'"
                      [attr.name]="f.key"
                      [value]="o"
                      [checked]="picked(f.key).includes(o)"
                      (change)="toggle(f, o, $any($event.target).checked)"
                    />
                    {{ o }}
                  </label>
                }
              </span>
              @for (error of fieldErrorsFor(f.key); track error.code) {
                <span [class]="cls('formFieldError', 'atlas-error')">{{ errorText(error) }}</span>
              }
            </div>
          } @else {
            <label [class]="cls('formField', 'atlas-field')">
              <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ label(f) }}</span>
              @if (f.type === 'checkbox') {
                <input
                  type="checkbox"
                  [attr.name]="f.key"
                  [checked]="values[f.key] === 'true'"
                  (change)="setValue(f.key, $any($event.target).checked ? 'true' : '')"
                />
              } @else if (f.type === 'select') {
                <select
                  [class]="cls('formFieldInput', 'atlas-input')"
                  [attr.name]="f.key"
                  [value]="values[f.key] ?? ''"
                  [required]="f.required"
                  (change)="setValue(f.key, $any($event.target).value)"
                >
                  <option value="">{{ f.placeholder ?? t('signUp.selectPlaceholder') }}</option>
                  @for (o of f.options; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
              } @else if (f.type === 'textarea') {
                <textarea
                  [class]="cls('formFieldInput', 'atlas-input')"
                  [attr.name]="f.key"
                  rows="3"
                  [value]="values[f.key] ?? ''"
                  [required]="f.required"
                  [attr.placeholder]="f.placeholder"
                  (input)="setValue(f.key, $any($event.target).value)"
                ></textarea>
              } @else {
                <input
                  [class]="cls('formFieldInput', 'atlas-input')"
                  [type]="inputType(f)"
                  [attr.name]="f.key"
                  [value]="values[f.key] ?? ''"
                  [required]="f.required"
                  [attr.placeholder]="f.placeholder"
                  (input)="setValue(f.key, $any($event.target).value)"
                />
              }
              @for (error of fieldErrorsFor(f.key); track error.code) {
                <span [class]="cls('formFieldError', 'atlas-error')">{{ errorText(error) }}</span>
              }
            </label>
          }
        }

        @if (showEmail()) {
        <label [class]="cls('formField', 'atlas-field')">
          <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{
            emailRequired() ? t('signUp.emailLabel') : t('signUp.optionalField', { label: t('signUp.emailLabel') })
          }}</span>
          <input
            [class]="cls('formFieldInput', 'atlas-input')"
            type="email"
            name="email"
            autocomplete="email"
            [required]="emailRequired()"
            [value]="values['email'] ?? ''"
            (input)="setValue('email', $any($event.target).value)"
          />
          @for (error of fieldErrorsFor('email'); track error.code) {
            <span [class]="cls('formFieldError', 'atlas-error')">{{ errorText(error) }}</span>
          }
        </label>
        }

        @if (passkey) {
          <p class="atlas-text">{{ t('signUp.passkeyIntro') }}</p>
        } @else {
        <label [class]="cls('formField', 'atlas-field')">
          <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('signUp.passwordLabel') }}</span>
          <input
            [class]="cls('formFieldInput', 'atlas-input')"
            type="password"
            name="password"
            autocomplete="new-password"
            required
            [value]="values['password'] ?? ''"
            (input)="setValue('password', $any($event.target).value)"
          />
          @for (error of fieldErrorsFor('password'); track error.code) {
            <span [class]="cls('formFieldError', 'atlas-error')">{{ errorText(error) }}</span>
          }
        </label>
        }

        @if (hasPolicies()) {
          <div [atlasPolicies]="policies"></div>
          @if (declined) {
            <span [class]="cls('formFieldError', 'atlas-error')" role="alert" data-atlas-policy-declined="">
              {{ t('policy.declined', { policy: declined }) }}
            </span>
          }
        }

        @if (showLegal()) {
          <label [class]="cls('formField', 'atlas-consent')">
            @if (settings?.legal?.required) {
              <input
                type="checkbox"
                name="consent"
                [checked]="agreed"
                (change)="agreed = $any($event.target).checked"
              />
            }
            <span class="atlas-text">
              {{ t(settings?.legal?.required ? 'signUp.consentAgree' : 'signUp.consentNotice') }}
              @if (settings?.legal?.termsUrl; as terms) {
                <a class="atlas-link" [href]="terms" target="_blank" rel="noopener noreferrer">{{ t('signUp.terms') }}</a>
              }
              @if (settings?.legal?.termsUrl && settings?.legal?.privacyUrl) {
                {{ t('signUp.and') }}
              }
              @if (settings?.legal?.privacyUrl; as privacy) {
                <a class="atlas-link" [href]="privacy" target="_blank" rel="noopener noreferrer">{{ t('signUp.privacy') }}</a>
              }.
            </span>
            @for (error of fieldErrorsFor('consent'); track error.code) {
              <span [class]="cls('formFieldError', 'atlas-error')">{{ errorText(error) }}</span>
            }
          </label>
        }

        @if (captcha) {
          <div class="atlas-captcha" data-atlas-captcha="" [atlasCaptchaSlot]="captcha"></div>
        }

        <button
          [class]="cls('formButtonPrimary', 'atlas-button')"
          [disabled]="busy || !consentOk()"
          type="submit"
        >
          {{ t('signUp.submit') }}
        </button>
        @if (hasPolicies()) {
          <p atlasPolicyKind="clickwrap" [atlasPolicies]="policies"></p>
        }
        @if (switchable) {
          <div class="atlas-alternatives">
            <button
              type="button"
              [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
              [attr.data-atlas-sign-up-mode]="passkey ? 'password' : 'passkey'"
              [disabled]="busy"
              (click)="switchMode.emit()"
            >
              {{ t(passkey ? 'signUp.passwordOption' : 'signUp.passkeyOption') }}
            </button>
          </div>
        }
      </form>
      }
    </div>
  `,
})
export class SignUpFormComponent implements OnChanges, OnDestroy {
  private readonly atlas = inject(AtlasService);
  private readonly cdr = inject(ChangeDetectorRef);
  private unwatch: (() => void) | null = null;

  @Input() settings: InstanceSettings | null = null;
  @Input() busy = false;
  @Input() errors: FieldError[] = [];
  @Input() captcha: CaptchaController | null = null;
  /** Passkey-only sign-up: no password field; the email per the instance's mode. */
  @Input() passkey: { email: 'off' | 'optional' | 'required' } | null = null;
  /** Whether the password / passkey toggle is shown (both are offered). */
  @Input() switchable = false;
  /** The instance's policies (terms, privacy, …); they replace the legacy consent row. */
  @Input() policies: PolicyAcceptanceController | null = null;
  /** The user asked for the other sign-up method. */
  @Output() switchMode = new EventEmitter<void>();

  /** Emits the typed values and the consent tick when the form is submitted. */
  @Output() submitSignUp = new EventEmitter<SignUpFormSubmit>();

  protected values: Record<string, string> = {};
  protected agreed = false;
  protected declined: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['policies']) return;
    this.unwatch?.();
    this.unwatch = this.policies?.subscribe(() => this.cdr.markForCheck()) ?? null;
  }

  ngOnDestroy(): void {
    this.unwatch?.();
  }

  protected hasPolicies(): boolean {
    return !!this.policies && this.policies.policies.length > 0;
  }

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

  /** Email + password sign-up cannot complete: the app cannot send the verification email. */
  protected emailUnavailable(): boolean {
    // A passkey sign-up that collects no email (or an unproven one) sends no mail.
    if (this.passkey && this.passkey.email !== 'required') return false;
    return this.settings?.emailDelivery?.passwordSignUp === false;
  }

  protected showEmail(): boolean {
    return !this.passkey || this.passkey.email !== 'off';
  }

  protected emailRequired(): boolean {
    return !this.passkey || this.passkey.email === 'required';
  }

  protected fields(): PublicSignUpField[] {
    return this.settings?.signUpFields ?? [];
  }

  protected label(f: PublicSignUpField): string {
    return f.required ? f.label : this.t('signUp.optionalField', { label: f.label });
  }

  protected inputType(f: PublicSignUpField): string {
    return ['email', 'tel', 'url', 'number', 'date'].includes(f.type) ? f.type : 'text';
  }

  /** Same encoding as React, the embed widget and the hosted page: one value,
   *  or a comma-joined list for multiselect. */
  protected picked(key: string): string[] {
    const value = this.values[key];
    return value ? value.split(', ') : [];
  }

  protected toggle(f: PublicSignUpField, option: string, on: boolean): void {
    if (f.type === 'radio') {
      this.setValue(f.key, option);
      return;
    }
    const current = this.picked(f.key);
    this.setValue(f.key, (on ? [...current, option] : current.filter((p) => p !== option)).join(', '));
  }

  protected showLegal(): boolean {
    // Instance policies replace the legacy single "I agree to the Terms" row.
    if (this.hasPolicies()) return false;
    const legal = this.settings?.legal;
    return !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
  }

  protected consentOk(): boolean {
    if (this.hasPolicies()) return this.policies!.canSubmit();
    return !this.settings?.legal?.required || this.agreed;
  }

  protected formErrors(): FieldError[] {
    return this.errors.filter((error) => !error.param);
  }

  protected fieldErrorsFor(name: string): FieldError[] {
    return this.errors.filter((error) => error.param === name);
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    if (this.emailUnavailable() || !this.consentOk()) return;
    this.declined = null;
    if (this.hasPolicies()) {
      // Scroll-mode policies are read in their unskippable dialog first.
      const values = { ...this.values };
      void confirmPolicies(this.policies!, { t: policyUi(this.atlas).t }).then((res) => {
        if (res.ok) this.submitSignUp.emit({ values, consent: true });
        else {
          this.declined = res.declined;
          this.cdr.markForCheck();
        }
      });
      return;
    }
    this.submitSignUp.emit({
      values: { ...this.values },
      consent: this.settings?.legal?.required ? this.agreed : true,
    });
  }
}
