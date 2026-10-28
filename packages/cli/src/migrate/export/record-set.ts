import {
  CANONICAL_MODEL_ORDER,
  type CanonicalModel,
  type CanonicalRecordData,
  type MigrationManifest,
} from '@atlasauth/migrate';

/**
 * What a vendor exporter gathered, grouped by canonical model. A vendor API
 * hands data back in ITS order (users carry their identities, organizations
 * their members); the bundle needs canonical order, so exporters collect here
 * and the writer replays {@link RecordSet.ordered}.
 */
export class RecordSet {
  private readonly rows = new Map<CanonicalModel, unknown[]>();
  private readonly seen = new Map<CanonicalModel, Set<string>>();
  readonly warnings: string[] = [];
  readonly omitted: Record<string, { count: number; reason: string }> = {};
  /** Manifest fields the exporter learned (origin, providers, settings, rpId). */
  manifest: Partial<Pick<MigrationManifest, 'origin' | 'sourceVersion' | 'rpId' | 'providers' | 'settings'>> = {};

  /**
   * Add a row. With `key`, a second row with the same key is dropped (a member
   * reached through two listings, a role seen on two organizations).
   */
  add<M extends CanonicalModel>(model: M, data: CanonicalRecordData[M], key?: string): void {
    if (key !== undefined) {
      const keys = this.seen.get(model) ?? new Set<string>();
      if (keys.has(key)) return;
      keys.add(key);
      this.seen.set(model, keys);
    }
    const list = this.rows.get(model) ?? [];
    list.push(data);
    this.rows.set(model, list);
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  omit(model: string, reason: string, count = 1): void {
    const o = this.omitted[model] ?? { count: 0, reason };
    o.count += count;
    this.omitted[model] = o;
  }

  count(model: CanonicalModel): number {
    return this.rows.get(model)?.length ?? 0;
  }

  list<M extends CanonicalModel>(model: M): Array<CanonicalRecordData[M]> {
    return (this.rows.get(model) ?? []) as Array<CanonicalRecordData[M]>;
  }

  /** Every row, in the order the bundle writer requires. */
  *ordered(): Generator<{ model: CanonicalModel; data: unknown }> {
    for (const model of CANONICAL_MODEL_ORDER) {
      for (const data of this.rows.get(model) ?? []) yield { model, data };
    }
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const model of CANONICAL_MODEL_ORDER) {
      const n = this.rows.get(model)?.length ?? 0;
      if (n) out[model] = n;
    }
    return out;
  }
}

// ── small mapping helpers every vendor uses ─────────────────────────────────

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
export const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => x !== undefined) : [];
/** A metadata bag, only when it has keys. */
export const bag = (v: unknown): Obj | undefined => (isObj(v) && Object.keys(v).length > 0 ? v : undefined);
/** E.164 or nothing: vendors store numbers with spaces/dashes; anything else is dropped. */
export function e164(raw: unknown): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  const digits = s.replace(/[\s().-]/g, '');
  const withPlus = digits.startsWith('+') ? digits : digits.startsWith('00') ? `+${digits.slice(2)}` : `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(withPlus) ? withPlus : undefined;
}
/** Drop undefined fields so a record carries only what the vendor had. */
export function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) {
    const v = o[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete o[k];
  }
  return o;
}
