import {
  Directive,
  Input,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewContainerRef,
  inject,
} from '@angular/core';
import { BehaviorSubject, Subscription, combineLatest } from 'rxjs';
import { AtlasService } from '../atlas.service';
import { evaluate, type ProtectCondition } from '@atlasauth/authz';

/**
 * `*atlasProtect` — render the template only when the active organization role
 * satisfies a {@link ProtectCondition}. The Angular peer of React's
 * `<Protect permission="…">`.
 *
 * A RENDERING helper, never an authorization boundary: anyone can flip the
 * condition in devtools. The server checking the same permission is what
 * actually stops them — this directive's only job is to avoid showing a control
 * that would fail.
 *
 * ```html
 * <button *atlasProtect="{ permission: 'org:sys_memberships:manage' }">Invite</button>
 *
 * <!-- with a fallback (identical microsyntax to *ngIf … else) -->
 * <div *atlasProtect="{ role: 'admin' }; else denied">Admin tools</div>
 * <ng-template #denied>You lack access.</ng-template>
 * ```
 *
 * An empty condition (`*atlasProtect`) means simply "signed in".
 */
@Directive({
  selector: '[atlasProtect]',
  standalone: true,
})
export class AtlasProtectDirective implements OnInit, OnDestroy {
  private readonly atlas = inject(AtlasService);
  private readonly templateRef = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);

  private readonly condition$ = new BehaviorSubject<ProtectCondition>({});
  private elseTemplate: TemplateRef<unknown> | null = null;
  private sub?: Subscription;
  private rendered: 'main' | 'else' | 'none' = 'none';

  /** The condition to evaluate. An empty/omitted value means "signed in". */
  @Input()
  set atlasProtect(condition: ProtectCondition | '' | null | undefined) {
    this.condition$.next(condition || {});
  }

  /** Template rendered when the condition is not met (the `else` branch). */
  @Input()
  set atlasProtectElse(template: TemplateRef<unknown> | null) {
    this.elseTemplate = template;
    // Re-render against the current state so a late-bound else takes effect.
    this.condition$.next(this.condition$.value);
  }

  ngOnInit(): void {
    this.sub = combineLatest([this.atlas.status$, this.atlas.claims$, this.condition$]).subscribe(
      ([status, claims, condition]) => {
        if (status === 'loading') {
          this.show('none');
          return;
        }
        this.show(evaluate(claims, condition).allowed ? 'main' : 'else');
      },
    );
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private show(which: 'main' | 'else' | 'none'): void {
    if (which === this.rendered) return;
    this.viewContainer.clear();

    if (which === 'main') {
      this.viewContainer.createEmbeddedView(this.templateRef);
    } else if (which === 'else' && this.elseTemplate) {
      this.viewContainer.createEmbeddedView(this.elseTemplate);
    }
    this.rendered = which;
  }
}
