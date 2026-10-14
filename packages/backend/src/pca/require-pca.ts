import { decodePCActn, type Capability, type PCActn, type TrustBudget, type VerifyHooks } from '@atlasauth/pca';
import { verifyPCActn, type PcaContext, type PcaVerdict } from './verify';

/** Framework-agnostic request shape: anything with headers and (optionally) a parsed/raw body. */
export interface PcaRequestLike {
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null };
  body?: unknown;
}

/** Per-holder replay + budget state. Implement over Redis/DB; the in-memory one is for tests/single node. */
export interface PcaStateStore {
  get(key: string): Promise<{ budget?: TrustBudget; lastCounter?: number } | undefined>;
  put(key: string, state: { budget?: TrustBudget; lastCounter?: number }): Promise<void>;
}

export function memoryPcaStore(): PcaStateStore {
  const m = new Map<string, { budget?: TrustBudget; lastCounter?: number }>();
  return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) };
}

export interface RequirePcaOptions {
  /** Resolve the Root Intent Grant from the PCActn's `grant_ref`. null = unknown grant. */
  resolveGrant: (grantRef: string, pcactn: PCActn) => Promise<Capability | null>;
  hooks?: VerifyHooks;
  extract?: (req: PcaRequestLike) => PCActn | string | null;
  /** Anti-replay counter + budget persistence. Without it counters are not checked (surfaced in checks). */
  budgetStore?: PcaStateStore;
  /** Build verification context (params, plan, risk) per request. */
  context?: (req: PcaRequestLike, pcactn: PCActn) => PcaContext | Promise<PcaContext>;
  now?: () => number;
  /** WWW-Authenticate realm (default "pca"). */
  realm?: string;
}

export type PcaGuardResult =
  | { ok: true; verdict: PcaVerdict; pcactn: PCActn }
  | { ok: false; status: 401 | 403; verdict: PcaVerdict; wwwAuthenticate?: string };

function header(req: PcaRequestLike, name: string): string | undefined {
  const h = req.headers as { get?: (n: string) => string | null } & Record<string, string | string[] | undefined>;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function fromB64u(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b, 'base64').toString('utf8');
}

/** Default extraction: `PCA-Action: <base64url PCActn JSON>` header, else JSON body `{ pcactn }`. */
export function defaultExtract(req: PcaRequestLike): PCActn | string | null {
  const h = header(req, 'pca-action');
  if (h) return fromB64u(h.trim());
  let b = req.body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  const x = (b as { pcactn?: unknown } | null | undefined)?.pcactn;
  if (typeof x === 'string' || (x !== null && typeof x === 'object')) return x as PCActn | string;
  return null;
}

const denyVerdict = (reason: string): PcaVerdict => ({
  allow: false,
  r: 1,
  requiredThreshold: { t: 3, proof: 'strong', optimisticAllowed: false },
  checks: { pcactn: 'fail' },
  reasons: [reason],
});

export function requirePCA(opts: RequirePcaOptions): (req: PcaRequestLike) => Promise<PcaGuardResult> {
  const realm = opts.realm ?? 'pca';
  const challenge = (error?: string) =>
    `PCA realm="${realm}"${error ? `, error="${error}"` : ''}, hint="send PCA-Action: <base64url PCActn> or JSON body {pcactn}"`;
  const unauth = (reason: string, error = 'invalid_request'): PcaGuardResult => ({
    ok: false,
    status: 401,
    verdict: denyVerdict(reason),
    wwwAuthenticate: challenge(error),
  });

  return async (req) => {
    try {
      let raw: PCActn | string | null;
      try {
        raw = (opts.extract ?? defaultExtract)(req);
      } catch (e) {
        return unauth(`unreadable PCActn: ${(e as Error).message}`);
      }
      if (raw === null || raw === undefined) return unauth('no PCActn presented', 'missing_pcactn');
      let p: PCActn;
      try {
        p = typeof raw === 'string' ? decodePCActn(raw) : raw;
      } catch (e) {
        return unauth(`undecodable PCActn: ${(e as Error).message}`, 'invalid_pcactn');
      }
      if (p === null || typeof p !== 'object' || typeof p.grant_ref !== 'string') {
        return unauth('malformed PCActn', 'invalid_pcactn');
      }
      const grant = await opts.resolveGrant(p.grant_ref, p);
      if (!grant) return unauth('unknown grant_ref', 'unknown_grant');

      const now = opts.now?.() ?? Date.now();
      const leafHolder = p.cap_chain?.[p.cap_chain.length - 1]?.holder;
      const key = `${grant.id}:${leafHolder ?? ''}`;
      const state = opts.budgetStore && leafHolder ? await opts.budgetStore.get(key) : undefined;
      const ctx: PcaContext = { ...(await opts.context?.(req, p)) };
      if (state?.budget && ctx.budget === undefined) ctx.budget = state.budget;

      const verdict = await verifyPCActn(p, { grant, hooks: opts.hooks, now, context: ctx });

      // Anti-replay (Appendix A step 5): strictly increasing per holder.
      if (opts.budgetStore) {
        if (state?.lastCounter !== undefined && !(p.counter > state.lastCounter)) {
          verdict.allow = false;
          verdict.checks.counter = 'fail';
          verdict.reasons.push(`counter: ${String(p.counter)} is not greater than last seen ${state.lastCounter} (replay)`);
        } else if (verdict.checks.counter === 'pass') {
          verdict.checks.counter = 'pass';
        }
      } else if (verdict.checks.counter === 'pass') {
        verdict.checks.counter = 'not-enforced';
      }

      if (!verdict.allow) {
        // A bad signature / chain is an authentication failure; policy denial is authorization.
        const authnFailed = ['version', 'cap_chain', 'leaf_signature', 'malformed', 'grant_ref'].some(
          (c) => verdict.checks[c] === 'fail',
        );
        return authnFailed
          ? { ok: false, status: 401, verdict, wwwAuthenticate: challenge('invalid_pcactn') }
          : { ok: false, status: 403, verdict };
      }
      if (opts.budgetStore && leafHolder) {
        await opts.budgetStore.put(key, { budget: verdict.budget ?? state?.budget, lastCounter: p.counter });
      }
      return { ok: true, verdict, pcactn: p };
    } catch (e) {
      return { ok: false, status: 403, verdict: denyVerdict(`guard error (fail closed): ${e instanceof Error ? e.message : 'unknown'}`) };
    }
  };
}
