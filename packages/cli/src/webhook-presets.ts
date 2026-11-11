/**
 * The `enabled_events` presets, as the API ships them (keep in step with the API's table).
 * Atlas stores a preset as written, but a row saved before that stores the expanded list;
 * a plan compares both sides expanded so neither shows as drift.
 */
export const WEBHOOK_EVENT_PRESETS: Record<string, readonly string[]> = {
  'preset:user_mirror': [
    'user.created', 'user.updated', 'user.deleted', 'user.merged', 'user.banned', 'user.unbanned',
    'user.locked', 'user.suspended', 'user.unsuspended', 'user.deactivated', 'user.reactivated', 'user.graduated',
  ],
  'preset:org_mirror': [
    'organization.created', 'organization.updated', 'organization.deleted',
    'organization_membership.created', 'organization_membership.updated', 'organization_membership.deleted',
    'organization_domain.created', 'organization_domain.updated', 'organization_domain.deleted',
    'organization_invitation.created', 'organization_invitation.accepted', 'organization_invitation.revoked',
    'organization_invitation.declined', 'organization_invitation.resent',
  ],
};

/** Every preset replaced by its events, de-duplicated and sorted. */
export function expandEventList(events: readonly string[]): string[] {
  return [...new Set(events.flatMap((e) => (Object.hasOwn(WEBHOOK_EVENT_PRESETS, e) ? WEBHOOK_EVENT_PRESETS[e]! : [e])))].sort();
}

/** True when two `enabled_events` lists subscribe to the same events once presets are expanded. */
export function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  const x = expandEventList(a);
  const y = expandEventList(b);
  return x.length === y.length && x.every((e, i) => e === y[i]);
}
