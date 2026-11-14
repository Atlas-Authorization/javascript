import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, Output, type OnInit, type Signal, inject, signal } from '@angular/core';
import {
  DEVICE_AUTH_LABELS,
  DeviceAuthorizationController,
  REVERIFICATION_LABELS,
  formatLabel,
  formatUserCode,
  userCodeFromUrl,
  type DeviceAuthorization,
  type DeviceAuthorizationLabels,
  type DeviceAuthorizationState,
  type ReverificationLabels,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { controllerSignal } from './managed';

/**
 * `<atlas-device-authorization>` — device sign-in (RFC 8628) on your own page: the signed-in user enters the code
 * their TV, console or terminal shows, sees which app asks for what, and allows or denies it. Reads `?user_code=`
 * from the page URL, so it works as the verification URI too. The Angular peer of React's `<DeviceAuthorization/>`;
 * `(approved)` and `(denied)` emit the authorization.
 */
@Component({
  selector: 'atlas-device-authorization',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="cls('card', 'atlas-card')" data-atlas="device-authorization">
      <h2 class="atlas-section-title">{{ l().title }}</h2>
      @if (state().status === 'approved') {
        <p class="atlas-text" role="status" data-atlas="device-authorization-approved">{{ l().approved }}</p>
      } @else if (state().status === 'denied') {
        <p class="atlas-text" role="status" data-atlas="device-authorization-denied">{{ l().denied }}</p>
      } @else if (state().authorization && (state().status === 'review' || state().status === 'busy')) {
        <div data-atlas="device-authorization-review">
          <p class="atlas-text">{{ request() }}</p>
          @if (state().authorization!.scopes.length) {
            <p class="atlas-text">{{ l().scopesTitle }}</p>
            <ul class="atlas-list" data-atlas="device-authorization-scopes">
              @for (sc of state().authorization!.scopes; track sc.scope) {
                <li class="atlas-list-item">{{ sc.description }}</li>
              }
            </ul>
          }
          <p class="atlas-text" data-atlas="device-authorization-code">{{ checkCode() }}</p>
          @if (state().needsReverification) {
            <div data-atlas="device-authorization-reverification" role="dialog" [attr.aria-label]="r().title">
              <p><strong>{{ r().title }}</strong></p>
              <p>{{ r().subtitle }}</p>
              <label class="atlas-field">
                <span class="atlas-field-label">{{ r().passwordLabel }}</span>
                <input [class]="cls('formFieldInput', 'atlas-account-input')" type="password" autocomplete="current-password" [value]="password()" (input)="password.set($any($event.target).value)" />
              </label>
              @if (reauthError()) {
                <p class="atlas-error" role="alert">{{ reauthError() }}</p>
              }
              <button [class]="cls('formButtonPrimary', 'atlas-button')" type="button" (click)="confirmIdentity()">{{ r().submit }}</button>
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="controller.cancelReverification()">{{ r().cancel }}</button>
            </div>
          } @else {
            <div>
              <button [class]="cls('formButtonPrimary', 'atlas-button')" type="button" [disabled]="state().status === 'busy'" (click)="approve()">{{ l().approve }}</button>
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" [disabled]="state().status === 'busy'" (click)="deny()">{{ l().deny }}</button>
            </div>
          }
        </div>
      } @else {
        <form data-atlas="device-authorization-entry" (submit)="lookup($event)">
          <p class="atlas-text">{{ l().subtitle }}</p>
          <label class="atlas-field">
            <span class="atlas-field-label">{{ l().codeLabel }}</span>
            <input [class]="cls('formFieldInput', 'atlas-account-input')" [value]="code()" (input)="code.set($any($event.target).value)" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" />
          </label>
          @if (state().error) {
            <p class="atlas-error" role="alert">{{ state().invalidCode ? l().invalidCode : state().error }}</p>
          }
          <button [class]="cls('formButtonPrimary', 'atlas-button')" type="submit" [disabled]="state().status === 'busy' || !code().trim()">{{ l().continue }}</button>
        </form>
      }
      @if (state().status === 'approved' || state().status === 'denied' || state().status === 'error') {
        <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="another()">{{ l().another }}</button>
      }
    </section>
  `,
})
export class DeviceAuthorizationComponent implements OnInit {
  protected readonly atlas = inject(AtlasService);
  private readonly destroyRef = inject(DestroyRef);
  /** Start with this code (otherwise `?user_code=` on the page URL, if present). */
  @Input() userCode?: string;
  @Input() labels: DeviceAuthorizationLabels & { reverification?: ReverificationLabels } = {};
  @Output() approved = new EventEmitter<DeviceAuthorization>();
  @Output() denied = new EventEmitter<DeviceAuthorization>();

  protected controller!: DeviceAuthorizationController;
  protected state!: Signal<DeviceAuthorizationState>;
  protected readonly code = signal('');
  protected readonly password = signal('');
  protected readonly reauthError = signal<string | null>(null);

  ngOnInit(): void {
    this.controller = new DeviceAuthorizationController(this.atlas.createFapiClient(), this.atlas.createReauthOptions());
    this.state = controllerSignal(this.controller, this.destroyRef);
    const initial = this.userCode ?? (typeof window !== 'undefined' ? userCodeFromUrl(window.location.href) : null);
    this.code.set(this.userCode ?? '');
    if (initial) {
      this.code.set(formatUserCode(initial));
      void this.controller.lookup(initial);
    }
  }

  protected l = () => ({ ...DEVICE_AUTH_LABELS, ...this.labels });
  protected r = () => ({ ...REVERIFICATION_LABELS, ...this.labels.reverification });
  protected request = () => formatLabel(this.l().request, { app: this.state().authorization?.client.name ?? '' });
  protected checkCode = () => formatLabel(this.l().checkCode, { code: this.state().authorization?.userCode ?? '' });

  protected lookup(event: Event): void {
    event.preventDefault();
    void this.controller.lookup(this.code());
  }

  protected async approve(): Promise<void> {
    await this.controller.approve();
    const s = this.state();
    if (s.status === 'approved' && s.authorization) this.approved.emit(s.authorization);
  }

  protected async deny(): Promise<void> {
    await this.controller.deny();
    const s = this.state();
    if (s.status === 'denied' && s.authorization) this.denied.emit(s.authorization);
  }

  protected async confirmIdentity(): Promise<void> {
    this.reauthError.set(null);
    try {
      await this.controller.completeReverification(this.password());
      this.password.set('');
    } catch (e) {
      this.reauthError.set(e instanceof Error ? e.message : 'Re-authentication failed.');
    }
  }

  protected another(): void {
    this.code.set('');
    this.controller.reset();
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
