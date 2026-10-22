import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { AtlasService } from '../atlas.service';
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
    @if (flow.state().attempt) {
      <atlas-attempt-flow
        [attempt]="flow.state().attempt"
        [busy]="flow.state().busy"
        [errors]="flow.state().errors"
        [sessionKept]="flow.state().sessionKept"
        titleKey="signUp.title"
        (submitFlow)="flow.submit($event)"
      ></atlas-attempt-flow>
    } @else {
      <atlas-sign-up-form
        [settings]="flow.settings()"
        [busy]="flow.state().busy"
        [errors]="flow.state().errors"
        [captcha]="flow.signUpCaptchaDrawn() ? flow.signUpCaptcha : null"
        (submitSignUp)="flow.create($event.values, $event.consent)"
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

  ngOnInit(): void {
    // §5 the instance's sign-up fields, consent policy and captcha settings.
    if (typeof window !== 'undefined') void this.flow.loadSettings();
  }

  ngOnDestroy(): void {
    this.flow.destroy();
  }
}
