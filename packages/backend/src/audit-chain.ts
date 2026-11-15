import { sha256 } from '@noble/hashes/sha256';
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';

/**
 * Independent verification of an Atlas audit chain: recompute every row hash and link hash from the exported
 * links, and check the signed checkpoints against the instance's published keys. Nothing here talks to Atlas, so
 * the check does not rely on Atlas answering honestly. The algorithm is documented in the audit chain guide.
 */

const ROW_TAG = 'atlas.audit.row.v1';
const LINK_TAG = 'atlas.audit.link.v1';
const GENESIS_TAG = 'atlas.audit.genesis.v1';
export const AUDIT_CHECKPOINT_TYP = 'audit-checkpoint+jwt';

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = (text: string): string => hex(sha256(new TextEncoder().encode(text)));

/** JSON with object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** An audit row as `GET /v1/audit/chain/links` returns it (`row`). */
export interface ChainedAuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: unknown;
  /** Epoch milliseconds. */
  created_at: number;
}

export interface AuditChainLink {
  seq: number;
  audit_id: string;
  row_hash: string;
  link_hash: string;
  row: ChainedAuditRow | null;
}

export interface AuditChainCheckpoint {
  seq: number;
  link_hash: string;
  kid: string;
  alg: string;
  jws: string;
}

export function auditRowHash(row: ChainedAuditRow): string {
  return sha256Hex(
    canonicalJson([ROW_TAG, row.id, row.actor_type, row.actor_id ?? null, row.action, row.target_type ?? null, row.target_id ?? null, row.ip ?? null, row.user_agent ?? null, row.metadata ?? {}, row.created_at]),
  );
}

/** The `prev` of an instance's first link. */
export function auditChainGenesis(instanceId: string): string {
  return sha256Hex(`${GENESIS_TAG}\n${instanceId}`);
}

export function auditLinkHash(prevLinkHash: string, seq: number, rowHash: string): string {
  return sha256Hex(`${LINK_TAG}\n${prevLinkHash}\n${seq}\n${rowHash}`);
}

export type AuditChainProblem =
  | { kind: 'row_modified'; seq: number }
  | { kind: 'link_mismatch'; seq: number }
  | { kind: 'gap'; seq: number }
  | { kind: 'wrong_start'; seq: number }
  | { kind: 'checkpoint_mismatch'; seq: number }
  | { kind: 'checkpoint_signature'; seq: number }
  | { kind: 'checkpoint_unverifiable'; seq: number };

export interface VerifyAuditChainResult {
  /** True when nothing is wrong. `checkpoint_unverifiable` (the signing key was retired) alone does not fail the chain. */
  ok: boolean;
  checked: number;
  /** Links whose audit row retention removed (they still chain). */
  pruned: number;
  problems: AuditChainProblem[];
  /** The last link examined: continue from here with `prevLinkHash` / `fromSeq`. */
  lastSeq: number;
  lastLinkHash: string;
  checkpointsVerified: number;
}

export interface VerifyAuditChainInput {
  links: readonly AuditChainLink[];
  /** The link hash the first link chains from: {@link auditChainGenesis} for a chain from the start, else the previous page's `lastLinkHash`. */
  prevLinkHash: string;
  /** The sequence number the first link must have (default 1). */
  fromSeq?: number;
  checkpoints?: readonly AuditChainCheckpoint[];
  /** The instance's published keys (its JWKS `keys`), to check checkpoint signatures. */
  jwks?: { keys: JWK[] };
  instanceId?: string;
}

/** Recompute the chain over `links` and check any checkpoints that fall inside it. Pure; never throws for bad input. */
export async function verifyAuditChain(input: VerifyAuditChainInput): Promise<VerifyAuditChainResult> {
  const problems: AuditChainProblem[] = [];
  let prev = input.prevLinkHash;
  let expectSeq = input.fromSeq ?? 1;
  let pruned = 0;
  let checked = 0;
  const byseq = new Map<number, string>();
  for (const l of input.links) {
    if (l.seq !== expectSeq) {
      problems.push({ kind: l.seq < expectSeq ? 'wrong_start' : 'gap', seq: expectSeq });
      break;
    }
    if (l.row) {
      if (auditRowHash(l.row) !== l.row_hash) {
        problems.push({ kind: 'row_modified', seq: l.seq });
        break;
      }
    } else {
      pruned += 1;
    }
    if (auditLinkHash(prev, l.seq, l.row_hash) !== l.link_hash) {
      problems.push({ kind: 'link_mismatch', seq: l.seq });
      break;
    }
    prev = l.link_hash;
    byseq.set(l.seq, l.link_hash);
    expectSeq = l.seq + 1;
    checked += 1;
  }
  let checkpointsVerified = 0;
  if (input.checkpoints?.length) {
    const keyset = input.jwks ? createLocalJWKSet(input.jwks) : null;
    for (const c of input.checkpoints) {
      const have = byseq.get(c.seq);
      if (have === undefined) continue;
      if (have !== c.link_hash) {
        problems.push({ kind: 'checkpoint_mismatch', seq: c.seq });
        continue;
      }
      if (!keyset) continue;
      try {
        const { payload } = await jwtVerify(c.jws, keyset, { typ: AUDIT_CHECKPOINT_TYP, clockTolerance: Number.MAX_SAFE_INTEGER });
        if (payload.link_hash !== c.link_hash || payload.seq !== c.seq || (input.instanceId && payload.instance_id !== input.instanceId)) {
          problems.push({ kind: 'checkpoint_signature', seq: c.seq });
        } else {
          checkpointsVerified += 1;
        }
      } catch (error) {
        // A key that left the published set cannot be checked (not a break); any other failure is a bad signature.
        const code = (error as { code?: string }).code;
        problems.push({ kind: code === 'ERR_JWKS_NO_MATCHING_KEY' ? 'checkpoint_unverifiable' : 'checkpoint_signature', seq: c.seq });
      }
    }
  }
  return {
    ok: problems.every((p) => p.kind === 'checkpoint_unverifiable'),
    checked,
    pruned,
    problems,
    lastSeq: expectSeq - 1,
    lastLinkHash: prev,
    checkpointsVerified,
  };
}
