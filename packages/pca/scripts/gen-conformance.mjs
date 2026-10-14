// Generates golden conformance vectors from the BUILT @atlasauth/pca (dist). Deterministic:
// fixed keys (seed = sha256(label)); Ed25519 signatures are deterministic (RFC 8032).
// Usage: pnpm --filter @atlasauth/pca build && node packages/pca/scripts/gen-conformance.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pca from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'conformance');
mkdirSync(outDir, { recursive: true });

const seed = (label) => new Uint8Array(createHash('sha256').update(`atlas-pca-conformance/${label}`).digest());
const mk = (label) => {
  const secretKey = seed(label);
  return { label, secretKey, publicKey: pca.publicKeyOf(secretKey) };
};
const principal = mk('principal');
const agent = mk('agent');
const sub = mk('subagent');
const rogue = mk('rogue');
const keys = {};
for (const k of [principal, agent, sub, rogue]) {
  keys[k.label] = { seed: pca.b64u(k.secretKey), public: pca.b64u(k.publicKey) };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const caveatA = { type: 'max_spend', usd: 100 };
// Exercises UTF-16 key ordering (U+FF5E sorts AFTER U+1F600's surrogate pair) and non-ASCII strings.
const caveatB = { type: 'note', '～': 1, '\u{1F600}': 2, z: 3, text: 'café <&> "q" \\ \n ' };
const caveatC = { type: 'resource_prefix', prefix: 'db/' };

const root = pca.mintRoot({
  principalSecret: principal.secretKey,
  principalPublic: pca.b64u(principal.publicKey),
  holder: pca.b64u(agent.publicKey),
  caveats: [caveatA, caveatB],
});
const planNodes = [
  { id: 'n1', verb: 'read', resource: 'db/users' },
  { id: 'n2', verb: 'write', resource: 'db/orders', params_digest: pca.paramsDigest({ qty: 3, sku: 'A-1' }), reversibility_class: 'reversible' },
  { id: 'n3', verb: 'delete', resource: 'db/orders', reversibility_class: 'irreversible', pre: { exists: true }, post: { exists: false } },
  { id: 'n4', verb: 'send', resource: 'mail/out', params_digest: pca.paramsDigest({ to: 'a@b.c' }) },
  { id: 'n5', verb: 'read', resource: 'db/items' },
];

const build = (o) => pca.buildPCActn({ grant: root, chain: [root], plan: planNodes, nodeId: 'n2', params: { qty: 3, sku: 'A-1' }, counter: 7, signerSecret: agent.secretKey, ...o });
const resign = (p, secret) => {
  const { sig: _s, ...body } = p;
  return pca.signPCActn(body, secret);
};

const vectors = [];
async function add(name, description, grant, plan, pcactn) {
  const r = await pca.verifyPCActnCore(pcactn, { grant });
  const c = r.checks;
  const b = (k) => c[k] === 'pass';
  vectors.push({
    name,
    description,
    grant,
    plan_nodes: plan,
    pcactn,
    expect: {
      allow: r.allow,
      checks: { chain: b('cap_chain'), plan_inclusion: b('plan_inclusion'), leaf_signature: b('leaf_signature'), counter: b('counter') },
    },
  });
}

await add('valid-in-plan-action', 'Valid action at plan node n2 with a 1-hop chain.', root, planNodes, build());
for (const id of ['n1', 'n3', 'n4', 'n5']) {
  const params = id === 'n4' ? { to: 'a@b.c' } : undefined;
  await add(`valid-plan-node-${id}`, `Valid action at plan node ${id} (exercises a different Merkle path in a 5-leaf tree).`, root, planNodes, build({ nodeId: id, params, counter: 1 }));
}
{ // out-of-plan: action not in the plan, but signed correctly by the holder
  const p = build();
  const body = clone(p); delete body.sig;
  body.action = { verb: 'drop', resource: 'db/everything', params_digest: pca.paramsDigest(), reversibility_class: 'irreversible' };
  await add('out-of-plan-action', 'Action not in the committed plan, correctly signed: plan_inclusion fails.', root, planNodes, pca.signPCActn(body, agent.secretKey));
}
{
  const p = build(); p.action.params_digest = pca.paramsDigest({ qty: 999, sku: 'A-1' });
  await add('tampered-params', 'params_digest altered after signing: plan_inclusion and leaf_signature fail.', root, planNodes, p);
}
{
  const p = build(); p.action.params_digest = pca.paramsDigest({ qty: 999, sku: 'A-1' });
  await add('tampered-params-resigned', 'params_digest altered and re-signed by the right key: only plan_inclusion fails.', root, planNodes, resign(p, agent.secretKey));
}
await add('wrong-key-leaf-signature', 'Signed by a key that is not the leaf holder: leaf_signature fails.', root, planNodes, build({ signerSecret: rogue.secretKey }));
{
  const p = build(); p.counter = 8;
  await add('tampered-counter-after-signing', 'counter modified after signing: leaf_signature fails.', root, planNodes, p);
}
{
  const p = build(); p.counter = -1;
  await add('invalid-counter', 'Negative counter (re-signed): counter check fails.', root, planNodes, resign(p, agent.secretKey));
}
{
  const p = build(); p.plan.inclusion_proof.path[0].hash = p.plan.inclusion_proof.path[1].hash;
  await add('tampered-merkle-proof', 'A sibling hash in the inclusion proof is replaced: plan_inclusion fails.', root, planNodes, p);
}
{
  const p = build(); p.plan.conditions_digest = pca.conditionsDigest({ x: 1 }, null);
  await add('tampered-conditions-digest', 'conditions_digest swapped for another: plan_inclusion fails.', root, planNodes, p);
}

// 2-hop delegated chain
const hop1 = pca.delegate(root, pca.b64u(sub.publicKey), [caveatC], agent.secretKey);
const chain2 = [root, hop1];
const build2 = (o) => pca.buildPCActn({ grant: root, chain: chain2, plan: planNodes, nodeId: 'n1', counter: 2, signerSecret: sub.secretKey, ...o });
await add('delegated-2-hop-chain', 'Two-hop chain (agent delegates to sub-agent, appending a caveat); leaf signed by the sub-agent.', root, planNodes, build2());
await add('delegated-leaf-signed-by-parent-holder', 'Chain is fine but the leaf was signed by the parent holder, not the sub-agent: leaf_signature fails.', root, planNodes, build2({ signerSecret: agent.secretKey }));
{ // validly signed hops whose caveats are NOT an append-only extension (only attenuation catches them)
  const bad = reseal(root, pca.b64u(sub.publicKey), [caveatA, caveatC], agent.secretKey);
  await add('chain-dropped-caveat', 'Child hop drops the parent caveat B (validly signed, parent-linked): chain fails.', root, planNodes, pca.buildPCActn({ grant: root, chain: [root, bad], plan: planNodes, nodeId: 'n1', counter: 2, signerSecret: sub.secretKey }));
  const reordered = reseal(root, pca.b64u(sub.publicKey), [caveatB, caveatA, caveatC], agent.secretKey);
  await add('chain-reordered-caveat', 'Child hop reorders the parent caveats (validly signed): chain fails.', root, planNodes, pca.buildPCActn({ grant: root, chain: [root, reordered], plan: planNodes, nodeId: 'n1', counter: 2, signerSecret: sub.secretKey }));
  const edited = reseal(root, pca.b64u(sub.publicKey), [{ type: 'max_spend', usd: 1000000 }, caveatB, caveatC], agent.secretKey);
  await add('chain-edited-caveat', 'Child hop widens a parent caveat (validly signed): chain fails.', root, planNodes, pca.buildPCActn({ grant: root, chain: [root, edited], plan: planNodes, nodeId: 'n1', counter: 2, signerSecret: sub.secretKey }));
}
{
  const forged = pca.delegate(root, pca.b64u(sub.publicKey), [caveatC], rogue.secretKey);
  await add('chain-hop-signed-by-wrong-key', 'Child hop signed by a key that is not the parent holder: chain fails.', root, planNodes, pca.buildPCActn({ grant: root, chain: [root, forged], plan: planNodes, nodeId: 'n1', counter: 2, signerSecret: sub.secretKey }));
}
{
  const p = build2(); p.cap_chain = [hop1, root];
  await add('chain-hops-reordered', 'The two hops are swapped: chain fails.', root, planNodes, p);
}
{
  const other = pca.mintRoot({ principalSecret: rogue.secretKey, principalPublic: pca.b64u(rogue.publicKey), holder: pca.b64u(agent.publicKey), caveats: [caveatA, caveatB] });
  await add('chain-root-not-grant', 'Chain root is a different principal\'s capability than the grant: chain fails.', root, planNodes, pca.buildPCActn({ grant: other, chain: [other], plan: planNodes, nodeId: 'n1', counter: 1, signerSecret: agent.secretKey }));
}

// reseal: a validly signed child hop with arbitrary (not necessarily attenuating) caveats.
function reseal(parent, toHolder, caveats, signerSecret) {
  const body = { issuer: parent.holder, holder: toHolder, caveats, parent: pca.capHash(parent) };
  const body_digest = pca.hashCanonical({ issuer: body.issuer, holder: body.holder, caveats: body.caveats, parent: body.parent });
  const msg = new Uint8Array([...new TextEncoder().encode('atlas-pca/cap/v1\0'), ...pca.unb64u(body_digest)]);
  return { id: body_digest, issuer: body.issuer, holder: body.holder, caveats, parent: body.parent, body_digest, sig: pca.b64u(pca.sign(signerSecret, msg)) };
}

// Primitive vectors for byte-level agreement checks.
const primitives = {
  canonical: [
    { value: { b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }, expect: '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}' },
    { value: { '～': 1, '\u{1F600}': 2 }, expect: null },
    { value: { s: 'café <&> "q" \\ \n \u0001' }, expect: null },
    { value: { n: [0, -1, 1.5, 100000, 1e21] }, expect: null },
  ],
  merkle: [3, 5, 7].map((n) => {
    const leaves = Array.from({ length: n }, (_, i) => ({ i, t: 'leaf' }));
    return { leaves, root: pca.merkleRoot(leaves), proofs: leaves.map((_, i) => pca.merkleProof(leaves, i)) };
  }),
  params_digest_empty: pca.EMPTY_PARAMS_DIGEST,
};
for (const c of primitives.canonical) {
  const e = pca.canonicalize(c.value);
  if (c.expect !== null && c.expect !== e) throw new Error('canonical self-check failed');
  c.expect = e;
  c.hash = pca.hashCanonical(c.value);
}
// 1e21 canonicalizes as "1e+21" in JS; drop it from the shared set to avoid cross-language float formatting traps.
primitives.canonical[3].value.n.pop();
primitives.canonical[3].expect = pca.canonicalize(primitives.canonical[3].value);
primitives.canonical[3].hash = pca.hashCanonical(primitives.canonical[3].value);

writeFileSync(join(outDir, 'keys.json'), JSON.stringify(keys, null, 2) + '\n');
writeFileSync(join(outDir, 'vectors.json'), JSON.stringify({ format: 1, sig_domain: 'atlas-pca/actn/v1\\0', cap_domain: 'atlas-pca/cap/v1\\0', primitives, vectors }, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors`);
