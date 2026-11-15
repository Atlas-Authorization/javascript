/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine } from '../engine';
import type { Obj } from '../openapi';
import { engineState } from './support';

/**
 * The signals access policies match on that the emulator cannot observe by itself: where an address is (country, ASN, anonymizer
 * data), how risky a sign-in is, whether the device is trusted. Tests set them with the `/__emulator/access/*` routes; a request
 * can also carry them (body fields, or the `cf-ipcountry` / `x-atlas-country`, `x-atlas-risk-level`, `x-atlas-device-trust`
 * headers). The request wins over the address facts, those over a per-user value, and that over the instance-wide default.
 */
export interface IpFacts {
  country: string | null;
  asn: number | null;
  tor: boolean | null;
  datacenter: boolean | null;
}
export interface Signals {
  country?: string;
  riskLevel?: string;
  userRiskLevel?: string;
  deviceTrust?: string;
  authMethods?: string[];
  clientType?: string;
  devicePlatform?: string;
  osVersion?: string;
}
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const DEVICE_TRUSTS = ['trusted', 'untrusted', 'unknown'] as const;
export const CLIENT_TYPES = ['browser', 'native', 'legacy', 'device_code', 'ciba', 'machine', 'agent'] as const;

interface State {
  ips: Map<string, IpFacts>;
  defaults: Signals;
  users: Map<string, Signals>;
}
export const signalState = engineState((): State => ({ ips: new Map(), defaults: {}, users: new Map() }));

export const noFacts = (): IpFacts => ({ country: null, asn: null, tor: null, datacenter: null });
export const ipFacts = (e: Engine, ip: string | null | undefined): IpFacts => (ip ? (signalState(e).ips.get(ip) ?? noFacts()) : noFacts());

/** The wire names (snake_case) of a signal object to the internal ones; unknown keys are ignored, bad values are reported. */
export function readSignals(o: Obj, fail: (msg: string, param: string) => never, prefix = ''): Signals {
  const out: Signals = {};
  const str = (k: string, allowed?: readonly string[]): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || !v || v.length > 100 || (allowed && !allowed.includes(v))) fail(`${prefix}${k} must be ${allowed ? `one of ${allowed.join(', ')}` : 'a non-empty string'}.`, `${prefix}${k}`);
    return v as string;
  };
  const country = str('country');
  if (country !== undefined) out.country = country.toUpperCase();
  const set = <K extends keyof Signals>(k: K, v: Signals[K]) => void (v !== undefined && (out[k] = v));
  set('riskLevel', str('risk_level', RISK_LEVELS));
  set('userRiskLevel', str('user_risk_level', RISK_LEVELS));
  set('deviceTrust', str('device_trust', DEVICE_TRUSTS));
  set('clientType', str('client_type', CLIENT_TYPES));
  set('devicePlatform', str('device_platform'));
  set('osVersion', str('os_version'));
  const am = o.auth_methods;
  if (am !== undefined && am !== null) {
    if (!Array.isArray(am) || am.some((x) => typeof x !== 'string')) fail(`${prefix}auth_methods must be an array of strings.`, `${prefix}auth_methods`);
    out.authMethods = am as string[];
  }
  return out;
}

/** Signals carried by request headers. */
export function headerSignals(h: Headers): Signals {
  const out: Signals = {};
  const country = h.get('x-atlas-country') ?? h.get('cf-ipcountry');
  if (country && /^[A-Za-z]{2}$/.test(country)) out.country = country.toUpperCase();
  const risk = h.get('x-atlas-risk-level');
  if (risk && (RISK_LEVELS as readonly string[]).includes(risk)) out.riskLevel = risk;
  const trust = h.get('x-atlas-device-trust');
  if (trust && (DEVICE_TRUSTS as readonly string[]).includes(trust)) out.deviceTrust = trust;
  return out;
}

/** Merge, first source wins per key. */
export const firstOf = (...sources: Array<Signals | undefined>): Signals => {
  const out: Signals = {};
  for (const s of [...sources].reverse()) if (s) for (const [k, v] of Object.entries(s)) if (v !== undefined) (out as any)[k] = v;
  return out;
};

/** Every signal for a request: explicit values, then the address's country, then the user's, then the instance default. */
export function resolveSignals(e: Engine, i: { userId?: string | null; ip?: string | null; explicit?: Signals }): Signals {
  const s = signalState(e);
  const facts = ipFacts(e, i.ip);
  return firstOf(i.explicit, facts.country ? { country: facts.country } : undefined, i.userId ? s.users.get(i.userId) : undefined, s.defaults);
}
