import {
  Directive,
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  type OnDestroy,
  type OnInit,
  type Signal,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import {
  BILLING_LABELS,
  BillingController,
  CHECKOUT_LABELS,
  CheckoutController,
  formatLabel,
  formatMoney,
  mountEmbeddedCheckout,
  pricingCards,
  type BillingLabels,
  type BillingState,
  type CheckoutLabels,
  type CheckoutState,
  type EmbeddedCheckoutHandle,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { controllerSignal } from './managed';

/** A label is a template with `{placeholders}`, or a function of the value. */
type Label<T> = string | ((value: T) => string);
export type PricingTableLabels = Omit<BillingLabels, 'trial' | 'useCode'> & { trial?: Label<number>; useCode?: Label<string> };

/** Shared by the three billing components: one controller, loaded as the auth status settles. */
@Directive()
abstract class BillingBase implements OnInit {
  protected readonly atlas = inject(AtlasService);
  protected readonly destroyRef = inject(DestroyRef);
  @Input() orgId?: string;
  protected controller!: BillingController;
  protected state!: Signal<BillingState>;

  ngOnInit(): void {
    this.controller = new BillingController(this.atlas.createFapiClient(), { orgId: this.orgId });
    this.state = controllerSignal(this.controller, this.destroyRef);
    const sub = this.atlas.status$.subscribe((status) => {
      if (status !== 'loading') void this.controller.load(status === 'signed_in');
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}

/**
 * `<atlas-pricing-table>` — the instance's plans as cards: a locale-formatted price, features, a free-trial badge,
 * a monthly/yearly switch when a plan has an annual price, and a plan's promotion. The plan the subject is on is
 * marked current and its button opens the billing portal; a live base plan switches in place (prorated);
 * add-ons are bought alongside. `audience` shows only `user` or `org` plans.
 */
@Component({
  selector: 'atlas-pricing-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!state().isLoaded) {
      <div data-atlas="pricing-table" aria-busy="true"></div>
    } @else {
      <div [class]="cls('pricingTable', 'atlas-pricing-table')" data-atlas="pricing-table">
        @if (view().hasAnnual) {
          <div role="group" aria-label="Billing interval" data-atlas="pricing-interval">
            <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" [attr.aria-pressed]="state().interval === 'month'" (click)="controller.setInterval('month')">{{ l().monthly }}</button>
            <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" [attr.aria-pressed]="state().interval === 'year'" (click)="controller.setInterval('year')">{{ l().yearly }}</button>
          </div>
        }
        @for (card of view().cards; track card.plan.id) {
          <div [class]="cls('card', 'atlas-card')" data-atlas="pricing-plan" [attr.data-current]="card.isCurrent" [attr.data-kind]="card.isAddon ? 'addon' : 'base'">
            <h3 [class]="cls('planName', 'atlas-plan-name')">{{ card.plan.name }}</h3>
            @if (card.plan.badge) {
              <p data-atlas="pricing-badge" [class]="cls('badge', 'atlas-badge')">{{ card.plan.badge }}</p>
            }
            @if (card.plan.description) {
              <p data-atlas="pricing-description" class="atlas-text">{{ card.plan.description }}</p>
            }
            @if (card.view.promotionLabel) {
              <p data-atlas="pricing-promotion" [class]="cls('badge', 'atlas-badge')">{{ card.view.promotionLabel }}</p>
            }
            <p [class]="cls('price', 'atlas-price')">
              @if (card.view.originalPrice) {
                <s data-atlas="pricing-original">{{ card.view.originalPrice }}</s>
              }
              {{ card.view.free ? l().free : card.view.price }}
              @if (!card.view.free) {
                <span [class]="cls('priceInterval', 'atlas-interval')"> / {{ card.view.interval === 'year' ? l().perYear : l().perMonth }}</span>
              }
            </p>
            @if (card.view.trialDays) {
              <p data-atlas="pricing-trial" [class]="cls('badge', 'atlas-badge')">{{ trial(card.view.trialDays) }}</p>
            }
            @if (card.view.promotionCode) {
              <p data-atlas="pricing-code" class="atlas-text">{{ useCode(card.view.promotionCode) }}</p>
            }
            @if (card.plan.features.length) {
              <ul [class]="cls('list', 'atlas-list')">
                @for (f of card.plan.features; track $index) {
                  <li [class]="cls('listItem', 'atlas-list-item')">{{ f }}</li>
                }
              </ul>
            }
            @if (card.isCurrent) {
              <button type="button" [class]="cls('formButtonPrimary', 'atlas-button')" data-atlas="manage-billing" (click)="manage(card.heldSubscriptionId)">{{ l().manage }}</button>
            } @else {
              <button type="button" [class]="cls('formButtonPrimary', 'atlas-button')" [disabled]="atlas.status() !== 'signed_in' || state().busyPlan === card.plan.id" (click)="controller.choosePlan(card.plan)">{{ l().subscribe }}</button>
            }
          </div>
        }
        @if (state().error) {
          <p role="alert" class="atlas-alert">{{ state().error }}</p>
        }
      </div>
    }
  `,
})
export class PricingTableComponent extends BillingBase {
  @Input() audience?: 'user' | 'org';
  @Input() locale?: string;
  @Input() labels: PricingTableLabels = {};

  protected l = () => ({ ...BILLING_LABELS, ...this.labels });
  protected view = () =>
    pricingCards(this.state(), { audience: this.audience, locale: this.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined) });
  protected trial(days: number): string {
    const t = this.l().trial;
    return typeof t === 'function' ? t(days) : formatLabel(t, { days });
  }
  protected useCode(code: string): string {
    const t = this.l().useCode;
    return typeof t === 'function' ? t(code) : formatLabel(t, { code });
  }
  protected manage(subscriptionId: string | null): void {
    void this.controller.openPortal(subscriptionId ? { subscriptionId } : {});
  }
}

/** `<atlas-invoices>` — the subject's billing history: number, amount, status and a link to the hosted invoice. */
@Component({
  selector: 'atlas-invoices',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!state().isLoaded) {
      <div data-atlas="invoices" aria-busy="true"></div>
    } @else {
      <div [class]="cls('card', 'atlas-card')" data-atlas="invoices">
        <h3 class="atlas-section-title">{{ l().invoices }}</h3>
        @if (state().invoices.length === 0) {
          <p class="atlas-text" data-atlas="invoices-empty">{{ l().noInvoices }}</p>
        } @else {
          <ul [class]="cls('list', 'atlas-list')">
            @for (inv of state().invoices; track inv.id) {
              <li [class]="cls('listItem', 'atlas-list-item')" data-atlas="invoice" [attr.data-status]="inv.status">
                <span>{{ inv.number ?? inv.id }}</span>
                <span> {{ money(inv.amount_paid || inv.amount_due, inv.currency) }}</span>
                <span> {{ inv.status }}</span>
                @if (inv.hosted_invoice_url) {
                  <a class="atlas-link" [href]="inv.hosted_invoice_url" target="_blank" rel="noreferrer"> {{ l().viewInvoice }}</a>
                }
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class InvoicesComponent extends BillingBase {
  @Input() labels: BillingLabels = {};
  protected l = () => ({ ...BILLING_LABELS, ...this.labels });
  protected money = formatMoney;
}

/**
 * `<atlas-embedded-checkout>` — in-page checkout for a plan: the provider's own Embedded Checkout frame (its
 * script owns the card fields, no card data touches Atlas). When the instance has no embedded checkout it shows a
 * button that starts the hosted checkout.
 */
@Component({
  selector: 'atlas-embedded-checkout',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (outcome()?.status === 'unavailable') {
      <button type="button" data-atlas="checkout-fallback" (click)="controller.checkout({ planId, orgId, couponCode, interval })">{{ l().subscribe }}</button>
    }
    <div data-atlas="embedded-checkout" [hidden]="outcome()?.status === 'unavailable'">
      @if (outcome()?.status === 'error') {
        <p role="alert">{{ outcome()?.error ?? l().checkoutFailed }}</p>
      }
      <div #frame></div>
    </div>
  `,
})
export class EmbeddedCheckoutComponent extends BillingBase implements AfterViewInit, OnDestroy {
  @Input({ required: true }) planId!: string;
  @Input() returnUrl?: string;
  /** A discount code the buyer entered (see `<atlas-checkout>`). */
  @Input() couponCode?: string;
  @Input() interval?: 'month' | 'year';
  @Input() labels: BillingLabels = {};
  @ViewChild('frame') frame?: ElementRef<HTMLElement>;
  protected readonly outcome = signal<Pick<EmbeddedCheckoutHandle, 'status' | 'error'> | null>(null);
  private handle: EmbeddedCheckoutHandle | null = null;
  private gone = false;

  protected l = () => ({ ...BILLING_LABELS, ...this.labels });

  // The controller only serves the hosted-checkout fallback, so it is not loaded (no plans fetch).
  override ngOnInit(): void {
    this.controller = new BillingController(this.atlas.createFapiClient(), { orgId: this.orgId });
  }

  async ngAfterViewInit(): Promise<void> {
    const el = this.frame?.nativeElement;
    if (!el) return;
    this.handle = await mountEmbeddedCheckout(this.atlas.createFapiClient(), { planId: this.planId, orgId: this.orgId, returnUrl: this.returnUrl, couponCode: this.couponCode, interval: this.interval }, el, () => this.gone);
    this.outcome.set({ status: this.handle.status, error: this.handle.error });
  }

  ngOnDestroy(): void {
    this.gone = true;
    this.handle?.destroy();
  }
}

/**
 * `<atlas-checkout>` — the step before payment for one plan: the plan and its price, a monthly/yearly choice when
 * it has an annual price, an optional discount code with a server-side "apply" check, and the way on to payment.
 * `embedded` mounts the in-page frame after "Continue"; otherwise the button redirects to the hosted page.
 */
@Component({
  selector: 'atlas-checkout',
  standalone: true,
  imports: [EmbeddedCheckoutComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!state().isLoaded) {
      <div data-atlas="checkout" aria-busy="true"></div>
    } @else if (!plan()) {
      <div data-atlas="checkout" role="alert">{{ l().planGone }}</div>
    } @else {
      <div [class]="cls('card', 'atlas-card')" data-atlas="checkout">
        <h3 [class]="cls('planName', 'atlas-plan-name')">{{ plan()!.name }}</h3>
        @if (plan()!.badge) {
          <p data-atlas="checkout-badge" [class]="cls('badge', 'atlas-badge')">{{ plan()!.badge }}</p>
        }
        @if (plan()!.description) {
          <p class="atlas-text">{{ plan()!.description }}</p>
        }
        @if (plan()!.annual_available) {
          <div role="group" aria-label="Billing interval" data-atlas="checkout-interval">
            <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" [attr.aria-pressed]="step().interval === 'month'" [disabled]="step().started" (click)="stepper.setInterval('month')">{{ l().monthly }}</button>
            <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" [attr.aria-pressed]="step().interval === 'year'" [disabled]="step().started" (click)="stepper.setInterval('year')">{{ l().yearly }}</button>
          </div>
        }
        <p [class]="cls('price', 'atlas-price')" data-atlas="checkout-price">
          @if (priceView().originalPrice) {
            <s>{{ priceView().originalPrice }}</s>
          }
          {{ priceView().free ? l().free : priceView().price }}
        </p>
        @if (!step().started) {
          <div data-atlas="checkout-coupon">
            <label>
              {{ l().code }}
              <input [value]="step().code" autocomplete="off" spellcheck="false" (input)="stepper.setCode($any($event.target).value)" />
            </label>
            <button type="button" [class]="cls('formButtonSecondary', 'atlas-button-secondary')" [disabled]="step().busy || !signedIn() || !step().code.trim()" (click)="stepper.apply()">{{ l().apply }}</button>
            @if (step().applied) {
              <p role="status" data-atlas="checkout-coupon-applied">{{ applied() }}</p>
            }
            @if (step().problem) {
              <p role="alert" data-atlas="checkout-coupon-problem">{{ step().problem }}</p>
            }
          </div>
          @if (!signedIn()) {
            <p class="atlas-text">{{ l().signIn }}</p>
          }
          <button type="button" [class]="cls('formButtonPrimary', 'atlas-button')" [disabled]="!signedIn()" (click)="stepper.proceed()">{{ embedded ? l().continue : l().subscribe }}</button>
        } @else {
          <atlas-embedded-checkout [planId]="planId" [orgId]="orgId" [returnUrl]="returnUrl" [couponCode]="step().applied?.code" [interval]="plan()!.annual_available ? step().interval : undefined" />
        }
      </div>
    }
  `,
})
export class CheckoutComponent extends BillingBase {
  @Input({ required: true }) planId!: string;
  @Input() embedded = false;
  @Input() returnUrl?: string;
  @Input() locale?: string;
  @Input() labels: BillingLabels & CheckoutLabels = {};
  /** Emitted when the buyer continues to payment. */
  @Output() started = new EventEmitter<{ planId: string; couponCode?: string; interval: 'month' | 'year' }>();

  protected stepper!: CheckoutController;
  protected step!: Signal<CheckoutState>;

  protected l = () => ({ ...BILLING_LABELS, ...CHECKOUT_LABELS, ...this.labels });
  protected signedIn = () => this.atlas.status() === 'signed_in';
  protected plan = () => this.state().plans.find((p) => p.id === this.planId) ?? null;
  protected applied = () => formatLabel(this.l().applied, { what: this.step().applied?.text ?? '' });
  protected priceView = () =>
    pricingCards({ plans: [this.plan()!], subscription: null, addons: [], interval: this.step().interval }, { locale: this.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined) }).cards[0]!.view;

  override ngOnInit(): void {
    super.ngOnInit();
    this.stepper = new CheckoutController(this.controller, this.planId, {
      orgId: this.orgId,
      embedded: this.embedded,
      locale: this.locale,
      labels: this.labels,
      onStarted: (info) => this.started.emit(info),
    });
    this.step = controllerSignal(this.stepper, this.destroyRef);
  }
}
