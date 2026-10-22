import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { signUp as hostedSignUp } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { translate } from '../i18n';
import { AttemptFlowComponent } from './attempt-flow.component';
import { AtlasFlowController } from './flow-controller';

/**
 * `<atlas-sign-in>` — the full, multi-step sign-in flow driven entirely by the
 * server-side attempt status. The Angular peer of React's `<SignIn/>`. Draws the
 * instance's sign-in captcha when it is required (always-on, or a
 * `needs_captcha` challenge).
 *
 * ```html
 * <atlas-sign-in *atlasSignedOut afterUrl="/dashboard"></atlas-sign-in>
 * ```
 */
@Component({
  selector: 'atlas-sign-in',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AttemptFlowComponent],
  template: `
    <atlas-attempt-flow
      [attempt]="flow.state().attempt"
      [busy]="flow.state().busy"
      [errors]="flow.state().errors"
      [sessionKept]="flow.state().sessionKept"
      titleKey="signIn.title"
      [captcha]="flow.captchaDrawn() ? flow.captcha : null"
      [firstFactors]="flow.firstFactors()"
      [preparedFactor]="flow.preparedFactor()"
      (submitFlow)="flow.submit($event)"
      (chooseFactor)="flow.prepare($event)"
    ></atlas-attempt-flow>
    @if (flow.state().attempt?.status !== 'complete' && signUpHref(); as href) {
      <p class="atlas-footer" data-atlas-sign-up-prompt="">
        {{ t('signIn.noAccount') }} <a class="atlas-link" [href]="href">{{ t('signIn.signUpLink') }}</a>
      </p>
    }
  `,
})
export class SignInComponent implements OnInit, OnDestroy {
  private readonly atlas = inject(AtlasService);

  /** Where to send the user once the flow completes. Reserved for host routing. */
  @Input() afterUrl?: string;
  /**
   * Where "No account? Sign up" goes. Default: the instance's hosted sign-up
   * page (carrying the visitor's referral). `null` hides it. Always shown, never
   * only after a failed sign-in, so it says nothing about whether an email has an account.
   */
  @Input() signUpUrl?: string | null;

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected signUpHref(): string | null {
    if (this.signUpUrl === null) return null;
    if (this.signUpUrl) return this.signUpUrl;
    try {
      return hostedSignUp({
        frontendApi: this.atlas.frontendApi,
        redirectUrl: this.afterUrl ?? (typeof window !== 'undefined' ? window.location.href : undefined),
        navigate: false,
      });
    } catch {
      return null;
    }
  }

  protected readonly flow = new AtlasFlowController(
    this.atlas.createFapiClient(),
    () => this.atlas.reload(),
    // Resume mid-flow if an OAuth redirect came back owing a second factor.
    this.atlas.pendingAttempt,
    (key) => translate(this.atlas.localization, key),
  );

  ngOnInit(): void {
    // If seeded from a pending attempt that is already pollable, start polling.
    this.flow.syncPolling();
    // §5 the instance's captcha settings (switching captcha on in the dashboard
    // draws it here with no code change) and email delivery (no emailed-code
    // option while the app cannot send email).
    if (typeof window !== 'undefined') void this.flow.loadSettings();
  }

  ngOnDestroy(): void {
    this.flow.destroy();
  }
}
