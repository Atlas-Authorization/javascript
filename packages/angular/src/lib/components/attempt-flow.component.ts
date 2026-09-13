import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  inject,
} from '@angular/core';
import { nextStep, type AttemptView, type FieldError } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * One rendered row of the flow. A uniform shape (rather than a discriminated
 * union) so the template accesses only fields that always exist — no reliance on
 * template control-flow narrowing of a loop variable, which varies by Angular
 * minor. For a `message` row, `labelKey` carries the message's i18n key.
 */
interface StepField {
  kind: 'input' | 'message';
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
  template: `
    <div [class]="cls('card', 'atlas-card')">
      <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t(titleKey) }}</h1>

      @for (error of formErrors(); track error.code) {
        <p [class]="cls('formFieldError', 'atlas-error')" role="alert">{{ error.message }}</p>
      }

      <form (submit)="onSubmit($event)">
        @for (f of fields(); track $index) {
          @if (f.kind === 'input') {
            <label class="atlas-field">
              <span>{{ t(f.labelKey) }}</span>
              <input
                [class]="cls('formFieldInput', 'atlas-input')"
                [type]="f.type"
                [value]="values[f.name] ?? ''"
                (input)="setValue(f.name, $any($event.target).value)"
              />
              @for (error of fieldErrorsFor(f.name); track error.code) {
                <span [class]="cls('formFieldError', 'atlas-error')">{{ error.message }}</span>
              }
            </label>
          } @else {
            <p>{{ t(f.labelKey) }}</p>
          }
        }

        @if (showSubmit()) {
          <button [class]="cls('formButtonPrimary', 'atlas-button')" [disabled]="busy" type="submit">
            {{ t('signIn.submit') }}
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
  @Input() titleKey = 'signIn.title';

  /** Emits the collected field values when the form is submitted. */
  @Output() submitFlow = new EventEmitter<Record<string, string>>();

  protected values: Record<string, string> = {};

  protected t(key: string, vars?: Record<string, string>): string {
    return translate(this.atlas.localization, key, vars);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected setValue(name: string, value: string): void {
    this.values = { ...this.values, [name]: value };
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.submitFlow.emit(this.values);
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

  protected showSubmit(): boolean {
    const kind = this.step().kind;
    return kind !== 'done' && kind !== 'await_oauth';
  }

  protected fields(): StepField[] {
    const step = this.step();
    switch (step.kind) {
      case 'collect_identifier':
        return [{ kind: 'input', name: 'identifier', labelKey: 'signIn.identifierLabel', type: 'email' }];
      case 'collect_first_factor':
        return [{ kind: 'input', name: 'password', labelKey: 'signIn.passwordLabel', type: 'password' }];
      case 'collect_second_factor':
        return [{ kind: 'input', name: 'code', labelKey: 'mfa.codeLabel', type: 'text' }];
      case 'enroll_second_factor':
        // Two consecutive codes (§5.6): a phone with a fast clock fails here
        // rather than on every sign-in afterwards.
        return [
          { kind: 'input', name: 'code', labelKey: 'mfa.enrollFirstCodeLabel', type: 'text' },
          { kind: 'input', name: 'secondCode', labelKey: 'mfa.enrollSecondCodeLabel', type: 'text' },
        ];
      case 'collect_email_code':
        return [{ kind: 'input', name: 'code', labelKey: 'signIn.emailCodeLabel', type: 'text' }];
      case 'collect_new_password':
        return [{ kind: 'input', name: 'password', labelKey: 'reset.newPasswordLabel', type: 'password' }];
      case 'await_oauth':
        return [msg('signIn.magicLinkSent')];
      case 'done':
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
