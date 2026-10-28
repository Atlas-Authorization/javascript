import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import {
  clearCibaPin,
  decideCibaRequest,
  getCibaPin,
  listCibaRequests,
  setCibaPin,
  type CibaPinStatus,
  type CibaRequest,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';

/**
 * `<atlas-manage-ciba>` — sign-in requests apps start on the user's behalf (CIBA), with approve and deny, and
 * the optional CIBA PIN apps must send as the user code. The Angular peer of React's `<ManageCiba/>`. Renders
 * nothing when there is no request, no PIN and no app that could ask.
 */
@Component({
  selector: 'atlas-manage-ciba',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (requests().length || (pin() && (pin()!.set || pin()!.available))) {
      <section [class]="cls('card', 'atlas-card')" data-atlas="manage-ciba">
        @if (requests().length) {
          <h2>Sign-in requests from apps</h2>
          <ul>
            @for (r of requests(); track r.id) {
              <li>
                <strong>{{ r.client_name }}</strong>
                @if (r.binding_message) {
                  <div>{{ r.binding_message }}</div>
                }
                <small>{{ r.scope.join(', ') }}</small>
                <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="decide(r.id, 'approve')">Approve</button>
                <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="decide(r.id, 'deny')">Deny</button>
              </li>
            }
          </ul>
        }
        @if (pin(); as p) {
          @if (p.set || p.available) {
            <form (submit)="save($event)">
              <h2>CIBA PIN</h2>
              <p>{{ p.set ? 'You have a CIBA PIN.' : 'You have not set a CIBA PIN.' }} Apps that start a sign-in request for you must send it.</p>
              <input type="password" autocomplete="current-password" placeholder="Current password" aria-label="Current password" [value]="password()" (input)="password.set($any($event.target).value)" />
              <input type="password" inputmode="numeric" autocomplete="off" placeholder="6 to 12 digits" aria-label="New CIBA PIN" [value]="newPin()" (input)="newPin.set($any($event.target).value)" />
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="submit">{{ p.set ? 'Change PIN' : 'Set PIN' }}</button>
              @if (p.set) {
                <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="remove()">Remove PIN</button>
              }
              @if (message(); as m) {
                <small role="status">{{ m }}</small>
              }
            </form>
          }
        }
        @if (message(); as m) {
          @if (!pin() || !(pin()!.set || pin()!.available)) {
            <small role="status">{{ m }}</small>
          }
        }
      </section>
    }
  `,
})
export class ManageCibaComponent implements OnInit {
  protected readonly atlas = inject(AtlasService);
  protected readonly requests = signal<CibaRequest[]>([]);
  protected readonly pin = signal<CibaPinStatus | null>(null);
  protected readonly newPin = signal('');
  protected readonly password = signal('');
  protected readonly message = signal<string | null>(null);
  private readonly client = this.atlas.createFapiClient();

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const [r, p] = await Promise.all([listCibaRequests(this.client).catch(() => []), getCibaPin(this.client).catch(() => null)]);
    this.requests.set(r);
    this.pin.set(p);
  }

  private async run(fn: () => Promise<unknown>, fallback: string): Promise<void> {
    this.message.set(null);
    try {
      await fn();
      this.newPin.set('');
      this.password.set('');
      await this.load();
    } catch (e) {
      this.message.set(e instanceof Error && e.message ? e.message : fallback);
    }
  }

  protected decide(id: string, decision: 'approve' | 'deny'): Promise<void> {
    return this.run(() => decideCibaRequest(this.client, id, decision), decision === 'approve' ? 'Could not approve.' : 'Could not deny.');
  }

  protected save(event: Event): Promise<void> {
    event.preventDefault();
    return this.run(() => setCibaPin(this.client, { pin: this.newPin(), currentPassword: this.password() }), 'Could not save the PIN.');
  }

  protected remove(): Promise<void> {
    return this.run(() => clearCibaPin(this.client, { currentPassword: this.password() }), 'Could not remove the PIN.');
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
