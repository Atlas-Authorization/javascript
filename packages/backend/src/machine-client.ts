import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDpopProof, dpopThumbprint, generateDpopKey } from './machine-dpop';

export * from './machine-dpop';
export * from './machine-workload';

/**
 * The device side of machine enrolment, for a service or device of your own:
 * generate an Ed25519 key, enrol with a token or a short code, then trade a
 * signed challenge for short-lived machine tokens, cached until shortly before
 * they expire. Node only (it signs with `node:crypto` and keeps its key in a file
 * or your own store); import it from `@atlasauth/backend/machine`.
 */

/** What a machine keeps between runs. The private key never leaves it. */
export interface MachineIdentity {
  issuer: string;
  machine_id: string;
  /** PKCS#8 PEM of the Ed25519 private key. */
  private_key_pem: string;
  /** SPKI PEM of the matching public key (what enrolment registered). */
  public_key_pem: string;
  enrolled_at: number;
}

/** Where the identity lives; pass your own to use a keychain or secret manager. */
export interface MachineStore {
  load(): Promise<MachineIdentity | null> | MachineIdentity | null;
  save(identity: MachineIdentity): Promise<void> | void;
  clear(): Promise<void> | void;
}

/** A store backed by one file, written 0600 in a 0700 directory. */
export function fileMachineStore(path: string): MachineStore {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as MachineIdentity;
      } catch {
        return null;
      }
    },
    async save(identity) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(identity), { mode: 0o600 });
      await rename(tmp, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/** A store that forgets on exit (tests, short-lived jobs that enrol every run). */
export function memoryMachineStore(initial: MachineIdentity | null = null): MachineStore {
  let value = initial;
  return {
    load: () => value,
    save: (i) => {
      value = i;
    },
    clear: () => {
      value = null;
    },
  };
}

/** Atlas refused a request. `code` is the machine-readable error code when the response had one. */
export class MachineClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'MachineClientError';
  }
}

export interface MachineClientOptions {
  /** Your instance's issuer URL: the `iss` of its tokens (for example `https://clerk.example.com`). */
  issuer: string;
  store: MachineStore;
  fetch?: typeof fetch;
  /** Epoch ms. */
  now?: () => number;
  /** Fetch a new token this long before the cached one expires. Default 60 seconds. */
  refreshSkewSeconds?: number;
  /**
   * Bind every token to a DPoP key (RFC 9449): pass the key (PKCS#8 PEM, Ed25519 or P-256), or
   * `true` for a key made in memory for this client. Needed when the machine's token_binding is
   * `dpop`. Send `dpopProof()` with each call to your API.
   */
  dpopKey?: string | true;
}

export interface MachineEnrolOptions {
  /** A `met_` enrolment token, or a short user code (`XXXX-XXXX`). */
  credential: string;
  name: string;
  metadata?: Record<string, unknown>;
  /** A stable device identifier, so re-enrolling replaces this device's earlier machine. */
  deviceKey?: string;
}

export interface MachineTokenRequest {
  /** The resource server (API) the token is for; becomes the token's `aud`. */
  audience?: string;
  /** Scopes within the grant. Needs `audience`. */
  scopes?: string[];
  /** Scope preset names of the resource server. Needs `audience`. */
  scopePresets?: string[];
  /** The organization context; defaults to the machine's own organization. */
  organizationId?: string;
}

export interface MachineToken {
  token: string;
  /** `DPoP` when the token is bound to this client's key: send it as `Authorization: DPoP <token>` with a `dpopProof()`. */
  tokenType: 'Bearer' | 'DPoP';
  /** Epoch ms when the token stops being valid. */
  expiresAt: number;
  audience?: string;
  scope?: string;
  /** The grant's `constraints`, as the token carries them. Your API enforces them. */
  constraints?: Record<string, unknown>;
  organizationId?: string;
}

export interface MachineEnrolResult {
  machineId: string;
  status: string;
  /** True when an administrator must approve the machine before it can get tokens. */
  approvalRequired: boolean;
}

/** `base64url(sign(privateKey, nonce))`: pure Ed25519 over the nonce's UTF-8 bytes. */
export function signMachineChallenge(privateKeyPem: string, nonce: string): string {
  return cryptoSign(null, Buffer.from(nonce, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64url');
}

const cacheKey = (r: MachineTokenRequest): string =>
  JSON.stringify([r.audience ?? '', [...(r.scopes ?? [])].sort(), [...(r.scopePresets ?? [])].sort(), r.organizationId ?? '']);

export function createMachineClient(options: MachineClientOptions) {
  const issuer = options.issuer.replace(/\/+$/, '');
  const f = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const skewMs = (options.refreshSkewSeconds ?? 60) * 1000;
  const cache = new Map<string, MachineToken>();
  const inflight = new Map<string, Promise<MachineToken>>();
  const dpopKey = options.dpopKey === true ? generateDpopKey() : options.dpopKey;

  async function post<T>(path: string, body: Record<string, unknown>, proof = false): Promise<T> {
    const url = `${issuer}${path}`;
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(proof && dpopKey ? { dpop: createDpopProof({ privateKeyPem: dpopKey, method: 'POST', url, now }) } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // a non-JSON error page: fall through to the status
    }
    if (!res.ok) {
      const first = (Array.isArray(json.errors) ? json.errors[0] : undefined) as { code?: string; message?: string } | undefined;
      throw new MachineClientError(res.status, first?.code ?? (typeof json.code === 'string' ? json.code : null), first?.message ?? (typeof json.message === 'string' ? json.message : `Request failed with status ${res.status}.`));
    }
    return json as T;
  }

  /** The stored identity, or null before enrolment (or when it belongs to another issuer). */
  async function identity(): Promise<MachineIdentity | null> {
    const i = await options.store.load();
    return i && i.issuer === issuer ? i : null;
  }

  async function mint(req: MachineTokenRequest): Promise<MachineToken> {
    const id = await identity();
    if (!id) throw new MachineClientError(0, 'not_enrolled', 'This machine is not enrolled. Call enroll() first.');
    const challenge = await post<{ nonce: string }>('/v1/machines/challenge', { machine_id: id.machine_id });
    const res = await post<{ token: string; token_type?: string; expires_in: number; audience?: string; scope?: string; constraints?: Record<string, unknown>; organization_id?: string }>('/v1/machines/token', {
      machine_id: id.machine_id,
      nonce: challenge.nonce,
      signature: signMachineChallenge(id.private_key_pem, challenge.nonce),
      ...(req.audience ? { audience: req.audience } : {}),
      ...(req.scopes ? { scopes: req.scopes } : {}),
      ...(req.scopePresets ? { scope_presets: req.scopePresets } : {}),
      ...(req.organizationId ? { organization_id: req.organizationId } : {}),
    }, true);
    return { token: res.token, tokenType: res.token_type === 'DPoP' ? 'DPoP' : 'Bearer', expiresAt: now() + res.expires_in * 1000, audience: res.audience, scope: res.scope, constraints: res.constraints, organizationId: res.organization_id };
  }

  return {
    /**
     * Generate a key, enrol with a token or short code, and store the identity.
     * The private key is created here and only its public half is sent.
     */
    async enroll(opts: MachineEnrolOptions): Promise<MachineEnrolResult> {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const res = await post<{ id: string; status: string; approval_required: boolean; enrolled_at: number | null }>('/v1/machines/enroll', {
        enrolment_token: opts.credential.trim(),
        name: opts.name,
        public_key_pem: publicPem,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
        ...(opts.deviceKey ? { device_key: opts.deviceKey } : {}),
      });
      await options.store.save({ issuer, machine_id: res.id, private_key_pem: privatePem, public_key_pem: publicPem, enrolled_at: res.enrolled_at ?? now() });
      cache.clear();
      return { machineId: res.id, status: res.status, approvalRequired: res.approval_required };
    },

    async isEnrolled(): Promise<boolean> {
      return (await identity()) !== null;
    },

    async machineId(): Promise<string | null> {
      return (await identity())?.machine_id ?? null;
    },

    /**
     * A machine token for this request, from the cache while it has more than the
     * refresh skew left. Concurrent callers asking for the same thing share one mint.
     */
    async getToken(req: MachineTokenRequest = {}): Promise<MachineToken> {
      const key = cacheKey(req);
      const hit = cache.get(key);
      if (hit && hit.expiresAt - skewMs > now()) return hit;
      const pending = inflight.get(key);
      if (pending) return pending;
      const run = mint(req)
        .then((t) => {
          cache.set(key, t);
          return t;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, run);
      return run;
    },

    /**
     * A DPoP proof for one call to your API with a token this client minted:
     * `Authorization: DPoP <token>` plus `DPoP: <proof>`. Pass `nonce` when the API answered
     * `use_dpop_nonce`. Needs the `dpopKey` option.
     */
    dpopProof(req: { token: string; method: string; url: string; nonce?: string }): string {
      if (!dpopKey) throw new MachineClientError(0, 'dpop_not_configured', 'Create the client with the `dpopKey` option to sign DPoP proofs.');
      return createDpopProof({ privateKeyPem: dpopKey, method: req.method, url: req.url, accessToken: req.token, nonce: req.nonce, now });
    },

    /** The thumbprint (`cnf.jkt`) tokens minted by this client carry, or null without a `dpopKey`. */
    dpopThumbprint(): string | null {
      return dpopKey ? dpopThumbprint(dpopKey) : null;
    },

    /** Forget cached tokens (the stored identity stays). */
    clearTokens(): void {
      cache.clear();
    },

    /** Forget the identity too: the machine must enrol again. */
    async reset(): Promise<void> {
      cache.clear();
      await options.store.clear();
    },
  };
}

/** The public half of a stored identity, as the SPKI the server holds, re-derived from the private key. Useful to check a store was not swapped. */
export function publicKeyPemOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}
