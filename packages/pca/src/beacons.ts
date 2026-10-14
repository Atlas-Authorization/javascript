/**
 * L5 dead-man freshness beacons + global kill switch (Deep Dive II "Sovereign kill switch").
 *
 * The guardian signs short-lived beacons {scope, epoch, not_after}. Authority is live only while a
 * valid beacon covers the current epoch; if the principal stops issuing, every agent freezes by the
 * next (short) epoch. Pure: epochs are integers supplied by the caller.
 */
import { b64u, canonicalBytes, utf8 } from './hash';
import { publicKeyOf, sign, verifyB64u } from './keys';

export const GLOBAL_SCOPE = '*';
const DOMAIN = 'atlas-pca/beacon/v1\0';

export interface Beacon {
  v: 1;
  /** '*' covers every scope; otherwise the exact scope string. */
  scope: string;
  /** First epoch the beacon is valid for. */
  epoch: number;
  /** Last epoch (inclusive) the beacon is valid for. */
  not_after: number;
  /** Guardian public key (b64u). */
  guardian: string;
  sig: string;
}

function msg(b: Omit<Beacon, 'sig'>): Uint8Array {
  const body = canonicalBytes({ v: b.v, scope: b.scope, epoch: b.epoch, not_after: b.not_after, guardian: b.guardian });
  const p = utf8(DOMAIN);
  const m = new Uint8Array(p.length + body.length);
  m.set(p);
  m.set(body, p.length);
  return m;
}

export function issueBeacon(args: { guardianSecret: Uint8Array; epoch: number; scope?: string; notAfter: number }): Beacon {
  const { guardianSecret, epoch, notAfter } = args;
  if (!Number.isInteger(epoch) || !Number.isInteger(notAfter) || notAfter < epoch) {
    throw new RangeError('issueBeacon: need integer epoch <= notAfter');
  }
  const body = { v: 1 as const, scope: args.scope ?? GLOBAL_SCOPE, epoch, not_after: notAfter, guardian: b64u(publicKeyOf(guardianSecret)) };
  return { ...body, sig: b64u(sign(guardianSecret, msg(body))) };
}

export interface BeaconVerdict {
  ok: boolean;
  reason?: string;
}

/** Signature (against the pinned guardian key) + freshness window; optionally scope coverage. */
export function verifyBeacon(
  beacon: Beacon,
  guardianPublic: Uint8Array | string,
  nowEpoch: number,
  scope?: string,
): BeaconVerdict {
  try {
    const pub = typeof guardianPublic === 'string' ? guardianPublic : b64u(guardianPublic);
    if (beacon.v !== 1 || beacon.guardian !== pub) return { ok: false, reason: 'wrong guardian key' };
    if (!verifyB64u(pub, msg(beacon), beacon.sig)) return { ok: false, reason: 'bad signature' };
    if (!Number.isInteger(beacon.epoch) || !Number.isInteger(beacon.not_after) || beacon.not_after < beacon.epoch) {
      return { ok: false, reason: 'malformed window' };
    }
    if (nowEpoch < beacon.epoch) return { ok: false, reason: 'not yet valid' };
    if (nowEpoch > beacon.not_after) return { ok: false, reason: 'expired' };
    if (scope !== undefined && beacon.scope !== GLOBAL_SCOPE && beacon.scope !== scope) {
      return { ok: false, reason: 'scope not covered' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'malformed beacon' };
  }
}

/**
 * Frozen = no valid beacon (from the pinned guardian) covers `nowEpoch` (and `scope`, if given).
 * Absence of beacons is a freeze: that is the dead-man / kill-switch semantics.
 */
export function isFrozen(beacons: Beacon[], nowEpoch: number, guardianPublic: Uint8Array | string, scope?: string): boolean {
  return !beacons.some((b) => verifyBeacon(b, guardianPublic, nowEpoch, scope).ok);
}
