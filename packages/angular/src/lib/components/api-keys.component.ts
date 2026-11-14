import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, Output, type OnInit, type Signal, inject, signal } from '@angular/core';
import {
  API_KEYS_LABELS,
  ApiKeysController,
  REVERIFICATION_LABELS,
  apiKeyInputFromDraft,
  apiKeyStatus,
  apiKeysAtCap,
  formatLabel,
  scopePickerModel,
  toggleScope,
  type ApiKeyDraft,
  type ApiKeysLabels,
  type ApiKeysState,
  type CreatedUserApiKey,
  type ReverificationLabels,
  type UserApiKey,
} from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { controllerSignal } from './managed';

/**
 * `<atlas-api-keys>` — the signed-in user's own API keys (or, with `organizationId`, the active organization's):
 * list, create (with the "confirm it's you" prompt when the session is stale), the new secret shown once with a
 * copy button, rename, and revoke with a confirmation. Claim fields the application allows render as plain
 * inputs. The Angular peer of React's `<ApiKeys/>`; `(created)` emits the new key.
 */
@Component({
  selector: 'atlas-api-keys',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state().status !== 'loading') {
      <section [class]="cls('card', 'atlas-card')" data-atlas="api-keys">
        <h2 class="atlas-section-title">{{ l().title }}</h2>
        @if (state().status === 'disabled') {
          <p class="atlas-text" data-atlas="api-keys-disabled">{{ l().disabled }}</p>
        } @else {
          <p class="atlas-text">{{ organizationId ? l().organizationSubtitle : l().subtitle }}</p>
          @if (state().status === 'error' && state().error) {
            <p class="atlas-alert" role="alert">{{ state().error }}</p>
          }
          @if (state().secret) {
            <div data-atlas="api-key-secret" role="status">
              <p><strong>{{ l().secretTitle }}</strong></p>
              <p>{{ l().secretHint }}</p>
              <code data-atlas="api-key-secret-value">{{ state().secret }}</code>
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="copy()">{{ copied() ? l().copied : l().copy }}</button>
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="controller.dismissSecret()">{{ l().done }}</button>
            </div>
          }
          @if (state().needsReverification) {
            <div data-atlas="api-keys-reverification" role="dialog" [attr.aria-label]="r().title">
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
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="cancelReverification()">{{ r().cancel }}</button>
            </div>
          }
          @if (state().keys.length === 0) {
            <p class="atlas-text" data-atlas="api-keys-empty">{{ l().empty }}</p>
          } @else {
            <ul class="atlas-list" data-atlas="api-keys-list">
              @for (key of state().keys; track key.id) {
                <li class="atlas-list-item" data-atlas="api-key">
                  @if (renaming()?.id === key.id) {
                    <span>
                      <input [class]="cls('formFieldInput', 'atlas-account-input')" [attr.aria-label]="l().nameLabel" [value]="renaming()!.name" (input)="renaming.set({ id: key.id, name: $any($event.target).value })" />
                      <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" [disabled]="state().busy" (click)="saveRename()">{{ l().save }}</button>
                      <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="renaming.set(null)">{{ l().cancel }}</button>
                    </span>
                  } @else {
                    <strong>{{ key.name ?? l().unnamed }}</strong>
                  }
                  <code>{{ key.prefix }}…</code>
                  @if (statusOf(key) !== 'active') {
                    <em> — {{ statusOf(key) === 'revoked' ? l().revoked : l().expired }}</em>
                  }
                  <div class="atlas-text">{{ detail(key) }}</div>
                  @if (limitText(key); as limits) {
                    <div class="atlas-text" data-atlas="api-key-limits">{{ l().limits }}: {{ limits }}</div>
                  }
                  @if (!key.revoked_at && renaming()?.id !== key.id) {
                    @if (confirmRevoke() === key.id) {
                      <span data-atlas="api-key-revoke-confirm">
                        <span>{{ l().revokeConfirm }}</span>
                        <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" [disabled]="state().busy" (click)="revoke(key.id)">{{ l().revokeConfirmButton }}</button>
                        <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="confirmRevoke.set(null)">{{ l().cancel }}</button>
                      </span>
                    } @else {
                      <span>
                        <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="renaming.set({ id: key.id, name: key.name ?? '' })">{{ l().rename }}</button>
                        <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="confirmRevoke.set(key.id)">{{ l().revoke }}</button>
                      </span>
                    }
                  }
                </li>
              }
            </ul>
          }
          @if (state().actionError) {
            <p class="atlas-alert" role="alert">{{ state().actionError }}</p>
          }
          @if (creating()) {
            <div data-atlas="api-key-create">
              <label class="atlas-field">
                <span class="atlas-field-label">{{ l().nameLabel }}</span>
                <input [class]="cls('formFieldInput', 'atlas-account-input')" maxlength="100" [placeholder]="l().namePlaceholder" [value]="draft().name" (input)="patchDraft({ name: $any($event.target).value })" />
              </label>
              <label class="atlas-field">
                <span class="atlas-field-label">{{ l().expiresLabel }}</span>
                <select [class]="cls('formFieldInput', 'atlas-account-input')" (change)="patchDraft({ expiryDays: +$any($event.target).value })">
                  @for (d of expiryOptionsDays; track d) {
                    <option [value]="d" [selected]="d === draft().expiryDays">{{ d > 0 ? expiresIn(d) : l().expiresNever }}</option>
                  }
                </select>
              </label>
              @if (state().allowedScopes.length > 0) {
                <fieldset class="atlas-field">
                  <legend class="atlas-field-label">{{ l().scopesLabel }}</legend>
                  @if (scopeModel().rows.length) {
                    <table data-atlas="api-key-scope-grid">
                      <thead><tr><th scope="col"></th><th scope="col">read</th><th scope="col">write</th></tr></thead>
                      <tbody>
                        @for (row of scopeModel().rows; track row.resource) {
                          <tr>
                            <th scope="row">{{ row.resource }}</th>
                            <td>
                              @if (row.read; as b) {
                                <input type="checkbox" [attr.aria-label]="b.scope" [attr.data-atlas-scope]="b.scope" [checked]="b.checked" [disabled]="b.locked" (change)="tick(b.scope, $event)" />
                              }
                            </td>
                            <td>
                              @if (row.write; as b) {
                                <input type="checkbox" [attr.aria-label]="b.scope" [attr.data-atlas-scope]="b.scope" [checked]="b.checked" [disabled]="b.locked" (change)="tick(b.scope, $event)" />
                              }
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  }
                  @for (b of scopeModel().other; track b.scope) {
                    <label><input type="checkbox" [attr.aria-label]="b.scope" [attr.data-atlas-scope]="b.scope" [checked]="b.checked" [disabled]="b.locked" (change)="tick(b.scope, $event)" /> {{ b.scope }}</label>
                  }
                </fieldset>
              }
              @for (name of state().allowedClaims; track name) {
                <label class="atlas-field">
                  <span class="atlas-field-label">{{ name }}</span>
                  <input [class]="cls('formFieldInput', 'atlas-account-input')" [attr.data-atlas-claim]="name" [value]="draft().claims[name] ?? ''" (input)="setClaim(name, $event)" />
                </label>
              }
              <button [class]="cls('formButtonPrimary', 'atlas-button')" type="button" [disabled]="state().busy" (click)="submit()">{{ l().submit }}</button>
              <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" (click)="reset()">{{ l().cancel }}</button>
            </div>
          } @else if (atCap()) {
            <p class="atlas-text" data-atlas="api-keys-limit">{{ limitReached() }}</p>
          } @else {
            <button [class]="cls('formButtonPrimary', 'atlas-button')" type="button" (click)="creating.set(true)">{{ l().create }}</button>
          }
        }
      </section>
    }
  `,
})
export class ApiKeysComponent implements OnInit {
  protected readonly atlas = inject(AtlasService);
  @Input() organizationId?: string;
  /** Expiry choices offered, in days. `0` means never. */
  @Input() expiryOptionsDays: number[] = [0, 30, 90, 365];
  @Input() labels: ApiKeysLabels & { reverification?: ReverificationLabels } = {};
  @Output() created = new EventEmitter<CreatedUserApiKey>();

  protected controller!: ApiKeysController;
  private readonly destroyRef = inject(DestroyRef);
  protected state!: Signal<ApiKeysState>;
  protected readonly creating = signal(false);
  protected readonly draft = signal<ApiKeyDraft>({ name: '', expiryDays: 0, scopes: [], claims: {} });
  protected readonly copied = signal(false);
  protected readonly renaming = signal<{ id: string; name: string } | null>(null);
  protected readonly confirmRevoke = signal<string | null>(null);
  protected readonly password = signal('');
  protected readonly reauthError = signal<string | null>(null);

  ngOnInit(): void {
    this.controller = new ApiKeysController(this.atlas.createFapiClient(), this.atlas.createReauthOptions(), { organizationId: this.organizationId });
    this.state = controllerSignal(this.controller, this.destroyRef);
    this.draft.set(this.blank());
    void this.controller.load();
  }

  protected l = () => ({ ...API_KEYS_LABELS, ...this.labels });
  protected r = () => ({ ...REVERIFICATION_LABELS, ...this.labels.reverification });
  protected scopeModel = () => scopePickerModel(this.state().allowedScopes, this.state().scopeImplications, this.draft().scopes);
  protected atCap = () => apiKeysAtCap(this.state());
  protected limitReached = () => formatLabel(this.l().limitReached, { max: this.state().maxActiveKeys });
  protected expiresIn = (days: number) => formatLabel(this.l().expiresDays, { days });
  protected statusOf = (key: UserApiKey) => apiKeyStatus(key);

  private blank(): ApiKeyDraft {
    return { name: '', expiryDays: this.expiryOptionsDays[0] ?? 0, scopes: [], claims: {} };
  }

  protected detail(key: UserApiKey): string {
    const l = this.l();
    return [
      key.last_used_at ? formatLabel(l.lastUsed, { date: new Date(key.last_used_at).toLocaleDateString() }) : l.neverUsed,
      key.expires_at ? formatLabel(l.expiresOn, { date: new Date(key.expires_at).toLocaleDateString() }) : null,
      key.scopes && key.scopes.length > 0 ? key.scopes.join(', ') : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected limitText(key: UserApiKey): string {
    if (!key.limits || typeof key.limits !== 'object') return '';
    return Object.entries(key.limits)
      .map(([k, v]) => `${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}`)
      .join(' · ');
  }

  protected patchDraft(patch: Partial<ApiKeyDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected tick(scope: string, event: Event): void {
    this.patchDraft({ scopes: toggleScope(this.draft().scopes, scope, (event.target as HTMLInputElement).checked) });
  }

  protected setClaim(name: string, event: Event): void {
    this.patchDraft({ claims: { ...this.draft().claims, [name]: (event.target as HTMLInputElement).value } });
  }

  protected reset(): void {
    this.creating.set(false);
    this.draft.set(this.blank());
  }

  protected async submit(): Promise<void> {
    const key = await this.controller.createKey(apiKeyInputFromDraft(this.draft()));
    if (key) {
      this.copied.set(false);
      this.reset();
      this.created.emit(key);
    }
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

  protected cancelReverification(): void {
    this.password.set('');
    this.reauthError.set(null);
    this.controller.cancelReverification();
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(this.state().secret ?? '');
      this.copied.set(true);
    } catch {
      /* the secret stays visible for manual copy */
    }
  }

  protected async saveRename(): Promise<void> {
    const r = this.renaming();
    if (r && (await this.controller.renameKey(r.id, r.name.trim() || null))) this.renaming.set(null);
  }

  protected async revoke(id: string): Promise<void> {
    if (await this.controller.revokeKey(id)) this.confirmRevoke.set(null);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
