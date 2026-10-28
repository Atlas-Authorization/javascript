import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { actorFromClaims, type EndImpersonationResult } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * `<atlas-impersonation-banner>` — shown only while the active session is an
 * impersonation, naming the user acted as, with "Return to admin" (or "End
 * impersonation" when there is no session of the impersonator's to resume).
 * Emits `ended` with the outcome. The Angular peer of React's
 * `<ImpersonationBanner/>`.
 */
@Component({
  selector: 'atlas-impersonation-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (actor()) {
      <div [class]="cls('card', 'atlas-alert atlas-impersonation-banner')" role="status">
        <span [class]="cls('headerSubtitle', 'atlas-text')">{{ t('impersonation.banner', { name: name() }) }}</span>
        <button type="button" [class]="cls('formButtonPrimary', 'atlas-button')" [disabled]="busy()" (click)="end()">
          {{ canReturn() ? t('impersonation.returnToAdmin') : t('impersonation.end') }}
        </button>
      </div>
    }
  `,
})
export class ImpersonationBannerComponent {
  protected readonly atlas = inject(AtlasService);
  @Output() readonly ended = new EventEmitter<EndImpersonationResult>();
  protected readonly busy = signal(false);

  protected readonly actor = computed(
    () => actorFromClaims(this.atlas.claims()) ?? this.atlas.session()?.actor ?? null,
  );
  protected readonly canReturn = computed(
    () => this.actor() !== null && Boolean(this.atlas.session()?.actor_session_id),
  );
  protected readonly name = computed(() => {
    const u = this.atlas.user();
    return (
      [u?.first_name, u?.last_name].filter(Boolean).join(' ') ||
      u?.username ||
      u?.email_addresses?.find((e) => e.primary)?.email_address ||
      u?.id ||
      ''
    );
  });

  protected t(key: string, vars?: Record<string, string>): string {
    return translate(this.atlas.localization, key, vars);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected async end(): Promise<void> {
    this.busy.set(true);
    try {
      this.ended.emit(await this.atlas.endImpersonation());
    } finally {
      this.busy.set(false);
    }
  }
}
