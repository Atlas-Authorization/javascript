import {
  ChangeDetectionStrategy,
  Component,
  Input,
  inject,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { describeAuditAction } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { classFor, type ElementKey } from '../appearance';
import type { AtlasOrganizationAuditLog } from './organization-audit-log';

/**
 * `<atlas-organization-audit-log>` — the active organization's audit trail for
 * its admins, next to `<atlas-organization-profile>`. The Angular peer of
 * React's `<OrganizationAuditLog/>`. Renders nothing for a member who may not
 * read it (the server is the authority; the component just follows it). Labels
 * are inputs so an app can localise them.
 */
@Component({
  selector: 'atlas-organization-audit-log',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (atlas.organization() && !log.state().forbidden) {
      <div [class]="cls('card', 'atlas-card')" data-atlas="organization-audit-log">
        <h2 [class]="cls('headerTitle', 'atlas-title')">{{ labels.title ?? 'Audit log' }}</h2>
        @if (log.state().entries.length === 0 && !log.state().loading) {
          <p [class]="cls('headerSubtitle', 'atlas-subtitle')">{{ labels.empty ?? 'No activity recorded yet.' }}</p>
        } @else {
          <ul [class]="cls('list', 'atlas-audit-list')">
            @for (entry of log.state().entries; track entry.id) {
              <li [class]="cls('listItem', 'atlas-audit-item')" [attr.data-action]="entry.action">
                <strong>{{ describe(entry.action) }}</strong>
                <span class="atlas-audit-meta">
                  · {{ formatDate(entry.created_at) }}{{ entry.actor.id ? ' · ' + (labels.actor ?? 'by') + ' ' + entry.actor.type + ' ' + entry.actor.id : '' }}
                </span>
              </li>
            }
          </ul>
        }
        @if (log.state().hasMore) {
          <button
            type="button"
            [class]="cls('formButtonSecondary', 'atlas-button-secondary')"
            [disabled]="log.state().loading"
            (click)="log.loadMore()"
          >
            {{ labels.loadMore ?? 'Load more' }}
          </button>
        }
      </div>
    }
  `,
})
export class OrganizationAuditLogComponent implements OnInit, OnDestroy {
  /** Entries per page (the server caps it). */
  @Input() pageSize?: number;
  /** Narrow to one action, or a prefix ending in `.`. */
  @Input() action?: string;
  @Input() labels: { title?: string; empty?: string; loadMore?: string; actor?: string } = {};
  @Input() formatDate: (ms: number) => string = (ms) => new Date(ms).toLocaleString();

  protected readonly atlas = inject(AtlasService);
  /** Created in ngOnInit, once the inputs are set (templates render after it). */
  protected log!: AtlasOrganizationAuditLog;

  ngOnInit(): void {
    this.log = this.atlas.organizationAuditLog({ pageSize: this.pageSize, action: this.action });
  }

  ngOnDestroy(): void {
    this.log.destroy();
  }

  protected describe(action: string): string {
    return describeAuditAction(action);
  }

  protected cls(key: ElementKey, base: string): string {
    return classFor(key, this.atlas.appearance, base);
  }
}
