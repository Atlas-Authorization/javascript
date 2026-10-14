import {
  type Capability,
  type CapabilityChain,
  type Caveat,
  type InclusionProof,
  type PCActn,
  type PlanNode,
  assembleThreshold,
  buildPCActn,
  commitPlan as commitPlanLocal,
  delegate as delegateCap,
  signShare,
  thresholdMessage,
  verifyLedgerInclusion,
} from '@atlasauth/pca';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TrustBudget {
  B: number;
  tau: number;
  asOf: number;
}

export interface Verdict {
  allow: boolean;
  checks?: Record<string, string>;
  reason?: string;
  budget?: TrustBudget;
  [k: string]: unknown;
}

export interface Receipt {
  grant_ref?: string;
  index: number;
  commit: string;
  root: string;
  size?: number;
  inclusion_proof: InclusionProof;
}

export type StepUpOutcome =
  | { status: 'approved'; pcactn?: PCActn; [k: string]: unknown }
  | { status: 'denied'; [k: string]: unknown }
  | { status: 'expired'; [k: string]: unknown }
  | { status: 'timeout' };

export type ActResult =
  | { status: 'allowed'; verdict: Verdict; receipt: Receipt; pcactn: PCActn }
  | { status: 'denied'; verdict: Verdict; httpStatus: number; pcactn: PCActn }
  | { status: 'step_up'; stepupId: string; requiredT: number; pcactn: PCActn }
  | { status: 'error'; error: PcaAgentError };

export class PcaAgentError extends Error {
  constructor(
    public readonly code: 'no_plan' | 'unknown_node' | 'no_secret' | 'network' | 'bad_response' | 'build_failed',
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PcaAgentError';
  }
}

export interface CreateAgentOptions {
  grant: Capability;
  /** Capability chain starting at the grant; defaults to `[grant]`. */
  chain?: CapabilityChain;
  /** Ed25519 secret key (32 bytes) of the leaf holder. Omit only for a sub-agent client you do not drive. */
  agentSecret?: Uint8Array;
  /** b64u public key of the agent (informational). */
  agentPublic?: string;
  rsBaseUrl: string;
  fetch?: FetchLike;
  /** Initial counter (last used); the first act() uses counter+1. Default 0. */
  counter?: number;
  budget?: TrustBudget;
}

export interface AgentClient {
  readonly grant: Capability;
  readonly chain: CapabilityChain;
  readonly agentPublic?: string;
  readonly counter: number;
  readonly budget: TrustBudget | undefined;
  readonly planRoot: string | undefined;
  commitPlan(nodes: PlanNode[]): Promise<{ planRoot: string }>;
  act(nodeId: string, params?: Record<string, unknown>): Promise<ActResult>;
  awaitStepUp(stepupId: string, opts?: { pollMs?: number; timeoutMs?: number }): Promise<StepUpOutcome>;
  delegate(opts: { toPublic: string; addedCaveats?: Caveat[]; agentSecret?: Uint8Array }): AgentClient;
  verifyReceipt(receipt: Receipt): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAgent(opts: CreateAgentOptions): AgentClient {
  const base = opts.rsBaseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => (globalThis as unknown as { fetch: FetchLike }).fetch(u, i));
  const chain = opts.chain ?? [opts.grant];
  let counter = opts.counter ?? 0;
  let budget = opts.budget;
  let plan: PlanNode[] | undefined;
  let planRoot: string | undefined;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = ((await res.json()) ?? {}) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json };
  };

  const client: AgentClient = {
    grant: opts.grant,
    chain,
    agentPublic: opts.agentPublic,
    get counter() {
      return counter;
    },
    get budget() {
      return budget;
    },
    get planRoot() {
      return planRoot;
    },

    async commitPlan(nodes) {
      const local = commitPlanLocal(nodes).root;
      const res = await call('POST', '/v1/pca/plans', { grant_ref: opts.grant.id, nodes });
      if (res.status < 200 || res.status >= 300) {
        throw new PcaAgentError('bad_response', `plan commit failed (${res.status})`, res.status);
      }
      const remote = res.json.plan_root;
      if (typeof remote === 'string' && remote !== local) {
        throw new PcaAgentError('bad_response', 'server plan_root differs from the locally computed root', res.status);
      }
      plan = nodes;
      planRoot = local;
      return { planRoot: local };
    },

    async act(nodeId, params) {
      if (!plan) return { status: 'error', error: new PcaAgentError('no_plan', 'commitPlan() first') };
      if (!opts.agentSecret) return { status: 'error', error: new PcaAgentError('no_secret', 'no agentSecret for this client') };
      if (!plan.some((n) => n.id === nodeId)) {
        return { status: 'error', error: new PcaAgentError('unknown_node', `unknown plan node ${nodeId}`) };
      }
      const next = counter + 1;
      let pcactn: PCActn;
      try {
        pcactn = buildPCActn({ grant: opts.grant, chain, plan, nodeId, params, counter: next, signerSecret: opts.agentSecret });
        pcactn = {
          ...pcactn,
          threshold: assembleThreshold([signShare('agent', opts.agentSecret, thresholdMessage(pcactn))]),
        };
      } catch (e) {
        return { status: 'error', error: new PcaAgentError('build_failed', (e as Error).message) };
      }
      counter = next; // monotonic: never reuse a counter, even if the call fails
      let res;
      try {
        res = await call('POST', '/v1/pca/actions', { pcactn });
      } catch (e) {
        return { status: 'error', error: new PcaAgentError('network', (e as Error).message) };
      }
      const j = res.json;
      if (res.status === 202 || j.status === 'step_up_required' || j.step_up_required === true) {
        const id = (j.stepup_id ?? j.stepupId ?? j.id) as unknown;
        const t = (j.required_t ?? j.requiredT ?? j.t) as unknown;
        if (typeof id !== 'string') {
          return { status: 'error', error: new PcaAgentError('bad_response', 'step-up response missing stepup_id', res.status) };
        }
        return { status: 'step_up', stepupId: id, requiredT: typeof t === 'number' ? t : 2, pcactn };
      }
      const verdict = (j.verdict ?? { allow: j.allow === true }) as Verdict;
      if (verdict.budget) budget = verdict.budget;
      if (res.status >= 200 && res.status < 300 && (j.allow === true || verdict.allow)) {
        const receipt = j.receipt as Receipt | undefined;
        if (!receipt) return { status: 'error', error: new PcaAgentError('bad_response', 'allow without receipt', res.status) };
        return { status: 'allowed', verdict, receipt, pcactn };
      }
      return { status: 'denied', verdict, httpStatus: res.status, pcactn };
    },

    async awaitStepUp(stepupId, o = {}) {
      const pollMs = o.pollMs ?? 1000;
      const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
      for (;;) {
        const res = await call('GET', `/v1/pca/stepups/${encodeURIComponent(stepupId)}`);
        const s = res.json.status;
        if (s === 'approved' || s === 'denied' || s === 'expired') {
          return { ...res.json, status: s } as StepUpOutcome;
        }
        if (Date.now() + pollMs > deadline) return { status: 'timeout' };
        await sleep(pollMs);
      }
    },

    delegate({ toPublic, addedCaveats = [], agentSecret }) {
      if (!opts.agentSecret) throw new PcaAgentError('no_secret', 'cannot delegate without agentSecret');
      const leaf = chain[chain.length - 1]!;
      const child = delegateCap(leaf, toPublic, addedCaveats, opts.agentSecret);
      const sub = createAgent({
        grant: opts.grant,
        chain: [...chain, child],
        agentSecret,
        agentPublic: toPublic,
        rsBaseUrl: base,
        fetch: doFetch,
        counter: 0,
      });
      return sub;
    },

    verifyReceipt(r) {
      try {
        return verifyLedgerInclusion(r.root, r.inclusion_proof, r.commit);
      } catch {
        return false;
      }
    },
  };
  return client;
}
