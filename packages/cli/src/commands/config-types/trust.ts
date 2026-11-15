import type { ResourceSpec } from '../config';
import type { Json } from '../../serialize';

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const pick = (src: Record<string, Json>, keys: readonly string[]): Record<string, Json> => {
  const out: Record<string, Json> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k]!;
  return out;
};

const SCHEDULE_KEYS = ['enabled', 'interval_days', 'alg', 'grace_period_seconds', 'prepublish_hours'] as const;
const CHAIN_KEYS = ['enabled', 'checkpoint_interval_seconds'] as const;

/**
 * `signing_key_schedule`: rotate the instance signing key by itself every `interval_days`. The previous key stays
 * published until every token it signed has expired, whatever the file says (a shorter `grace_period_seconds`
 * is refused). Absent live = no schedule. `audit_chain`: the tamper-evident audit chain; a chain that is on cannot
 * be turned off, so the file can only turn it on or change its checkpoint interval.
 */
export const TRUST_CONFIG_TYPES: ResourceSpec[] = [
  {
    kind: 'singleton',
    type: 'signing_key_schedule',
    fileKeys: SCHEDULE_KEYS,
    async fetchLive(http) {
      const res = await http.get<Record<string, Json>>('/v1/instance/signing_key_schedule');
      if (!isObj(res) || res.interval_days === null || res.interval_days === undefined) return null;
      return pick(res, SCHEDULE_KEYS);
    },
    async apply(http, config) {
      await http.put('/v1/instance/signing_key_schedule', pick(isObj(config) ? config : {}, SCHEDULE_KEYS));
    },
  },
  {
    kind: 'singleton',
    type: 'audit_chain',
    fileKeys: CHAIN_KEYS,
    async fetchLive(http) {
      const res = await http.get<Record<string, Json>>('/v1/audit/chain');
      if (!isObj(res) || res.enabled !== true) return null;
      return { enabled: true, checkpoint_interval_seconds: res.checkpoint_interval_seconds ?? null };
    },
    async apply(http, config) {
      const c = isObj(config) ? config : {};
      await http.put('/v1/audit/chain', { enabled: true, ...(c.checkpoint_interval_seconds != null ? { checkpoint_interval_seconds: c.checkpoint_interval_seconds } : {}) });
    },
  },
];
