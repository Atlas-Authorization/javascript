import type { Engine } from '../engine';
import type { Obj } from '../openapi';
import { engineState } from './support';

/** The audit trail of the signing-key, publisher, delivery and token-exchange routes of this module, newest last. */
const rows = engineState((): Obj[] => []);

export function auditOf(e: Engine): Obj[] {
  return rows(e);
}

/** Record one audit row. `actor` is `api_key` for a Backend API call and `system` for work the clock does. */
export function recordAudit(e: Engine, action: string, actor: 'api_key' | 'system' | 'oauth_client', targetType: string, targetId: string, metadata: Obj = {}): Obj {
  const row: Obj = { id: e.db.newId('audit'), object: 'audit_log_entry', action, actor_type: actor, actor_id: actor === 'api_key' ? 'emulator_key' : actor === 'system' ? action.split('.')[0] : null, target_type: targetType, target_id: targetId, ip: null, metadata, created_at: e.clock.now() };
  rows(e).push(row);
  return row;
}
