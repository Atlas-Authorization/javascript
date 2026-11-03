/**
 * SRP-6a sign-in: prove knowledge of the password without sending it.
 *
 * Uses RFC 5054's 3072-bit group with SHA-256 (the server publishes the same
 * parameters), on WebCrypto and BigInt, so it runs in any current browser and
 * Node. The flow on an existing sign-in attempt:
 *
 *   srp_challenge  -> salt, B, and the identity to hash in
 *   srp_verify     -> M1 (the client proof); the server answers with M2
 *
 * and the helper checks M2, so a server that does not know the verifier cannot
 * pass as Atlas. SRP does not replace TLS, and a passkey is a stronger
 * sign-in; use this for apps that already speak SRP (Cognito migrations) or
 * that must keep the password out of the request body.
 */
import type { FapiClient, FapiResponse } from './fapi';

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
const N = BigInt('0x' + N_HEX);
// BigInt() calls, not literals: the embed bundle targets ES2019 syntax.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const G = BigInt(5);
const N_LEN = N_HEX.length / 2;

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from((h.length % 2 ? '0' + h : h).match(/../g) ?? [], (x) => parseInt(x, 16));
const big = (b: Uint8Array) => (b.length ? BigInt('0x' + toHex(b)) : ZERO);
const bytes = (n: bigint) => fromHex(n.toString(16));
const pad = (n: bigint) => {
  const b = bytes(n);
  const out = new Uint8Array(Math.max(N_LEN, b.length));
  out.set(b, out.length - b.length);
  return out;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts) as BufferSource));

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = ONE;
  let b = ((base % mod) + mod) % mod;
  for (let e = exp; e > ZERO; e >>= ONE) {
    if (e & ONE) result = (result * b) % mod;
    b = (b * b) % mod;
  }
  return result;
}

export interface SrpClientProof {
  /** Public value A, hex, for the challenge request. */
  A: string;
  /** Finish with the server's answer: the client proof M1 and the server proof M2 expected back (both hex). */
  respond(challenge: { salt: string; srp_b: string; user_id_for_srp: string }, password: string): Promise<{ M1: string; M2: string }>;
}

/** Start the client side of an exchange. `privateKey` is for tests; leave it unset. */
export function srpClientStart(privateKey?: bigint): SrpClientProof {
  const a = privateKey ?? big(crypto.getRandomValues(new Uint8Array(64)));
  const A = modPow(G, a, N);
  return {
    A: A.toString(16),
    async respond(ch, password) {
      const B = BigInt('0x' + ch.srp_b);
      if (B % N === ZERO) throw new Error('The server sent an invalid SRP value.');
      const k = big(await sha256(bytes(N), pad(G)));
      const u = big(await sha256(pad(A), pad(B)));
      const inner = await sha256(enc.encode(`${ch.user_id_for_srp}:${password}`));
      const x = big(await sha256(fromHex(ch.salt), inner));
      const base = (((B - k * modPow(G, x, N)) % N) + N) % N;
      const S = modPow(base, a + u * x, N);
      const K = await sha256(bytes(S));
      const hn = await sha256(bytes(N));
      const hg = await sha256(bytes(G));
      const xored = hn.map((v, i) => v ^ hg[i]!);
      const M1 = await sha256(xored, await sha256(enc.encode(ch.user_id_for_srp)), fromHex(ch.salt), pad(A), pad(B), K);
      const M2 = await sha256(pad(A), M1, K);
      return { M1: toHex(M1), M2: toHex(M2) };
    },
  };
}

export const SRP_CHALLENGE_PATH = (attemptId: string) => `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/srp_challenge`;
export const SRP_VERIFY_PATH = (attemptId: string) => `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/srp_verify`;

export interface SrpSignInOptions {
  identifier: string;
  password: string;
  /** Continue an attempt that already has its identifier; otherwise one is started. */
  attemptId?: string;
  /**
   * When SRP does not work (the account has no verifier yet, for example one migrated from
   * another provider), try an ordinary password sign-in on the same attempt, which also
   * sets up the verifier for next time. Default false.
   */
  fallbackToPassword?: boolean;
  /** Fixed client private value, for tests only. */
  privateKey?: bigint;
}

export type SrpSignInResult = FapiResponse<Record<string, unknown>> & {
  /** True when the server proved it knew the verifier (its M2 matched). */
  serverVerified: boolean;
  attemptId: string | null;
  method: 'srp' | 'password';
};

const fail = (status: number, message: string): SrpSignInResult => ({
  ok: false,
  status,
  data: null,
  errors: [{ code: 'SRP_FAILED', message }],
  serverVerified: false,
  attemptId: null,
  method: 'srp',
});

/** Sign in with SRP. On success `data` is the attempt view (with `ticket` when complete). */
export async function signInWithSrp(client: FapiClient, opts: SrpSignInOptions): Promise<SrpSignInResult> {
  let attemptId = opts.attemptId ?? null;
  if (!attemptId) {
    const start = await client.post<{ id: string }>('/v1/client/sign_ins', { identifier: opts.identifier });
    if (!start.ok || !start.data) return { ...start, serverVerified: false, attemptId: null, method: 'srp' } as SrpSignInResult;
    attemptId = start.data.id;
  }
  const passwordFallback = async (): Promise<SrpSignInResult> => {
    const res = await client.post<Record<string, unknown>>(`/v1/client/sign_ins/${encodeURIComponent(attemptId!)}/attempt_first_factor`, {
      strategy: 'password',
      password: opts.password,
    });
    return { ...res, serverVerified: false, attemptId, method: 'password' };
  };

  const proof = srpClientStart(opts.privateKey);
  const challenge = await client.post<{ srp_session: string; salt: string; srp_b: string; user_id_for_srp: string }>(SRP_CHALLENGE_PATH(attemptId), { srp_a: proof.A });
  if (!challenge.ok || !challenge.data) return opts.fallbackToPassword && challenge.status === 422 ? passwordFallback() : { ...challenge, serverVerified: false, attemptId, method: 'srp' } as SrpSignInResult;

  let answer: { M1: string; M2: string };
  try {
    answer = await proof.respond(challenge.data, opts.password);
  } catch (e) {
    return fail(400, (e as Error).message);
  }
  const verified = await client.post<Record<string, unknown>>(SRP_VERIFY_PATH(attemptId), { srp_session: challenge.data.srp_session, srp_m1: answer.M1 });
  if (!verified.ok) {
    // The attempt has used its failure budget on this try; the fallback is a second, ordinary attempt.
    return opts.fallbackToPassword ? passwordFallback() : ({ ...verified, serverVerified: false, attemptId, method: 'srp' } as SrpSignInResult);
  }
  const serverVerified = verified.data?.srp_m2 === answer.M2;
  if (!serverVerified) return { ...fail(400, 'The server did not prove it knows the verifier.'), attemptId };
  return { ...verified, serverVerified, attemptId, method: 'srp' };
}
