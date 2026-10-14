import {
  DEFAULT_RISK_POLICY, PCACTN_VERSION, commitPlan, conditionsDigest, delegate, encodeKey, generateKeyPair,
  hashCanonical, mintGrant, signPCActn, type PCActn, type PlanNode,
} from '@atlasauth/pca';

export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

export function setup(opts: { extraPlan?: boolean } = {}) {
  const principal = generateKeyPair();
  const pPub = encodeKey(principal.publicKey);
  const { grant } = mintGrant({
    principalSecret: principal.secretKey,
    principalPublic: pPub,
    holder: pPub,
    goal: 'tidy sessions',
    envelope: {
      predicates: [{ verb: 'list_sessions', resource: 'session:*' }, { verb: 'rotate_recovery_keys', resource: 'account:me' }],
      caveats: [{ type: 'expires', at: NOW + 3_600_000 }, { type: 'delegation_depth', max: 2 }],
      agent_binding: {},
      risk_policy: DEFAULT_RISK_POLICY,
    },
  });
  const agent = generateKeyPair();
  const aPub = encodeKey(agent.publicKey);
  const task = delegate(grant, aPub, [{ type: 'expires', at: NOW + 600_000 }], principal.secretKey);
  const chain = [grant, task];
  const params = { scope: 'all' };
  const plan: PlanNode[] = [
    { id: 'n1', verb: 'list_sessions', resource: 'session:*', params_digest: hashCanonical({}), reversibility_class: 'reversible' },
    { id: 'n2', verb: 'rotate_recovery_keys', resource: 'account:me', params_digest: hashCanonical(params), reversibility_class: 'irreversible' },
  ];
  const committed = commitPlan(plan);
  const mk = (n: PlanNode, o: { counter?: number; tweak?: (a: PCActn['action']) => void } = {}): PCActn => {
    const action = { verb: n.verb, resource: n.resource, params_digest: n.params_digest!, reversibility_class: n.reversibility_class! };
    o.tweak?.(action);
    return signPCActn(
      {
        ver: PCACTN_VERSION,
        action,
        grant_ref: grant.id,
        cap_chain: chain,
        plan: { root: committed.root, inclusion_proof: committed.proofFor(n.id), node_id: n.id, conditions_digest: conditionsDigest(n.pre, n.post) },
        attestation: { quote_digest: '', epoch: 0, model_id: 'm', measurement: '', operator: 'o' },
        provenance: { causal_hash: '', taint_level: 0, trusted_refs: [] },
        freshness: { beacon_ref: '', epoch: 0, accumulator_witness: '' },
        counter: o.counter ?? 1,
        risk_claim: { r: 0, inputs: {} },
      },
      agent.secretKey,
    );
  };
  const lowRisk = { reversibility: 1, blastRadius: 0, confidence: 1, semanticDistance: 0 };
  return { grant, plan, mk, lowRisk, params, aPub };
}
