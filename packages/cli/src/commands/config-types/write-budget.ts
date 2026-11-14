import type { ResourceSpec } from '../config';
import type { Json } from '../../serialize';
import { settingsSpec } from './settings';

const NAMES = ['writes', 'counter_writes', 'events', 'webhook_fanout'] as const;

/**
 * `write_budget`: the per-instance write budgets (mode and limits per minute). The live side answers each budget
 * as `{ limit, custom }`; a limit the instance did not set is `null` in the file, so the file never pins today's
 * platform default.
 */
export const WRITE_BUDGET_CONFIG_TYPES: ResourceSpec[] = [
  settingsSpec({
    type: 'write_budget',
    path: '/v1/instance/write_budget',
    fileKeys: ['mode', ...NAMES.map((n) => `${n}_per_minute`)],
    liveOf: (res) => {
      const budgets = (res.budgets ?? {}) as Record<string, { limit?: number; custom?: boolean }>;
      const out: Record<string, Json> = { mode: (res.mode as Json) ?? 'observe' };
      for (const n of NAMES) out[`${n}_per_minute`] = budgets[n]?.custom ? (budgets[n]!.limit ?? null) : null;
      return out;
    },
  }),
];
