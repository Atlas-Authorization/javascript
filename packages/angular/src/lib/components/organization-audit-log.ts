import { signal, type Signal, type WritableSignal } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import {
  createOrganizationAuditLog,
  type FapiClient,
  type OrganizationAuditLogController,
  type OrganizationAuditLogOptions,
  type OrganizationAuditLogState,
} from '@atlasauth/js';
import type { AtlasOrganizationMembership } from '../types';

/**
 * The active organization's audit trail, for its admins — the engine behind
 * `<atlas-organization-audit-log>` and `AtlasService.organizationAuditLog()`
 * (the Angular peer of React's `useOrganizationAuditLog`). `state` is a signal
 * of `{ entries, loading, forbidden, hasMore }`, one page at a time, newest
 * first. It follows the active organization until {@link destroy}.
 */
export class AtlasOrganizationAuditLog {
  private readonly _state: WritableSignal<OrganizationAuditLogState>;
  private readonly log: OrganizationAuditLogController;
  private readonly unsubscribe: () => void;
  private readonly organizationSub: Subscription;

  readonly state: Signal<OrganizationAuditLogState>;

  constructor(
    client: Pick<FapiClient, 'get'>,
    organization$: Observable<AtlasOrganizationMembership | null>,
    options: OrganizationAuditLogOptions = {},
  ) {
    this.log = createOrganizationAuditLog(client, options);
    this._state = signal(this.log.getState());
    this.state = this._state.asReadonly();
    this.unsubscribe = this.log.subscribe((next) => this._state.set(next));
    this.organizationSub = organization$
      .pipe(
        map((membership) => membership?.organization.id ?? null),
        distinctUntilChanged(),
      )
      .subscribe((id) => void this.log.load(id));
  }

  /** Append the next page, when there is one. */
  loadMore(): Promise<void> {
    return this.log.loadMore();
  }

  /** Re-read from the newest entry. */
  reload(): Promise<void> {
    return this.log.reload();
  }

  /** Stop following the active organization. */
  destroy(): void {
    this.organizationSub.unsubscribe();
    this.unsubscribe();
  }
}
