import { b64u, canonicalBytes, hashCanonical, unb64u, utf8 } from './hash';
import { sign, verifyB64u } from './keys';

/**
 * Attenuable capability chain (spec §5.2).
 *
 * M0 enforces STRUCTURAL attenuation only: caveats are append-only (a child's caveat array must
 * start with the parent's full array), every hop is signed by the correct key, and parents are
 * hash-linked. SEMANTIC caveat evaluation — "does this action satisfy these caveats?" — is the
 * Policy VM (M1); see `CaveatEvaluator` below for the extension point. Because caveats can only
 * be appended and every caveat is a conjunctive constraint, a child can never be wider than its
 * parent: widening is impossible by construction.
 */

export interface Caveat {
  type: string;
  [k: string]: unknown;
}

export interface Capability {
  /** Hash of the signed body (content address). */
  id: string;
  /** Public key (b64u) that signed this hop. Root: the principal; child: the parent's holder. */
  issuer: string;
  /** Public key (b64u) this capability is bound to (cnf). */
  holder: string;
  caveats: Caveat[];
  /** capHash() of the parent capability; absent on the root. */
  parent?: string;
  body_digest: string;
  sig: string;
}

export type CapabilityChain = Capability[];

/** M1 extension point: semantic evaluation of a caveat against an action/context. */
export type CaveatEvaluator = (caveat: Caveat, ctx: unknown) => boolean;

const CAP_DOMAIN = 'atlas-pca/cap/v1\0';

function bodyOf(c: Pick<Capability, 'issuer' | 'holder' | 'caveats' | 'parent'>) {
  return {
    issuer: c.issuer,
    holder: c.holder,
    caveats: c.caveats,
    parent: c.parent ?? null,
  };
}

function sigMessage(bodyDigest: string): Uint8Array {
  const d = unb64u(bodyDigest);
  const p = utf8(CAP_DOMAIN);
  const m = new Uint8Array(p.length + d.length);
  m.set(p);
  m.set(d, p.length);
  return m;
}

/** Hash of a full capability (including signature); used as the child's `parent` link. */
export function capHash(c: Capability): string {
  return hashCanonical(c);
}

function seal(
  body: { issuer: string; holder: string; caveats: Caveat[]; parent?: string },
  signerSecret: Uint8Array,
): Capability {
  const body_digest = hashCanonical(bodyOf(body));
  const sig = b64u(sign(signerSecret, sigMessage(body_digest)));
  const cap: Capability = {
    id: body_digest,
    issuer: body.issuer,
    holder: body.holder,
    caveats: body.caveats,
    body_digest,
    sig,
  };
  if (body.parent !== undefined) cap.parent = body.parent;
  return cap;
}

function cloneCaveats(cs: Caveat[]): Caveat[] {
  return JSON.parse(new TextDecoder().decode(canonicalBytes(cs))) as Caveat[];
}

export function mintRoot(args: {
  principalSecret: Uint8Array;
  /** b64u */
  principalPublic: string;
  /** b64u holder key */
  holder: string;
  caveats: Caveat[];
}): Capability {
  return seal(
    { issuer: args.principalPublic, holder: args.holder, caveats: cloneCaveats(args.caveats) },
    args.principalSecret,
  );
}

/** Child with the same holder; caveats = parent.caveats ++ added. Signed by the parent's holder. */
export function attenuate(parent: Capability, addedCaveats: Caveat[], signerSecret: Uint8Array): Capability {
  return delegate(parent, parent.holder, addedCaveats, signerSecret);
}

/** Like attenuate, but rebinds `holder` to a new key (sub-agent). */
export function delegate(
  parent: Capability,
  toHolder: string,
  addedCaveats: Caveat[],
  signerSecret: Uint8Array,
): Capability {
  return seal(
    {
      issuer: parent.holder,
      holder: toHolder,
      caveats: [...cloneCaveats(parent.caveats), ...cloneCaveats(addedCaveats)],
      parent: capHash(parent),
    },
    signerSecret,
  );
}

export interface ChainResult {
  ok: boolean;
  reason?: string;
}

function checkSig(c: Capability, signer: string, label: string): string | undefined {
  let digest: string;
  try {
    digest = hashCanonical(bodyOf(c));
  } catch {
    return `${label}: malformed body`;
  }
  if (digest !== c.body_digest || c.id !== c.body_digest) return `${label}: body digest mismatch`;
  if (!verifyB64u(signer, sigMessage(c.body_digest), c.sig)) {
    return `${label}: bad signature (not signed by expected key)`;
  }
  return undefined;
}

export function verifyChain(chain: CapabilityChain, expectedRootIssuer?: string): ChainResult {
  if (!Array.isArray(chain) || chain.length === 0) return { ok: false, reason: 'empty chain' };
  const root = chain[0]!;
  if (root.parent !== undefined) return { ok: false, reason: 'hop 0: root must not have a parent' };
  if (expectedRootIssuer !== undefined && root.issuer !== expectedRootIssuer) {
    return { ok: false, reason: 'hop 0: root issuer is not the expected principal' };
  }
  const rootErr = checkSig(root, root.issuer, 'hop 0');
  if (rootErr) return { ok: false, reason: rootErr };

  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i - 1]!;
    const c = chain[i]!;
    const label = `hop ${i}`;
    if (c.parent !== capHash(parent)) return { ok: false, reason: `${label}: broken parent link` };
    // Holder-binding continuity: the hop must be issued by the key the parent is bound to.
    if (c.issuer !== parent.holder) {
      return { ok: false, reason: `${label}: issuer is not the parent's bound holder` };
    }
    const err = checkSig(c, parent.holder, label);
    if (err) return { ok: false, reason: err };
    // Attenuation-only: parent caveats must be an exact prefix (no drop, reorder or edit).
    if (c.caveats.length < parent.caveats.length) {
      return { ok: false, reason: `${label}: drops parent caveat(s)` };
    }
    for (let j = 0; j < parent.caveats.length; j++) {
      if (hashCanonical(c.caveats[j]) !== hashCanonical(parent.caveats[j])) {
        return { ok: false, reason: `${label}: caveat ${j} altered or reordered` };
      }
    }
  }
  return { ok: true };
}
