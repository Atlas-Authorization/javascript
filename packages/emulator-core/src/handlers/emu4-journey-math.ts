import { sha256 } from '../crypto-util';

/**
 * Journey A/B experiment maths, the same as the API's: variants validate the same way, a user's bucket is
 * sha256(experiment id, NUL, user id) read as a big-endian 32-bit number modulo 100, and the readout carries rates,
 * a 95% Wilson interval, relative lift and a two-sided two-proportion z-test against the first (control) variant.
 */
export const MAX_EXPERIMENT_VARIANTS = 5;
export interface ExperimentVariant {
  key: string;
  version: number;
  weight: number;
}
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateVariants(raw: unknown, versionExists: (version: number) => boolean): { path: string; message: string } | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_EXPERIMENT_VARIANTS) return { path: 'variants', message: `variants: 2 to ${MAX_EXPERIMENT_VARIANTS} variants.` };
  const keys = new Set<string>();
  let total = 0;
  for (const [i, v] of raw.entries()) {
    const p = `variants.${i}`;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { path: p, message: 'Expected an object.' };
    const x = v as Record<string, unknown>;
    const unknown = Object.keys(x).find((k) => k !== 'key' && k !== 'version' && k !== 'weight');
    if (unknown) return { path: `${p}.${unknown}`, message: 'Expected key, version and weight.' };
    if (typeof x.key !== 'string' || !KEY_RE.test(x.key) || keys.has(x.key)) return { path: `${p}.key`, message: 'key: a unique name of 1-32 lowercase letters, digits, _ or -.' };
    keys.add(x.key);
    if (!Number.isInteger(x.version) || (x.version as number) < 1 || !versionExists(x.version as number)) return { path: `${p}.version`, message: 'version must be a saved version of this journey.' };
    if (!Number.isInteger(x.weight) || (x.weight as number) < 1 || (x.weight as number) > 99) return { path: `${p}.weight`, message: 'weight: a whole number of percent from 1 to 99.' };
    total += x.weight as number;
  }
  if (total !== 100) return { path: 'variants', message: `The weights must add up to 100 (they add up to ${total}).` };
  return null;
}

export async function experimentBucket(experimentId: string, userId: string): Promise<number> {
  const h = await sha256(`${experimentId}\u0000${userId}`);
  return ((h[0]! * 2 ** 24 + (h[1]! << 16) + (h[2]! << 8) + h[3]!) >>> 0) % 100;
}

export function variantForBucket(variants: ExperimentVariant[], bucket: number): ExperimentVariant {
  let upTo = 0;
  for (const v of variants) {
    upTo += v.weight;
    if (bucket < upTo) return v;
  }
  return variants[variants.length - 1]!;
}

export interface VariantCounts {
  key: string;
  assigned: number;
  started: number;
  completed: number;
  abandoned: number;
  durationMsTotal: number;
}

const erf = (x: number): number => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export function wilsonInterval(successes: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.959964;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function experimentReadout(counts: VariantCounts[], alpha = 0.05) {
  const control = counts[0];
  return counts.map((c, i) => {
    const rate = c.started > 0 ? c.completed / c.started : null;
    const base = control && control.started > 0 ? control.completed / control.started : null;
    let p: number | null = null;
    if (i > 0 && control && control.started > 0 && c.started > 0) {
      const pooled = (control.completed + c.completed) / (control.started + c.started);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.started + 1 / c.started));
      if (se > 0) p = 2 * (1 - normalCdf(Math.abs((rate! - base!) / se)));
      else p = rate === base ? 1 : 0;
    }
    return {
      ...c,
      in_progress: Math.max(c.started - c.completed - c.abandoned, 0),
      completion_rate: rate,
      abandon_rate: c.started > 0 ? c.abandoned / c.started : null,
      avg_duration_ms: c.completed > 0 ? Math.round(c.durationMsTotal / c.completed) : null,
      completion_interval: wilsonInterval(c.completed, c.started),
      lift: i > 0 && rate !== null && base ? (rate - base) / base : null,
      p_value: p,
      significant: p !== null && p < alpha,
    };
  });
}
