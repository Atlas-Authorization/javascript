import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * `<atlas-user-button>` — the signed-in user's avatar with a drop-down that can
 * sign them out. The Angular peer of React's `<UserButton/>`. Renders nothing
 * when there is no user.
 */
@Component({
  selector: 'atlas-user-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (atlas.user(); as user) {
      <div class="atlas-user-button">
        <button
          [class]="cls('avatar', 'atlas-avatar')"
          [attr.aria-expanded]="open()"
          (click)="toggle()"
        >
          @if (user.image_url) {
            <img [src]="user.image_url" alt="" />
          } @else {
            <span>{{ label().slice(0, 1) }}</span>
          }
        </button>

        @if (open()) {
          <div [class]="cls('menu', 'atlas-menu')" role="menu">
            <span [class]="cls('menuItem', 'atlas-menu-item')">{{ label() }}</span>
            <button [class]="cls('menuItem', 'atlas-menu-item')" (click)="signOut()">
              {{ t('userButton.signOut') }}
            </button>
          </div>
        }
      </div>
    }
  `,
})
export class UserButtonComponent {
  protected readonly atlas = inject(AtlasService);
  protected readonly open = signal(false);

  protected readonly label = computed(() => {
    const user = this.atlas.user();
    if (!user) return '';
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '';
  });

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected toggle(): void {
    this.open.update((o) => !o);
  }

  protected signOut(): void {
    void this.atlas.signOut();
  }
}
