/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RouteDef } from '../engine';
import { auditLog, instanceConfig } from './emu4-shared';
import { applyConfigPatch } from './emu4-config';
import { captureAutoSnapshot } from './emu4-snapshots';
import { cookieHandlers } from './emu4-cookies';
import { erasureHandlers } from './emu4-erasure';
import { minorsHandlers } from './emu4-minors';
import { policyHandlers } from './emu4-policies';
import { regionHandlers } from './emu4-region';

/**
 * Round-four compliance: age assurance and guardian consent methods, the data policy and signed reports, the cookie consent
 * ledger, per-organization and per-language policies, translation review, downstream erasure connectors and region pinning.
 * Settings the real API keeps in the instance configuration live in the emulator's compliance configuration, read and written with
 * `GET`/`PUT /__emulator/compliance/config`; the audit rows these routes write are read at `GET /__emulator/compliance/audit`.
 */
export function emu4ComplianceHandlers(): RouteDef[] {
  return [
    ...minorsHandlers(),
    ...cookieHandlers(),
    ...erasureHandlers(),
    ...policyHandlers(),
    ...regionHandlers(),
    { method: 'GET', pattern: '/__emulator/compliance/config', public: true, handler: (c) => ({ body: { object: 'compliance_config', ...structuredClone(instanceConfig(c.engine)) } }) },
    // PUT /__emulator/compliance/config { compliance: { minors, cookieConsent, dataPolicy, inactiveUsers, dataRegion, consents, retention }, localization: { requireReview, requireFourEyes } }: merged block by block, validated like a configuration write.
    { method: 'PUT', pattern: '/__emulator/compliance/config', public: true, handler: async (c) => {
      applyConfigPatch(instanceConfig(c.engine), c.body);
      await captureAutoSnapshot(c.engine);
      return { body: { object: 'compliance_config', ...structuredClone(instanceConfig(c.engine)) } };
    } },
    { method: 'GET', pattern: '/__emulator/compliance/audit', public: true, handler: (c) => {
      const action = c.query.get('action');
      const rows = auditLog(c.engine).filter((r) => !action || r.action === action).slice().reverse();
      return { body: { object: 'list', data: rows.map((r) => ({ object: 'audit_log_entry', ...r })), has_more: false, next_cursor: null } };
    } },
  ];
}
