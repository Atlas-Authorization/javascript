import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  inject,
} from '@angular/core';
import type {
  CaptchaController,
  FieldError,
  InstanceSettings,
  PublicSignUpField,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';
import { AtlasCaptchaSlotDirective } from '../directives/captcha-slot.directive';

/** What the create-account form emits: the values typed plus the consent tick. */
export interface SignUpFormSubmit {
  values: Record<string, string>;
  consent: boolean;
}

/**
 * The create-account step of `<atlas-sign-up>`: the instance's configured extra
 * fields, email + password, the legal-consent row and — when the instance
 * requires one on sign-up — the captcha widget. Values live on the component so
 * a refused submit never clears them.
 */
@Component({
  selector: 'atlas-sign-up-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtlasCaptchaSlotDirective],
  template: `
    <div [class]="cls('card', 'atlas-card')">
      <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('signUp.title') }}</h1>

      @for (error of formErrors(); track error.code) {
        <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ error.message }}</p>
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
                <span [class]="cls('formFieldError', 'atlas-error')">{{ error.message }}</span>
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
                <span [class]="cls('formFieldError', 'atlas-error')">{{ error.message }}</span>
              }
            </label>
          }
        }

        <label [class]="cls('formField', 'atlas-field')">
          <span [class]="cls('formFieldLabel', 'atlas-field-label')">{{ t('signUp.emailLabel') }}</span>
          <input
            [class]="cls('formFieldInput', 'atlas-input')"
            type="email"
            name="email"
            autocomplete="email"
            required
            [value]="values['email'] ?? ''"
            (input)="setValue('email', $any($event.target).value)"
          />
          @for (error of fieldErrorsFor('email'); track error.code) {
            <span [class]="cls('formFieldError', 'atlas-error')">{{ error.message }}</span>
          }
        </label>

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
            <span [class]="cls('formFieldError', 'atlas-error')">{{ error.message }}</span>
          }
        </label>

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
              <span [class]="cls('formFieldError', 'atlas-error')">{{ error.message }}</span>
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
      </form>
    </div>
  `,
})
export class SignUpFormComponent {
  private readonly atlas = inject(AtlasService);

  @Input() settings: InstanceSettings | null = null;
  @Input() busy = false;
  @Input() errors: FieldError[] = [];
  @Input() captcha: CaptchaController | null = null;

  /** Emits the typed values and the consent tick when the form is submitted. */
  @Output() submitSignUp = new EventEmitter<SignUpFormSubmit>();

  protected values: Record<string, string> = {};
  protected agreed = false;

  protected t(key: string, vars?: Record<string, string>): string {
    return translate(this.atlas.localization, key, vars);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected setValue(name: string, value: string): void {
    this.values = { ...this.values, [name]: value };
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
    const legal = this.settings?.legal;
    return !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
  }

  protected consentOk(): boolean {
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
    if (!this.consentOk()) return;
    this.submitSignUp.emit({
      values: { ...this.values },
      consent: this.settings?.legal?.required ? this.agreed : true,
    });
  }
}
