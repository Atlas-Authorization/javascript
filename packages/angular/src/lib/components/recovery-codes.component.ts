import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  inject,
} from '@angular/core';
import { canDownloadRecoveryCodes, copyRecoveryCodes, downloadRecoveryCodes } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import { translate } from '../i18n';

/**
 * The recovery codes a mid-sign-in MFA enrolment came with, shown once before
 * the sign-in finishes: copy them, download them as a .txt file, then
 * "I've saved my codes" (`saved`) exchanges the ticket. The codes live only in
 * the flow controller's memory and are forgotten once saved.
 */
@Component({
  selector: 'atlas-recovery-codes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="cls('card', 'atlas-card')" data-atlas="recovery-codes">
      <h1 [class]="cls('headerTitle', 'atlas-title')">{{ t('mfa.recoveryCodesTitle') }}</h1>
      <p class="atlas-text">{{ t('mfa.recoveryCodesHelp') }}</p>
      <ul
        class="atlas-recovery-codes"
        data-atlas="recovery-codes-list"
        style="list-style:none;padding:0;margin:8px 0 12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center"
      >
        @for (code of codes; track code) {
          <li><code>{{ code }}</code></li>
        }
      </ul>
      <div class="atlas-alternatives">
        @if (canCopy) {
          <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" data-atlas="recovery-codes-copy" (click)="copy()">
            {{ t('mfa.recoveryCodesCopy') }}
          </button>
        }
        @if (canDownload) {
          <button [class]="cls('formButtonSecondary', 'atlas-button-secondary')" type="button" data-atlas="recovery-codes-download" (click)="download()">
            {{ t('mfa.recoveryCodesDownload') }}
          </button>
        }
      </div>
      @if (copied) {
        <p class="atlas-text" aria-live="polite" data-atlas="recovery-codes-copied">{{ t('mfa.recoveryCodesCopied') }}</p>
      }
      <button [class]="cls('formButtonPrimary', 'atlas-button')" type="button" data-atlas="recovery-codes-saved" [disabled]="busy" (click)="saved.emit()">
        {{ t('mfa.recoveryCodesSaved') }}
      </button>
    </div>
  `,
})
export class RecoveryCodesComponent implements OnChanges {
  private readonly atlas = inject(AtlasService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() codes: string[] = [];
  @Input() busy = false;
  @Output() saved = new EventEmitter<void>();

  protected readonly canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  protected readonly canDownload = canDownloadRecoveryCodes();
  protected copied = false;

  ngOnChanges(): void {
    this.copied = false;
  }

  protected t(key: string): string {
    return translate(this.atlas.localization, key);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }

  protected copy(): void {
    void copyRecoveryCodes(this.codes).then((ok) => {
      this.copied = ok;
      this.cdr.markForCheck();
    });
  }

  protected download(): void {
    downloadRecoveryCodes(this.codes);
  }
}
