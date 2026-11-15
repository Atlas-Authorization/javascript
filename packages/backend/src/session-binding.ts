import { checkDpopProof, memoryDpopReplayStore, type DpopReplayStore } from './oauth-resource';

/** The DPoP key a session token is bound to (`cnf.jkt`), or null for a bearer session token. */
export function sessionBindingOf(claims: { cnf?: { jkt?: unknown } } | null | undefined): { jkt: string } | null {
  const jkt = claims?.cnf?.jkt;
  return typeof jkt === 'string' && jkt ? { jkt } : null;
}

export interface VerifyBoundSessionInput {
  /** The verified claims of the session token (`verifyToken` / `authenticateRequest`). */
  claims: { cnf?: { jkt?: unknown } };
  /** The session token itself (its hash is the proof's `ath`). */
  token: string;
  /** The `DPoP` request header, if any. */
  proof: string | undefined | null;
  /** The request method and absolute URL (or a path, with `publicOrigin`). */
  method: string;
  url: string;
  publicOrigin?: string;
  /** Replay guard for proof ids. The default is an in-process one: pass a shared store when you run several instances. */
  replayStore?: DpopReplayStore;
  now?: number;
}

export type VerifyBoundSessionResult =
  | { ok: true; bound: boolean; jkt: string | null }
  | { ok: false; bound: true; jkt: string; reason: 'missing_proof' | 'invalid_proof'; message: string };

const defaultReplay = memoryDpopReplayStore();

/**
 * Enforce a session token's sender constraint at your API. A token without `cnf.jkt` is a bearer session token and
 * passes (`bound: false`: use `requireBound` in your own policy if you need to refuse those). A token with it must
 * arrive with a DPoP proof signed by that key for this request (method, URL, token hash, fresh, single use).
 */
export async function verifyBoundSession(input: VerifyBoundSessionInput): Promise<VerifyBoundSessionResult> {
  const binding = sessionBindingOf(input.claims);
  if (!binding) return { ok: true, bound: false, jkt: null };
  if (!input.proof) {
    return { ok: false, bound: true, jkt: binding.jkt, reason: 'missing_proof', message: 'This session token is bound to a key: send a DPoP proof signed by it.' };
  }
  const refusal = await checkDpopProof(input.proof, {
    token: input.token,
    jkt: binding.jkt,
    method: input.method,
    url: input.url,
    publicOrigin: input.publicOrigin,
    now: input.now ?? Date.now(),
    replay: input.replayStore ?? defaultReplay,
  });
  if (refusal) return { ok: false, bound: true, jkt: binding.jkt, reason: 'invalid_proof', message: refusal.message };
  return { ok: true, bound: true, jkt: binding.jkt };
}

