/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import { decodeJwt, globMatch, SUPPORTED_ALGS, verifyJws } from '../jws';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { enforceTokenBinding, issueMachineToken, provedBindingOf } from './device';
import { engineState } from './support';
import { need } from './util';

/**
 * Workload identity federation for machines: trust policies (`/v1/machine_trust_policies`) and the public exchange
 * `POST /v1/machines/federate`. A GitHub Actions, Kubernetes, Google Cloud or generic OIDC token is verified against the
 * issuer's keys (inline `jwks`, `jwks_uri`, or discovery through the engine's `fetch` option), its issuer, audience,
 * expiry (24 h token age cap), subject pattern and claim conditions are checked, and a short machine token comes back.
 * An AWS proof is a presigned STS GetCallerIdentity request, validated strictly (STS host, https, path, exact body,
 * header whitelist, audience signed as `x-atlas-audience`); the engine never contacts AWS itself: the identity comes from
 * the `fetch` option, which a test points at a fake STS. Every refusal is the same 403.
 */
const KINDS = ['github_actions', 'kubernetes', 'aws', 'gcp', 'oidc'] as const;
const DEFAULT_ISSUERS: Record<string, string> = { github_actions: 'https://token.actions.githubusercontent.com', gcp: 'https://accounts.google.com' };
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_PER_MACHINE = 20;
const MAX_TOKEN_AGE_S = 24 * 3600;
const SKEW_S = 30;
const STS_HOST = /^sts(\.[a-z0-9-]{4,30})?\.amazonaws\.com(\.cn)?$/;
const GET_CALLER_BODY = 'Action=GetCallerIdentity&Version=2011-06-15';
const AWS_HEADERS = new Set(['authorization', 'host', 'content-type', 'content-length', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256', 'x-atlas-audience', 'user-agent']);

const st = engineState((e: Engine) => ({ policies: new Table('machine_trust_policies', e.clock.now, 'mtp'), spentAws: new Set<string>() }));

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const issuerOf = (p: Obj): string | null => p.issuer ?? DEFAULT_ISSUERS[p.kind] ?? null;

function subjectPatternProblem(kind: string, pattern: string): string | null {
  if (!pattern || pattern.length > 512) return 'subject_pattern is 1 to 512 characters.';
  if (/^[*?]+$/.test(pattern)) return 'subject_pattern cannot be only wildcards: name who is trusted.';
  if (kind === 'github_actions' && !/^repo:[A-Za-z0-9_.-]+\/[^*?]*/.test(pattern)) return 'For github_actions the pattern must name the owner, for example repo:my-org/my-repo:ref:refs/heads/main (wildcards allowed after the owner).';
  if (kind === 'aws' && !/^arn:aws[a-z-]*:(iam|sts)::\d{12}:/.test(pattern)) return 'For aws the pattern must start with the account, for example arn:aws:iam::123456789012:role/deployer.';
  if (kind === 'kubernetes' && !/^system:serviceaccount:[^*?:]+:/.test(pattern)) return 'For kubernetes the pattern must name the namespace, for example system:serviceaccount:prod:deployer.';
  return null;
}

function httpsUrl(raw: unknown, param: string): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw bad(`${param} must be an https URL.`, param);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad(`${param} must be an https URL.`, param);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw bad(`${param} must be an https URL without credentials, query or fragment.`, param);
  return raw;
}

function conditionsOf(raw: unknown): Obj[] {
  if (!Array.isArray(raw) || raw.length > 20) throw bad('claim_conditions is a list of at most 20 conditions.', 'claim_conditions');
  return raw.map((c, i) => {
    const at = `claim_conditions[${i}]`;
    if (!isObj(c)) throw bad('Each condition is an object with claim, op and value.', at);
    if (Object.keys(c).some((k) => !['claim', 'op', 'value'].includes(k))) throw bad('A condition takes claim, op and value.', at);
    if (typeof c.claim !== 'string' || !c.claim || c.claim.length > 128) throw bad('claim is a claim name of 1 to 128 characters.', `${at}.claim`);
    if (!['equals', 'in', 'glob', 'exists'].includes(c.op)) throw bad('op is equals, in, glob or exists.', `${at}.op`);
    if (c.op === 'exists') {
      if (c.value !== undefined) throw bad('exists takes no value.', `${at}.value`);
      return { claim: c.claim, op: 'exists' };
    }
    const values = typeof c.value === 'string' ? [c.value] : Array.isArray(c.value) ? c.value : null;
    if (!values || !values.length || values.length > 20 || values.some((v: unknown) => typeof v !== 'string' || !v || v.length > 256)) throw bad('value is a string, or a list of up to 20 strings of at most 256 characters.', `${at}.value`);
    if (c.op === 'glob' && values.some((v: string) => /^[*?]+$/.test(v))) throw bad('A glob cannot be only wildcards.', `${at}.value`);
    return { claim: c.claim, op: c.op, value: c.value };
  });
}

function jwksOf(raw: unknown): Obj {
  const keys = isObj(raw) ? raw.keys : undefined;
  if (!Array.isArray(keys) || !keys.length || keys.length > 20) throw bad('jwks is { keys: [...] } with 1 to 20 public keys.', 'jwks');
  for (const k of keys) if (!isObj(k) || typeof k.kty !== 'string' || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'].some((x) => x in k)) throw bad('Every key in jwks must be a public JWK (no private parameters).', 'jwks');
  return { keys };
}

function normalize(b: Obj, existing?: Obj): Obj {
  const kind = b.kind ?? existing?.kind;
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}.`, 'kind');
  if (existing && kind !== existing.kind) throw bad('kind cannot change. Create a new policy.', 'kind');
  const name = b.name ?? existing?.name;
  if (typeof name !== 'string' || !SLUG.test(name)) throw bad('name is 1-64 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.', 'name');
  const audience = b.audience ?? existing?.audience;
  if (typeof audience !== 'string' || !audience || audience.length > 255) throw bad('audience is 1 to 255 characters.', 'audience');
  if (kind === 'aws' && !/^[\x21-\x7e]{1,128}$/.test(audience)) throw bad('For aws the audience is 1 to 128 printable characters without spaces.', 'audience');
  const subjectPattern = b.subject_pattern ?? existing?.subject_pattern;
  if (typeof subjectPattern !== 'string') throw bad('subject_pattern is required.', 'subject_pattern');
  const problem = subjectPatternProblem(kind, subjectPattern);
  if (problem) throw bad(problem, 'subject_pattern');
  let issuer = b.issuer !== undefined ? (b.issuer === null ? null : httpsUrl(b.issuer, 'issuer')) : (existing?.issuer ?? null);
  const jwksUri = b.jwks_uri !== undefined ? (b.jwks_uri === null ? null : httpsUrl(b.jwks_uri, 'jwks_uri')) : (existing?.jwks_uri ?? null);
  const jwks = b.jwks !== undefined ? (b.jwks === null ? null : jwksOf(b.jwks)) : (existing?.jwks ?? null);
  if (kind === 'aws') {
    if (issuer || jwksUri || jwks) throw bad('An aws policy takes no issuer, jwks_uri or jwks: the signed STS request is the proof.', 'issuer');
  } else {
    if (!issuer && !DEFAULT_ISSUERS[kind]) throw bad(`A ${kind} policy needs an issuer.`, 'issuer');
    if (issuer === DEFAULT_ISSUERS[kind]) issuer = null;
  }
  const maxTtl = b.max_ttl_seconds ?? existing?.max_ttl_seconds ?? 600;
  if (typeof maxTtl !== 'number' || !Number.isInteger(maxTtl) || maxTtl < 60 || maxTtl > 3600) throw bad('max_ttl_seconds is an integer from 60 to 3600.', 'max_ttl_seconds');
  const enabled = b.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') throw bad('enabled must be true or false.', 'enabled');
  return { name, kind, issuer, jwks_uri: jwksUri, jwks, audience, subject_pattern: subjectPattern, claim_conditions: b.claim_conditions !== undefined ? conditionsOf(b.claim_conditions) : (existing?.claim_conditions ?? []), max_ttl_seconds: maxTtl, enabled };
}

const present = (p: Obj): Obj => ({
  object: 'machine_trust_policy',
  id: p.id,
  machine_id: p.machine_id,
  name: p.name,
  kind: p.kind,
  issuer: issuerOf(p),
  jwks_uri: p.jwks_uri ?? null,
  jwks: p.jwks ?? null,
  audience: p.audience,
  subject_pattern: p.subject_pattern,
  claim_conditions: p.claim_conditions,
  max_ttl_seconds: p.max_ttl_seconds,
  enabled: p.enabled,
  last_used_at: p.last_used_at ?? null,
  created_at: p.created_at,
  updated_at: p.updated_at,
});

const claimString = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).map(String);

/** A dotted claim path; `kubernetes.io.namespace` reads `claims['kubernetes.io'].namespace` when the whole key is absent. */
function claimAt(claims: Obj, path: string): unknown {
  if (path in claims) return claims[path];
  let cur: any = claims;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    let matched = false;
    for (let j = parts.length; j > i; j--) {
      const key = parts.slice(i, j).join('.');
      if (key in cur) {
        cur = cur[key];
        i = j - 1;
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  return cur;
}

const conditionsPass = (conditions: Obj[], claims: Obj): boolean =>
  conditions.every((c) => {
    const got = claimAt(claims, c.claim);
    if (c.op === 'exists') return got !== undefined && got !== null;
    const have = got === undefined || got === null ? [] : claimString(got);
    const want = c.value === undefined ? [] : claimString(c.value);
    if (!have.length || !want.length) return false;
    if (c.op === 'equals') return have.some((h) => want.includes(h));
    if (c.op === 'in') return have.every((h) => want.includes(h));
    return have.some((h) => want.some((w) => globMatch(w, h)));
  });

type Verdict = { ok: true; subject: string; claims: Obj; fingerprint?: string } | { ok: false; reason: string };
const deny = (reason: string): Verdict => ({ ok: false, reason });
const judge = (p: Obj, subject: string, claims: Obj): Verdict => (!globMatch(p.subject_pattern, subject) ? deny('subject_mismatch') : !conditionsPass(p.claim_conditions, claims) ? deny('claim_condition_failed') : { ok: true, subject, claims });

async function issuerKeys(e: Engine, p: Obj): Promise<Obj[]> {
  if (p.jwks?.keys?.length) return p.jwks.keys;
  const http = e.options.fetch ?? fetch;
  const issuer = issuerOf(p)!;
  let uri: string | null = p.jwks_uri;
  const get = async (url: string): Promise<any> => {
    const res = await http(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  };
  if (!uri) {
    const doc = await get(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
    if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw new Error('issuer mismatch');
    uri = doc.jwks_uri;
  }
  if (typeof uri !== 'string' || !/^https:\/\//i.test(uri)) throw new Error('jwks_uri must be https');
  const set = await get(uri);
  return (Array.isArray(set.keys) ? set.keys : []).filter((k: Obj) => !('d' in k) && !('k' in k));
}

async function verifyOidc(e: Engine, p: Obj, token: string): Promise<Verdict> {
  const issuer = issuerOf(p);
  if (!issuer || p.kind === 'aws') return deny('not_an_oidc_policy');
  const jwt = decodeJwt(token);
  if (!jwt || !SUPPORTED_ALGS.includes(String(jwt.header.alg))) return deny('token_invalid');
  let keys: Obj[];
  try {
    keys = await issuerKeys(e, p);
  } catch {
    return deny('issuer_keys_unavailable');
  }
  const candidates = keys.filter((k) => (jwt.header.kid ? k.kid === jwt.header.kid : true) && (!k.alg || k.alg === jwt.header.alg));
  let verified = false;
  for (const k of candidates) if (await verifyJws(jwt, k)) { verified = true; break; }
  if (!verified) return deny('token_invalid');
  const c = jwt.payload;
  const nowS = e.clock.now() / 1000;
  if (c.iss !== issuer) return deny('token_invalid');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(p.audience)) return deny('token_invalid');
  if (typeof c.exp !== 'number') return deny('no_expiry');
  if (c.exp + SKEW_S <= nowS) return deny('token_invalid');
  if (typeof c.nbf === 'number' && c.nbf - SKEW_S > nowS) return deny('token_invalid');
  if (typeof c.iat === 'number' && c.exp - c.iat > MAX_TOKEN_AGE_S) return deny('token_too_long_lived');
  if (typeof c.sub !== 'string' || !c.sub) return deny('no_subject');
  return judge(p, c.sub, c);
}

function checkAws(proof: Obj, audience: string): { ok: true; url: string; headers: Record<string, string>; fingerprint: string } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (proof.method !== undefined && String(proof.method).toUpperCase() !== 'POST') return fail('aws_method');
  if (typeof proof.url !== 'string') return fail('aws_url');
  let url: URL;
  try {
    url = new URL(proof.url);
  } catch {
    return fail('aws_url');
  }
  if (url.protocol !== 'https:' || !STS_HOST.test(url.hostname) || url.port || url.pathname !== '/' || url.search || url.username || url.password) return fail('aws_url');
  if (proof.body !== GET_CALLER_BODY) return fail('aws_body');
  if (!isObj(proof.headers)) return fail('aws_headers');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(proof.headers)) {
    const name = k.toLowerCase();
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value !== 'string' || !AWS_HEADERS.has(name) || value.length > 4096) return fail('aws_headers');
    headers[name] = value;
  }
  if (!headers.authorization || !headers['x-amz-date']) return fail('aws_headers');
  if (headers.host && headers.host !== url.host) return fail('aws_headers');
  if (headers['x-atlas-audience'] !== audience) return fail('aws_audience');
  const signed = /SignedHeaders=([^,\s]+)/.exec(headers.authorization)?.[1]?.split(';') ?? [];
  if (!signed.includes('x-atlas-audience')) return fail('aws_audience_unsigned');
  return { ok: true, url: url.toString(), headers, fingerprint: `${headers.authorization}\n${headers['x-amz-date']}` };
}

async function verifyAws(e: Engine, p: Obj, proof: Obj): Promise<Verdict> {
  if (p.kind !== 'aws') return deny('not_an_aws_policy');
  const checked = checkAws(proof, p.audience);
  if (!checked.ok) return deny(checked.reason);
  if (st(e).spentAws.has(checked.fingerprint)) return deny('aws_replayed');
  let xml: string;
  try {
    const res = await (e.options.fetch ?? (() => Promise.reject(new Error('no fetch'))))(checked.url, { method: 'POST', headers: checked.headers, body: GET_CALLER_BODY });
    if (!res.ok) return { ...deny('aws_rejected') };
    xml = await res.text();
  } catch {
    return deny('aws_unavailable');
  }
  const field = (tag: string) => new RegExp(`<${tag}>([^<]{1,2048})</${tag}>`).exec(xml)?.[1];
  const arn = field('Arn');
  const account = field('Account');
  if (!arn || !account || !/^\d{12}$/.test(account)) return deny('aws_response');
  // An assumed-role ARN is the role it assumes; other ARNs are their own identity.
  const m = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  const subject = m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : arn;
  const verdict = judge(p, subject, { arn, account, ...(field('UserId') ? { user_id: field('UserId') } : {}), ...(m ? { session_name: m[4] } : {}), sub: subject });
  return verdict.ok ? { ...verdict, fingerprint: checked.fingerprint } : verdict;
}

/** First enabled policy that accepts the subject proof; every refusal reason is kept for the dry run. */
async function match(e: Engine, policies: Obj[], input: { token?: string; aws?: Obj }, policyId?: string): Promise<{ policy: Obj; verdict: Extract<Verdict, { ok: true }> } | { reasons: string[] }> {
  const reasons: string[] = [];
  const pool = policies.filter((p) => p.enabled && (!policyId || p.id === policyId));
  if (!pool.length) return { reasons: ['no_matching_policy'] };
  for (const p of pool) {
    let v: Verdict;
    if (input.token !== undefined) {
      const iss = decodeJwt(input.token)?.payload.iss;
      if (typeof iss !== 'string' || (p.kind === 'aws') || (issuerOf(p) ?? '').replace(/\/+$/, '') !== iss.replace(/\/+$/, '')) {
        reasons.push('issuer_mismatch');
        continue;
      }
      v = await verifyOidc(e, p, input.token);
    } else v = await verifyAws(e, p, input.aws!);
    if (v.ok) return { policy: p, verdict: v };
    reasons.push(v.reason);
  }
  return { reasons };
}

const policyOf = (e: Engine, id: string | undefined): Obj => {
  const p = st(e).policies.get(id);
  if (!p) throw notFound('Trust policy');
  return p;
};

export function federationHandlers(): RouteDef[] {
  const machineOf = (e: Engine, id: unknown): Obj => {
    const m = e.db.machines.get(String(id ?? ''));
    if (!m || m.deleted) throw new EmulatorError('NOT_FOUND', 'machine_id is not a machine.', 'machine_id');
    return m;
  };
  return [
    {
      method: 'GET',
      pattern: '/v1/machine_trust_policies',
      scope: 'machines:read',
      handler: (c) => {
        const mid = c.query.get('machine_id');
        return { body: { object: 'list', data: st(c.engine).policies.filter((p) => !mid || p.machine_id === mid).map(present), has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machine_trust_policies',
      scope: 'machines:write',
      handler: (c) => {
        const e = c.engine;
        const m = machineOf(e, need(c.body, 'machine_id'));
        const fields = normalize(c.body);
        const s = st(e);
        if (s.policies.filter((p) => p.machine_id === m.id).length >= MAX_PER_MACHINE) throw new EmulatorError('CONFLICT', `A machine has at most ${MAX_PER_MACHINE} trust policies.`);
        if (s.policies.find((p) => p.machine_id === m.id && p.name === fields.name)) throw new EmulatorError('CONFLICT', `This machine already has a trust policy named "${fields.name}".`, 'name');
        const now = e.clock.now();
        const row = s.policies.insert({ machine_id: m.id, ...fields, last_used_at: null, created_at: now, updated_at: now });
        return { status: 201, body: present(row) };
      },
    },
    { method: 'GET', pattern: '/v1/machine_trust_policies/:id', scope: 'machines:read', handler: (c) => ({ body: present(policyOf(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/machine_trust_policies/:id',
      scope: 'machines:write',
      handler: (c) => {
        const e = c.engine;
        const p = policyOf(e, c.params.id);
        const fields = normalize(c.body, p);
        if (fields.name !== p.name && st(e).policies.find((x) => x.machine_id === p.machine_id && x.name === fields.name)) throw new EmulatorError('CONFLICT', `This machine already has a trust policy named "${fields.name}".`, 'name');
        Object.assign(p, fields, { updated_at: e.clock.now() });
        return { body: present(p) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/machine_trust_policies/:id',
      scope: 'machines:write',
      handler: (c) => {
        const p = policyOf(c.engine, c.params.id);
        st(c.engine).policies.delete(p.id);
        return { body: { object: 'machine_trust_policy', id: p.id, deleted: true } };
      },
    },
    {
      // A dry run: would this proof be accepted by this policy (even disabled)? Mints and spends nothing.
      method: 'POST',
      pattern: '/v1/machine_trust_policies/:id/test',
      scope: 'machines:read',
      handler: async (c) => {
        const p = policyOf(c.engine, c.params.id);
        if ((c.body.token === undefined) === (c.body.aws === undefined)) throw bad('Send token (OIDC kinds) or aws (aws kind), not both and not neither.', 'token');
        if (c.body.token !== undefined && typeof c.body.token !== 'string') throw bad('token must be a string.', 'token');
        if (c.body.aws !== undefined && !isObj(c.body.aws)) throw bad('aws must be an object.', 'aws');
        const found = await match(c.engine, [{ ...p, enabled: true }], { token: c.body.token, aws: c.body.aws }, p.id);
        return 'verdict' in found
          ? { body: { object: 'machine_trust_policy_test', accepted: true, subject: found.verdict.subject, claims: found.verdict.claims, reasons: [] } }
          : { body: { object: 'machine_trust_policy_test', accepted: false, subject: null, claims: null, reasons: [...new Set(found.reasons)] } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/machines/federate',
      public: true,
      handler: (c) => federate(c),
    },
  ];
}

async function federate(c: RouteContext): Promise<{ body: Obj }> {
  const e = c.engine;
  const b = c.body;
  const machineId = typeof b.machine_id === 'string' ? b.machine_id.trim() : '';
  if (!machineId) throw bad('A `machine_id` is required.', 'machine_id');
  if ((b.token === undefined) === (b.aws === undefined)) throw bad('Send `token` (a GitHub Actions, Kubernetes, GCP or OIDC token) or `aws` (a signed GetCallerIdentity request), not both and not neither.', 'token');
  if (b.token !== undefined && (typeof b.token !== 'string' || !b.token || b.token.length > 16_384)) throw bad('`token` must be a JWT string.', 'token');
  if (b.aws !== undefined && !isObj(b.aws)) throw bad('`aws` must be an object.', 'aws');
  if (b.policy_id !== undefined && typeof b.policy_id !== 'string') throw bad('`policy_id` must be a trust policy id.', 'policy_id');
  // The same answer as a refused token: a caller learns nothing about which machines exist.
  const refused = () => new EmulatorError('FORBIDDEN', 'No trust policy of this machine accepts that token.');
  const m = e.db.machines.get(machineId);
  if (!m || m.deleted || m.status !== 'active') throw refused();
  const proved = await provedBindingOf(c);
  enforceTokenBinding(m, proved);
  const found = await match(e, st(e).policies.filter((p) => p.machine_id === m.id), { token: b.token, aws: b.aws }, b.policy_id);
  if (!('verdict' in found)) throw refused();
  const { policy, verdict } = found;
  const issued = await issueMachineToken(c, m, b, {
    proved,
    maxTtlSeconds: policy.max_ttl_seconds,
    extraClaims: { fed: { kind: policy.kind, policy_id: policy.id, sub: verdict.subject } },
    // The signed AWS request is spent only once the token is certain to be issued.
    beforeIssue: () => {
      if (verdict.fingerprint) st(e).spentAws.add(verdict.fingerprint);
    },
  });
  policy.last_used_at = e.clock.now();
  return issued;
}
