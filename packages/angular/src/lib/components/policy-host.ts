import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  inject,
  signal,
  type SimpleChanges,
} from '@angular/core';
import {
  PolicyGateController,
  controllerForPending,
  formatPolicyDate,
  injectPolicyStyles,
  joinTitles,
  mountPolicyAcceptStep,
  mountPolicyClickwrap,
  mountPolicyConsent,
  policyTranslator,
  type MountedPolicyStep,
  type MountedPolicyUi,
  type Policy,
  type PolicyAcceptanceController,
  type PolicyClasses,
  type PolicyT,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor } from '../appearance';
import { translate } from '../i18n';

/** The policy UI's translator (the localization bundle, else the English policy strings) for the current Atlas service. */
export function policyUi(atlas: AtlasService): { t: PolicyT; classes: PolicyClasses } {
  return {
    t: policyTranslator((key, vars) => translate(atlas.localization, key, vars)),
    classes: {
      link: 'atlas-link',
      text: 'atlas-text',
      primaryButton: classFor('formButtonPrimary', atlas.appearance, 'atlas-button'),
      error: classFor('formFieldError', atlas.appearance, 'atlas-error'),
    },
  };
}

/**
 * `[atlasPolicies]="controller"` — draws the instance's policies (terms, privacy,
 * …) into the host element: `kind="consent"` (default) is the checkbox block with
 * its in-page viewer, `kind="clickwrap"` the "By continuing you agree to …" line.
 * The state is the controller's (`AtlasFlowController.policies`); the DOM comes
 * from `@atlasauth/js`, shared with every SDK.
 */
@Directive({ selector: '[atlasPolicies]', standalone: true })
export class AtlasPoliciesDirective implements OnInit, OnChanges, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly atlas = inject(AtlasService);
  private mounted: MountedPolicyUi | null = null;
  private ready = false;

  @Input('atlasPolicies') controller: PolicyAcceptanceController | null = null;
  @Input() atlasPolicyKind: 'consent' | 'clickwrap' = 'consent';

  ngOnInit(): void {
    this.ready = true;
    this.draw();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.ready && (changes['controller'] || changes['atlasPolicyKind'])) this.draw();
  }

  ngOnDestroy(): void {
    this.mounted?.destroy();
  }

  private draw(): void {
    this.mounted?.destroy();
    this.mounted = null;
    if (!this.controller) return;
    const el = this.host.nativeElement;
    injectPolicyStyles(el.ownerDocument);
    const ui = policyUi(this.atlas);
    this.mounted =
      this.atlasPolicyKind === 'clickwrap'
        ? mountPolicyClickwrap(el, this.controller, ui)
        : mountPolicyConsent(el, this.controller, ui);
  }
}

/**
 * `<atlas-policy-accept-step>` — the sign-in step for a `needs_policy_acceptance`
 * attempt: scroll-mode policies in their unskippable dialog, the rest as
 * checkboxes, then "Accept and continue". Emits `submitFlow` with the
 * `policy_acceptances` JSON for the flow, and `declined` with the policy title
 * when the user declines (cancel the attempt).
 */
@Component({
  selector: 'atlas-policy-accept-step',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (loading()) {<p class="atlas-text">{{ loadingText }}</p>}<div class="atlas-policy-step-host"></div>`,
})
export class PolicyAcceptStepComponent implements OnInit, OnChanges, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly atlas = inject(AtlasService);
  private step: MountedPolicyStep | null = null;
  private alive = true;

  @Input() attempt: { id: string | null; pending_policies?: unknown } | null = null;
  @Input() busy = false;
  @Output() submitFlow = new EventEmitter<Record<string, string>>();
  @Output() declined = new EventEmitter<string>();

  protected readonly loading = signal(true);
  protected loadingText = policyUi(this.atlas).t('policy.loading');

  ngOnInit(): void {
    const client = this.atlas.createFapiClient();
    void controllerForPending(client, this.attempt, { locale: this.atlas.locale ?? undefined }).then((controller) => {
      if (!this.alive) return;
      this.loading.set(false);
      const el = this.host.nativeElement.querySelector('.atlas-policy-step-host') as HTMLElement | null;
      if (!el) return;
      injectPolicyStyles(el.ownerDocument);
      this.step = mountPolicyAcceptStep(el, controller, {
        ...policyUi(this.atlas),
        onSubmit: (acceptances) => this.submitFlow.emit({ policy_acceptances: JSON.stringify(acceptances) }),
        onDecline: (policy: Policy) => this.declined.emit(policy.title),
      });
      this.step.setBusy(this.busy);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['busy']) this.step?.setBusy(this.busy);
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.step?.destroy();
  }
}

/**
 * `<atlas-policy-gate>` — in-app re-acceptance. For a signed-in user, a banner
 * when a policy needs re-acceptance; "Review and accept" opens the unskippable
 * dialog / checkboxes and posts `/v1/client/me/policies/accept`. Projects its
 * content always.
 */
@Component({
  selector: 'atlas-policy-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (bannerText(); as text) {
      <div [class]="bannerClass" role="status" data-atlas-policy-banner="">
        <span
          ><strong>{{ title }}. </strong>{{ text }}</span
        >
        <button type="button" [class]="linkClass" (click)="begin()">{{ reviewText }}</button>
      </div>
    }
    @if (reviewing()) {
      <div [class]="cardClass" data-atlas-policy-gate="">
        <div class="atlas-policy-gate-host"></div>
        @if (error()) {
          <p [class]="errorClass" role="alert">{{ error() }}</p>
        }
      </div>
    }
    <ng-content></ng-content>
  `,
})
export class PolicyGateComponent implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly atlas = inject(AtlasService);
  private readonly ui = policyUi(this.atlas);
  private gate!: PolicyGateController;
  private off: (() => void) | null = null;
  private step: MountedPolicyStep | null = null;
  private readonly version = signal(0);

  @Output() accepted = new EventEmitter<void>();

  protected readonly reviewing = signal(false);
  protected readonly error = signal('');
  protected title = this.ui.t('policy.bannerTitle');
  protected reviewText = this.ui.t('policy.bannerReview');
  protected linkClass = this.ui.classes.link ?? '';
  protected errorClass = this.ui.classes.error ?? '';
  protected bannerClass = 'atlas-policy-banner';
  protected cardClass = classFor('card', this.atlas.appearance, 'atlas-card');

  protected bannerText(): string | null {
    this.version();
    if (!this.gate || this.gate.pending.length === 0 || this.reviewing()) return null;
    const t = this.ui.t;
    const grace = this.gate.graceEndsAt;
    return (
      t('policy.bannerBody', { policies: joinTitles(this.gate.pending.map((p) => p.title), t('policy.and')) }) +
      (grace ? ` ${t('policy.bannerGrace', { date: formatPolicyDate(grace) })}` : '')
    );
  }

  ngOnInit(): void {
    this.gate = new PolicyGateController(this.atlas.createFapiClient(), this.atlas.locale ?? undefined);
    this.off = this.gate.subscribe(() => this.version.update((n) => n + 1));
    if (this.atlas.status() === 'signed_in') void this.gate.load();
  }

  async begin(): Promise<void> {
    const controller = await this.gate.begin();
    this.reviewing.set(true);
    await Promise.resolve();
    const el = this.host.nativeElement.querySelector('.atlas-policy-gate-host') as HTMLElement | null;
    if (!el) return;
    injectPolicyStyles(el.ownerDocument);
    this.step = mountPolicyAcceptStep(el, controller, {
      ...this.ui,
      onSubmit: async () => {
        this.step?.setBusy(true);
        const res = await this.gate.accept(controller);
        this.step?.setBusy(false);
        if (!res.ok) {
          this.error.set(res.errors[0]?.message ?? this.ui.t('policy.requiredGeneric'));
          return;
        }
        this.close();
        this.accepted.emit();
      },
      onDecline: () => this.close(),
    });
  }

  private close(): void {
    this.step?.destroy();
    this.step = null;
    this.reviewing.set(false);
  }

  ngOnDestroy(): void {
    this.off?.();
    this.step?.destroy();
  }
}
