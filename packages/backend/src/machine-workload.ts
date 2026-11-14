import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDpopProof } from './machine-dpop';

/**
 * Workload identity federation, the workload side: get the token your platform issues to this
 * process (GitHub Actions, Kubernetes, GCP, AWS) and trade it for a short Atlas machine token,
 * with no stored secret. The machine needs a trust policy that accepts the platform's token.
 * Node only.
 */

export class WorkloadFederationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkloadFederationError';
  }
}

export interface FederatedMachineToken {
  token: string;
  tokenType: 'Bearer' | 'DPoP';
  /** Epoch ms. */
  expiresAt: number;
  audience?: string;
  scope?: string;
  constraints?: Record<string, unknown>;
}

export interface FederateOptions {
  /** Your instance's issuer URL (for example `https://clerk.example.com`). */
  issuer: string;
  /** The machine the trust policy belongs to. */
  machineId: string;
  /** The platform token (github_actions, kubernetes, gcp, oidc). Send this or `aws`. */
  token?: string;
  /** The signed AWS request from {@link awsIdentityProof}. */
  aws?: AwsIdentityProof;
  /** Try only this trust policy. */
  policyId?: string;
  /** The API to bind the token to (a resource server identifier), and scopes within the machine's grant. */
  audience?: string;
  scopes?: string[];
  scopePresets?: string[];
  organizationId?: string;
  /** Bind the token to this DPoP key (PKCS#8 PEM). Required when the machine's token_binding is dpop. */
  dpopPrivateKeyPem?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Exchange a platform token for a machine token. */
export async function federateMachineToken(opts: FederateOptions): Promise<FederatedMachineToken> {
  if ((opts.token === undefined) === (opts.aws === undefined)) throw new Error('Pass `token` or `aws`, not both and not neither.');
  const issuer = opts.issuer.replace(/\/+$/, '');
  const url = `${issuer}/v1/machines/federate`;
  const f = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const res = await f(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.dpopPrivateKeyPem ? { dpop: createDpopProof({ privateKeyPem: opts.dpopPrivateKeyPem, method: 'POST', url, now }) } : {}),
    },
    body: JSON.stringify({
      machine_id: opts.machineId,
      ...(opts.token !== undefined ? { token: opts.token } : { aws: opts.aws }),
      ...(opts.policyId ? { policy_id: opts.policyId } : {}),
      ...(opts.audience ? { audience: opts.audience } : {}),
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
      ...(opts.scopePresets ? { scope_presets: opts.scopePresets } : {}),
      ...(opts.organizationId ? { organization_id: opts.organizationId } : {}),
    }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // fall through to the status
  }
  if (!res.ok) {
    const first = (Array.isArray(json.errors) ? json.errors[0] : undefined) as { message?: string } | undefined;
    throw new WorkloadFederationError(res.status, first?.message ?? (typeof json.message === 'string' ? json.message : `Federation failed with status ${res.status}.`));
  }
  return {
    token: json.token as string,
    tokenType: json.token_type === 'DPoP' ? 'DPoP' : 'Bearer',
    expiresAt: now() + (json.expires_in as number) * 1000,
    audience: json.audience as string | undefined,
    scope: json.scope as string | undefined,
    constraints: json.constraints as Record<string, unknown> | undefined,
  };
}

/** A GitHub Actions OIDC token for `audience`. The job needs `permissions: id-token: write`. */
export async function githubActionsToken(audience: string, opts: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !bearer) throw new Error('No GitHub Actions OIDC token is available. Give the job `permissions: id-token: write`.');
  const res = await (opts.fetch ?? globalThis.fetch)(`${base}${base.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub did not issue a token (status ${res.status}).`);
  const json = (await res.json()) as { value?: string };
  if (!json.value) throw new Error('GitHub returned no token.');
  return json.value;
}

/** The projected service account token of a Kubernetes pod. Its audience is what the pod spec projected. */
export async function kubernetesServiceAccountToken(path = '/var/run/secrets/kubernetes.io/serviceaccount/token'): Promise<string> {
  return (await readFile(path, 'utf8')).trim();
}

/** A Google identity token for `audience` from the metadata server (Compute Engine, GKE, Cloud Run, Functions). */
export async function gcpIdentityToken(audience: string, opts: { fetch?: typeof fetch } = {}): Promise<string> {
  const res = await (opts.fetch ?? globalThis.fetch)(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`,
    { headers: { 'metadata-flavor': 'Google' } },
  );
  if (!res.ok) throw new Error(`The metadata server did not issue a token (status ${res.status}).`);
  return (await res.text()).trim();
}

export interface AwsIdentityProof {
  method: 'POST';
  url: string;
  body: string;
  headers: Record<string, string>;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/**
 * Sign (SigV4, locally, nothing is sent) the STS GetCallerIdentity request that proves which AWS
 * role this process runs as. `audience` is the trust policy's audience: it is signed into the
 * request, so the proof cannot be replayed at another service. Credentials default to the
 * environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), which is how Lambda,
 * ECS and EKS pod identity expose them.
 */
export function awsIdentityProof(opts: {
  audience: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  now?: () => number;
}): AwsIdentityProof {
  const creds =
    opts.credentials ??
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN }
      : null);
  if (!creds) throw new Error('No AWS credentials: pass `credentials` or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  const region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const host = region === 'us-east-1' ? 'sts.amazonaws.com' : `sts.${region}.amazonaws.com`;
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const amzDate = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host,
    'x-amz-date': amzDate,
    'x-atlas-audience': opts.audience,
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256hex(body)}`;
  const scope = `${day}/${region}/sts/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), 'sts'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    method: 'POST',
    url: `https://${host}/`,
    body,
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}
