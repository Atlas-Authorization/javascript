/**
 * §9A — Cryptoeconomic BOND SETTLEMENT for the optimistic fast-path.
 *
 * `optimistic.ts` is the pure claim + challenge + fraud LOGIC: it decides whether a bonded claim was
 * fraudulent (`verifyFraudProof` → a server-derived `FraudVerdict`), but it deliberately leaves the
 * economic bond — escrow, release, slashing, the ledger of balances — to a settlement layer, resolving
 * only opaque `bond_ref` handles. THIS module is that settlement layer's PURE accounting + signed
 * records: who deposited, whether the bond was returned (unchallenged) or slashed (proven fraud), and a
 * non-repudiable `SettlementRecord` for each transition that anyone can verify against the guardian key.
 *
 * WHAT BINDS A SLASH TO REALITY. A slash is NOT authorized by challenger assertion. `slashBond` re-runs
 * `verifyFraudProof` itself (against the grant the settlement layer trusts) and refuses unless the
 * SERVER-DERIVED verdict is `fraudulent` and names this very bond. The record's `evidenceDigest` is a
 * `settlementEvidenceDigest(claim, verdict)` over that verdict's output — so the signed slash commits to
 * the fraud finding the server recomputed, never to anything the challenger supplied.
 *
 * SCOPE / SEAM. Balances live in a simple in-memory `Map` here so the logic is testable and
 * self-contained. In production the real store (a database, an on-chain escrow, a custody ledger) is a
 * SEAM: persist the `SettlementRecord`s and the per-account balances exactly as this class computes
 * them, and re-verify records with `verifySettlement`. The signing key is the guardian / settlement key;
 * only the public half is needed to verify.
 */
import { b64u, canonicalBytes, hashCanonical, utf8 } from './hash';
import { publicKeyOf, sign, verifyB64u } from './keys';
import type { Capability } from './capability';
import { type BondedClaim, type FraudProof, type FraudVerdict, verifyFraudProof } from './optimistic';

const DOMAIN = 'atlas-pca/bond-settlement/v1\0';

/** The default escrow account label (where an open bond is locked until it is released or slashed). */
export const ESCROW_ACCOUNT = 'escrow';

export type SettlementAction = 'open' | 'release' | 'slash';

/** A signed, non-repudiable record of one bond transition (open / release / slash). */
export interface SettlementRecord {
  /** The bond/claim handle this record settles (== the optimistic claim's `bond_ref`). */
  claimId: string;
  action: SettlementAction;
  /** The bonded amount moved by this transition. */
  amount: number;
  /** Source account: the depositor (open), or the escrow (release / slash). */
  from: string;
  /** Destination account: the escrow (open), the depositor (release), or the treasury (slash). */
  to: string;
  /** Settlement time (epoch ms). */
  at: number;
  /**
   * For a slash: `settlementEvidenceDigest(claim, verdict)` binding this record to the SERVER-DERIVED
   * fraud verdict. Empty string for open/release (no fraud evidence underlies them).
   */
  evidenceDigest: string;
  /** b64u Ed25519 signature by the guardian/settlement key over the canonical record body. */
  sig: string;
}

export type SettlementRecordBody = Omit<SettlementRecord, 'sig'>;

function settlementMessage(body: SettlementRecordBody): Uint8Array {
  const d = canonicalBytes(body);
  const p = utf8(DOMAIN);
  const m = new Uint8Array(p.length + d.length);
  m.set(p);
  m.set(d, p.length);
  return m;
}

/**
 * The digest that binds a slash to the server-derived fraud verdict. It hashes the claim identity
 * (digest + bond) together with `verifyFraudProof`'s OWN output (`fraudulent`, `slashBondRef`, `reason`)
 * — never challenger-supplied fields — so a settlement record provably commits to the fraud finding the
 * settlement layer recomputed.
 */
export function settlementEvidenceDigest(claim: BondedClaim, fraudVerdict: FraudVerdict): string {
  return hashCanonical({
    claimDigest: claim.pcactn_digest,
    bond_ref: claim.bond_ref,
    fraudulent: fraudVerdict.fraudulent,
    slashBondRef: fraudVerdict.slashBondRef ?? null,
    reason: fraudVerdict.reason,
  });
}

/**
 * Evidence digest for a REVOCATION slash — a capability in the claim's chain was revoked after the
 * bond opened. The authorizing fact is server-derived (membership in the instance's revocation set),
 * not a challenger assertion; the caller MUST confirm the revocation before slashing. Binds the signed
 * record to the revoked capability id.
 */
export function revocationEvidenceDigest(claim: BondedClaim, revokedCapId: string): string {
  return hashCanonical({
    claimDigest: claim.pcactn_digest,
    bond_ref: claim.bond_ref,
    kind: 'revocation',
    revokedCapId,
  });
}

/** Verify a settlement record's signature under the guardian/settlement public key. Never throws. */
export function verifySettlement(record: SettlementRecord, guardianPublicKey: string): boolean {
  try {
    if (!record || typeof record !== 'object') return false;
    const { sig, ...body } = record;
    if (typeof sig !== 'string') return false;
    return verifyB64u(guardianPublicKey, settlementMessage(body), sig);
  } catch {
    return false;
  }
}

/** The lifecycle status of a bond in the ledger. */
export type BondPhase = 'none' | 'open' | 'released' | 'slashed';

interface BondState {
  claimId: string;
  amount: number;
  depositor: string;
  status: Exclude<BondPhase, 'none'>;
}

export interface BondLedgerOpts {
  /** The guardian/settlement secret key that signs every record. */
  guardianSecret: Uint8Array;
  /** The escrow account label (default `ESCROW_ACCOUNT`). */
  escrowAccount?: string;
}

/**
 * A simple in-memory, `Map`-backed bond ledger (the real store is a seam — see module header). It
 * locks a bond on `openBond`, returns it to the depositor on `releaseBond` (after an unchallenged
 * window), or moves it to the treasury on `slashBond` (only against a VERIFIED fraud verdict). Each
 * transition produces a guardian-signed `SettlementRecord`. `balanceOf` reports settled credits (a
 * release credits the depositor; a slash credits the treasury); an open bond is locked in escrow and
 * credits no one until it settles.
 */
export class BondLedger {
  /** The guardian/settlement public key (b64u) — hand this to verifiers of the signed records. */
  readonly guardianPublicKey: string;
  private readonly guardianSecret: Uint8Array;
  private readonly escrow: string;
  private readonly bonds = new Map<string, BondState>();
  private readonly balances = new Map<string, number>();

  constructor(opts: BondLedgerOpts) {
    if (!(opts.guardianSecret instanceof Uint8Array)) {
      throw new Error('BondLedger: guardianSecret must be a Uint8Array');
    }
    this.guardianSecret = opts.guardianSecret;
    this.guardianPublicKey = b64u(publicKeyOf(opts.guardianSecret));
    this.escrow = opts.escrowAccount ?? ESCROW_ACCOUNT;
  }

  /** The settled credit balance of `account` (0 if unknown). */
  balanceOf(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  /** The lifecycle status of the bond for `claimId`. */
  bondStatus(claimId: string): BondPhase {
    return this.bonds.get(claimId)?.status ?? 'none';
  }

  private credit(account: string, amount: number): void {
    this.balances.set(account, this.balanceOf(account) + amount);
  }

  private signRecord(body: SettlementRecordBody): SettlementRecord {
    return { ...body, sig: b64u(sign(this.guardianSecret, settlementMessage(body))) };
  }

  private now(at?: number): number {
    return Number.isFinite(at) ? (at as number) : Date.now();
  }

  /**
   * Open (lock) a bond. Refuses a non-positive/non-finite amount and a double-open of the same claim.
   * The bond moves from the depositor into escrow; it credits no account until it settles.
   */
  openBond(params: { claimId: string; amount: number; depositor: string; at?: number }): SettlementRecord {
    const { claimId, amount, depositor } = params;
    if (typeof claimId !== 'string' || claimId.length === 0) throw new Error('openBond: claimId is required');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('openBond: amount must be a positive finite number');
    if (typeof depositor !== 'string' || depositor.length === 0) throw new Error('openBond: depositor is required');
    if (this.bonds.has(claimId)) throw new Error(`openBond: bond ${claimId} already exists (double-open refused)`);

    this.bonds.set(claimId, { claimId, amount, depositor, status: 'open' });
    return this.signRecord({
      claimId,
      action: 'open',
      amount,
      from: depositor,
      to: this.escrow,
      at: this.now(params.at),
      evidenceDigest: '',
    });
  }

  /**
   * Release a bond back to its depositor after an unchallenged challenge window. Refuses a bond that
   * does not exist or is not currently `open` (double-settle refused). Credits the depositor.
   */
  releaseBond(params: { claimId: string; at?: number }): SettlementRecord {
    const { claimId } = params;
    const bond = this.bonds.get(claimId);
    if (!bond) throw new Error(`releaseBond: no bond for ${claimId}`);
    if (bond.status !== 'open') throw new Error(`releaseBond: bond ${claimId} is already ${bond.status} (double-settle refused)`);

    bond.status = 'released';
    this.credit(bond.depositor, bond.amount);
    return this.signRecord({
      claimId,
      action: 'release',
      amount: bond.amount,
      from: this.escrow,
      to: bond.depositor,
      at: this.now(params.at),
      evidenceDigest: '',
    });
  }

  /**
   * Slash a bond to the treasury — ONLY against a VERIFIED fraud verdict. This method itself re-runs
   * `verifyFraudProof` (against the grant the settlement layer trusts) and refuses unless the
   * server-derived verdict is `fraudulent` and slashes THIS bond; the challenger's assertion alone
   * never authorizes a slash. Refuses a non-existent / already-settled bond (double-settle). The signed
   * record's `evidenceDigest` binds to the recomputed verdict. Credits the treasury.
   */
  slashBond(params: {
    claimId: string;
    claim: BondedClaim;
    fraudProof: FraudProof;
    grant: Capability;
    treasury: string;
    at?: number;
  }): SettlementRecord {
    const { claimId, claim, fraudProof, grant, treasury } = params;
    const bond = this.bonds.get(claimId);
    if (!bond) throw new Error(`slashBond: no bond for ${claimId}`);
    if (bond.status !== 'open') throw new Error(`slashBond: bond ${claimId} is already ${bond.status} (double-settle refused)`);
    if (typeof treasury !== 'string' || treasury.length === 0) throw new Error('slashBond: treasury is required');
    if (claim.bond_ref !== claimId) throw new Error('slashBond: claim.bond_ref does not match claimId');

    // Independently re-derive the fraud verdict — NOT challenger input.
    const verdict = verifyFraudProof(claim, fraudProof, grant);
    if (!verdict.fraudulent || verdict.slashBondRef !== claimId) {
      throw new Error(`slashBond: refused — no verified fraud verdict slashing ${claimId} (${verdict.reason})`);
    }

    bond.status = 'slashed';
    this.credit(treasury, bond.amount);
    return this.signRecord({
      claimId,
      action: 'slash',
      amount: bond.amount,
      from: this.escrow,
      to: treasury,
      at: this.now(params.at),
      evidenceDigest: settlementEvidenceDigest(claim, verdict),
    });
  }

  /**
   * Slash a bond because a capability in the claim's chain was REVOKED after the bond opened. The
   * authorizing evidence is server-derived (the caller MUST have confirmed `revokedCapId` is both in
   * the claim's chain and currently in the instance's revocation set) — never a challenger assertion.
   * Credits the treasury; binds the record to the revocation evidence. Refuses a missing/already-settled
   * bond (double-settle).
   */
  slashBondOnRevocation(params: {
    claimId: string;
    claim: BondedClaim;
    revokedCapId: string;
    treasury: string;
    at?: number;
  }): SettlementRecord {
    const { claimId, claim, revokedCapId, treasury } = params;
    const bond = this.bonds.get(claimId);
    if (!bond) throw new Error(`slashBondOnRevocation: no bond for ${claimId}`);
    if (bond.status !== 'open') throw new Error(`slashBondOnRevocation: bond ${claimId} is already ${bond.status} (double-settle refused)`);
    if (typeof treasury !== 'string' || treasury.length === 0) throw new Error('slashBondOnRevocation: treasury is required');
    if (claim.bond_ref !== claimId) throw new Error('slashBondOnRevocation: claim.bond_ref does not match claimId');
    if (typeof revokedCapId !== 'string' || revokedCapId.length === 0) throw new Error('slashBondOnRevocation: revokedCapId is required');

    bond.status = 'slashed';
    this.credit(treasury, bond.amount);
    return this.signRecord({
      claimId,
      action: 'slash',
      amount: bond.amount,
      from: this.escrow,
      to: treasury,
      at: this.now(params.at),
      evidenceDigest: revocationEvidenceDigest(claim, revokedCapId),
    });
  }
}
