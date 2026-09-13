import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  inject,
} from '@angular/core';
import { AtlasService } from '../atlas.service';
import { AttemptFlowComponent } from './attempt-flow.component';
import { AtlasFlowController } from './flow-controller';

/**
 * `<atlas-sign-up>` — the full, server-driven sign-up flow. The Angular peer of
 * React's `<SignUp/>`. It shares the exact flow engine with `<atlas-sign-in>`;
 * only the title differs, because the sequence of steps is decided by the server.
 *
 * ```html
 * <atlas-sign-up *atlasSignedOut></atlas-sign-up>
 * ```
 */
@Component({
  selector: 'atlas-sign-up',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AttemptFlowComponent],
  template: `
    <atlas-attempt-flow
      [attempt]="flow.state().attempt"
      [busy]="flow.state().busy"
      [errors]="flow.state().errors"
      titleKey="signUp.title"
      (submitFlow)="flow.submit($event)"
    ></atlas-attempt-flow>
  `,
})
export class SignUpComponent implements OnDestroy {
  private readonly atlas = inject(AtlasService);

  /** Where to send the user once the flow completes. Reserved for host routing. */
  @Input() afterUrl?: string;

  protected readonly flow = new AtlasFlowController(
    this.atlas.createFapiClient(),
    () => this.atlas.reload(),
    this.atlas.pendingAttempt,
  );

  ngOnDestroy(): void {
    this.flow.destroy();
  }
}
