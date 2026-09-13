import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { AtlasService } from '../atlas.service';
import { AttemptFlowComponent } from './attempt-flow.component';
import { AtlasFlowController } from './flow-controller';

/**
 * `<atlas-sign-in>` — the full, multi-step sign-in flow driven entirely by the
 * server-side attempt status. The Angular peer of React's `<SignIn/>`.
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
      titleKey="signIn.title"
      (submitFlow)="flow.submit($event)"
    ></atlas-attempt-flow>
  `,
})
export class SignInComponent implements OnInit, OnDestroy {
  private readonly atlas = inject(AtlasService);

  /** Where to send the user once the flow completes. Reserved for host routing. */
  @Input() afterUrl?: string;

  protected readonly flow = new AtlasFlowController(
    this.atlas.createFapiClient(),
    () => this.atlas.reload(),
    // Resume mid-flow if an OAuth redirect came back owing a second factor.
    this.atlas.pendingAttempt,
  );

  ngOnInit(): void {
    // If seeded from a pending attempt that is already pollable, start polling.
    this.flow.syncPolling();
  }

  ngOnDestroy(): void {
    this.flow.destroy();
  }
}
