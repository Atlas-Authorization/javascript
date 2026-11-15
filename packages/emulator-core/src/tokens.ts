/* eslint-disable @typescript-eslint/no-explicit-any */
import { AtlasBackend, createTestIssuer, type TestIssuer } from '@atlasauth/backend';
import type { Engine } from './engine';
import type { Obj } from './openapi';
import { randomToken } from './store';
import { decodeJwt, verifyJws } from './jws';
import { decryptJwe, generateEncKey, type OpDecryptAlg, type OpEncKey } from './jwe';
import { recordAudit } from './handlers/emu4-oauth-audit';

/** The issuer used when none is given: a reserved `.invalid` host, so no production verifier can ever be configured with it. */
export const DEFAULT_TEST_ISSUER = 'https://emulator.atlas.invalid';

export interface MintSessionInput {
  userId: string;
  sessionId: string;
  organizationId?: string | null;
  claims?: Obj;
  ttlSeconds?: number;
}

/** The algorithms an instance key may use (the same list the real provider publishes). */
export const SIGNING_ALGS = ['RS256', 'ES256', 'ES384', 'PS256', 'EdDSA'] as const;
export type SigningAlg = (typeof SIGNING_ALGS)[number];
export const isSigningAlg = (v: unknown): v is SigningAlg => (SIGNING_ALGS as readonly string[]).includes(v as string);
/** How long the previous key stays published after a rotation unless the caller says otherwise. */
export const DEFAULT_KEY_GRACE_S = 86_400;

interface KeyRec {
  issuer: TestIssuer;
  alg: SigningAlg;
  /** Epoch ms a staged key starts signing; null once it signs (or when it never was staged). */
  activatesAt: number | null;
  /** How long the key it replaces stays published after activation. */
  graceMs: number;
  /** When a previous key leaves the key set; null for the current and a staged key. */
  retiresAt: number | null;
  /** Who staged it: a request, or the rotation schedule. */
  trigger: string | null;
}

/**
 * Real signed tokens. Keys are generated in memory on first use and never written anywhere, so a token
 * this engine signs can only verify against this engine's own JWKS. Every token also carries
 * `atlas_emulator: true`, and the issuer defaults to a reserved host.
 *
 * The key set follows the real provider: one current key signs, a staged key is published before it signs, a previous
 * key stays published until its grace ends (the engine clock), an emergency rotation publishes only the new key.
 */
export class TokenService {
  private keys: KeyRec[] = [];
  private initializing: Promise<void> | null = null;
  private issuerUrl: string;
  private rotations = 0;
  private enc = new Map<string, OpEncKey>();
  /** Keys for the algorithms the OP signs responses with that differ from the instance key (as the real provider's OP key table). */
  private opKeys = new Map<string, TestIssuer>();

  constructor(private readonly engine: Engine) {
    this.issuerUrl = engine.options.issuer ?? DEFAULT_TEST_ISSUER;
  }

  get issuer(): string {
    return this.issuerUrl;
  }

  /** The HTTP server calls this once it knows its origin. Drops keys made for the old issuer. */
  setIssuer(issuer: string): void {
    if (issuer === this.issuerUrl) return;
    this.issuerUrl = issuer;
    this.reset();
  }

  reset(): void {
    this.keys = [];
    this.initializing = null;
    this.rotations = 0;
    this.enc.clear();
    this.opKeys.clear();
  }

  private async make(alg: SigningAlg): Promise<TestIssuer> {
    const kid = `emu-${this.engine.instanceId}-${++this.rotations}`;
    // The test issuer is typed for RS256 and ES256; its key generation and signing take every algorithm of the list.
    return createTestIssuer({ alg: alg as 'RS256', issuer: this.issuerUrl, kid, now: this.engine.clock.now });
  }

  private async ensure(): Promise<void> {
    this.initializing ??= this.make('RS256').then((i) => void this.keys.push({ issuer: i, alg: 'RS256', activatesAt: null, graceMs: DEFAULT_KEY_GRACE_S * 1000, retiresAt: null, trigger: null }));
    await this.initializing;
  }

  /** Start signing with a staged key that is due, and drop previous keys whose grace has ended. */
  private settle(): void {
    const now = this.engine.clock.now();
    for (const k of this.keys) {
      if (k.activatesAt === null || k.activatesAt > now) continue;
      const prev = this.keys.filter((x) => x !== k && x.activatesAt === null).pop();
      const at = k.activatesAt;
      k.activatesAt = null;
      if (prev && prev.retiresAt === null) prev.retiresAt = at + k.graceMs;
      const data = { object: 'signing_key', kid: k.issuer.kid, alg: k.alg, previous_kid: prev?.issuer.kid ?? null, previous_retires_at: prev?.retiresAt ?? null };
      this.engine.webhooks.emit('signing_key.activated', data);
      recordAudit(this.engine, 'signing_key.activated', 'system', 'instance', this.engine.instanceId, data);
    }
    this.keys = this.keys.filter((k) => k.retiresAt === null || k.retiresAt > now);
  }

  /** The clock-driven transitions, when a key exists already (an engine that never signed is left alone). */
  async settleIfStarted(): Promise<void> {
    if (this.initializing) await this.ready();
  }

  /** Make sure the first key exists and the clock-driven transitions have run; every entry point calls this first. */
  async ready(): Promise<void> {
    await this.ensure();
    this.settle();
  }

  private current(): TestIssuer {
    const cur = this.keys.filter((k) => k.activatesAt === null).pop();
    if (!cur) throw new Error('token service not initialised');
    return cur.issuer;
  }

  private currentRec(): KeyRec {
    return this.keys.filter((k) => k.activatesAt === null).pop()!;
  }

  async jwks(): Promise<{ keys: Obj[] }> {
    await this.ready();
    return { keys: [...this.keys.flatMap((k) => k.issuer.jwks.keys as Obj[]), ...[...this.opKeys.values()].flatMap((i) => i.jwks.keys as Obj[])] };
  }

  /** The published key set a relying party reads: the signing keys, plus the encryption key once a client registered for encrypted request objects. */
  async publishedJwks(): Promise<{ keys: Obj[] }> {
    const sig = await this.jwks();
    return { keys: [...sig.keys, ...[...this.enc.values()].map((k) => k.publicJwk as Obj)] };
  }

  /** Make the key clients encrypt request objects to (and publish it). Idempotent per algorithm. */
  async ensureEncryptionKey(alg: OpDecryptAlg): Promise<Obj> {
    let k = this.enc.get(alg);
    if (!k) this.enc.set(alg, (k = await generateEncKey(alg, `emu-enc-${this.engine.instanceId}-${alg.toLowerCase()}`)));
    return k.publicJwk as Obj;
  }

  /** The plaintext of a JWE addressed to one of this engine's encryption keys (by `kid`, else by `alg`); null when it cannot be decrypted. */
  async decryptEncrypted(jwe: string): Promise<string | null> {
    try {
      const header = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwe.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
      const key = [...this.enc.values()].find((k) => (header.kid ? k.kid === header.kid : k.alg === header.alg));
      return key ? await decryptJwe(jwe, key) : null;
    } catch {
      return null;
    }
  }

  /**
   * Publish a new signing key. Immediately it signs and the old key stays published for `graceSeconds` (default 24 h);
   * `emergency` publishes only the new key; `staged` publishes it now and starts signing at `activatesAt`.
   * The caller checks the real provider's one-key-at-a-time rules (`keyState`).
   */
  async rotate(alg?: SigningAlg, opts: { graceSeconds?: number; emergency?: boolean; staged?: boolean; activatesAt?: number; trigger?: string } = {}): Promise<{ kid: string; alg: SigningAlg; previous_kid: string; previous_retires_at: number | null; emergency: boolean; staged?: true; activates_at?: number }> {
    await this.ready();
    const cur = this.currentRec();
    const now = this.engine.clock.now();
    const next = alg ?? cur.alg;
    const issuer = await this.make(next);
    const rec: KeyRec = { issuer, alg: next, activatesAt: null, graceMs: (opts.graceSeconds ?? DEFAULT_KEY_GRACE_S) * 1000, retiresAt: null, trigger: opts.trigger ?? null };
    if (opts.staged && !opts.emergency) {
      rec.activatesAt = opts.activatesAt ?? now + 14 * 86_400_000;
      rec.graceMs = (opts.graceSeconds ?? DEFAULT_KEY_GRACE_S) * 1000;
      this.keys.push(rec);
      return { kid: issuer.kid, alg: next, previous_kid: cur.issuer.kid, previous_retires_at: rec.activatesAt + rec.graceMs, emergency: false, staged: true, activates_at: rec.activatesAt };
    }
    if (opts.emergency) this.keys = [];
    else cur.retiresAt = now + rec.graceMs;
    this.keys.push(rec);
    this.settle();
    return { kid: issuer.kid, alg: next, previous_kid: cur.issuer.kid, previous_retires_at: opts.emergency ? null : cur.retiresAt, emergency: opts.emergency === true };
  }

  /** The staged key, unpublished; null when none is staged. */
  async cancelStaged(): Promise<string | null> {
    await this.ready();
    const k = this.keys.find((x) => x.activatesAt !== null);
    if (!k) return null;
    this.keys = this.keys.filter((x) => x !== k);
    return k.issuer.kid;
  }

  /** The key set as the rotation rules see it. */
  async keyState(): Promise<{ currentKid: string; alg: SigningAlg; staged: { kid: string; alg: string; activatesAt: number } | null; previousRetiresAt: number | null }> {
    await this.ready();
    const cur = this.currentRec();
    const staged = this.keys.find((k) => k.activatesAt !== null);
    const prev = this.keys.filter((k) => k.retiresAt !== null).map((k) => k.retiresAt as number);
    return { currentKid: cur.issuer.kid, alg: cur.alg, staged: staged ? { kid: staged.issuer.kid, alg: staged.alg, activatesAt: staged.activatesAt! } : null, previousRetiresAt: prev.length ? Math.max(...prev) : null };
  }

  /** The published keys, newest first, with their state. */
  async signingKeys(): Promise<Obj[]> {
    await this.ready();
    const cur = this.currentRec();
    return [...this.keys].reverse().map((k) => ({
      object: 'signing_key',
      kid: k.issuer.kid,
      alg: k.alg,
      status: k === cur ? 'current' : k.activatesAt !== null ? 'next' : 'previous',
      role: 'main',
      retires_at: k.retiresAt,
      ...(k.activatesAt !== null ? { activates_at: k.activatesAt } : {}),
      provider: 'local',
      current: k === cur,
    }));
  }

  async mintSession(input: MintSessionInput): Promise<{ jwt: string; claims: Obj; expiresIn: number }> {
    await this.ready();
    const ttl = input.ttlSeconds ?? 60;
    const nowS = Math.floor(this.engine.clock.now() / 1000);
    const claims: Obj = {
      sub: input.userId,
      sid: input.sessionId,
      iat: nowS,
      exp: nowS + ttl,
      atlas_emulator: true,
      ...(input.organizationId ? { org_id: input.organizationId } : {}),
      ...(input.claims ?? {}),
    };
    return { jwt: await this.current().mintSession(claims as any), claims, expiresIn: ttl };
  }

  /**
   * Sign any claim set with the current key: `iss`, `iat`, `exp` and `atlas_emulator` are filled in, everything else is yours.
   * `idToken` uses the OIDC ID-token minting path (aud, nonce, auth_time stay as given).
   */
  async signClaims(claims: Obj, ttlSeconds = 60): Promise<string> {
    await this.ready();
    const nowS = Math.floor(this.engine.clock.now() / 1000);
    const body: Obj = { iss: this.issuerUrl, iat: nowS, exp: nowS + ttlSeconds, atlas_emulator: true, sid: undefined, azp: undefined, sv: undefined, mfa: undefined, ...claims };
    return this.current().mintSession(body as any);
  }

  /**
   * Sign claims in a chosen algorithm (an authorization response or ID token the client registered an algorithm for).
   * The instance key signs when it already has that algorithm (or none is asked); otherwise a key of that algorithm is
   * made once and published beside it.
   */
  async signClaimsAs(alg: string | null | undefined, claims: Obj, ttlSeconds = 60): Promise<string> {
    await this.ready();
    if (!alg || !isSigningAlg(alg) || alg === this.currentRec().alg) return this.signClaims(claims, ttlSeconds);
    let issuer = this.opKeys.get(alg);
    if (!issuer) this.opKeys.set(alg, (issuer = await this.make(alg)));
    const nowS = Math.floor(this.engine.clock.now() / 1000);
    return issuer.mintSession({ iss: this.issuerUrl, iat: nowS, exp: nowS + ttlSeconds, atlas_emulator: true, sid: undefined, azp: undefined, sv: undefined, mfa: undefined, ...claims } as any);
  }

  /** Verify as a resource server would: against the engine JWKS, issuer and clock. */
  async verify(token: string): Promise<{ ok: true; claims: Obj } | { ok: false; reason: string }> {
    await this.ready();
    const backend = new AtlasBackend({ jwks: await this.jwks(), issuer: this.issuerUrl, now: this.engine.clock.now } as any);
    const r = await backend.verify(token);
    return r.ok ? { ok: true, claims: r.claims as Obj } : { ok: false, reason: r.reason };
  }

  /**
   * Verify any token this engine signed, whatever its `token_use` (session, machine, access, id): signature against
   * the JWKS, issuer, `exp` and `nbf`. `verify` is the session-only check a resource server would run; this one is
   * for the engine's own routes (machine verify, introspection, token exchange).
   */
  async verifyAny(token: string, opts: { ignoreExp?: boolean } = {}): Promise<{ ok: true; claims: Obj } | { ok: false; reason: string }> {
    try {
      const jwt = decodeJwt(token);
      if (!jwt) return { ok: false, reason: 'malformed' };
      const jwk = (await this.jwks()).keys.find((k) => k.kid === jwt.header.kid);
      if (!jwk) return { ok: false, reason: 'unknown_key' };
      // The key fixes the algorithm: a token naming another one never verifies (no algorithm confusion).
      if (!isSigningAlg(jwt.header.alg) || jwk.alg !== jwt.header.alg) return { ok: false, reason: 'unsupported_alg' };
      if (!(await verifyJws(jwt, jwk))) return { ok: false, reason: 'bad_signature' };
      const claims = jwt.payload as Obj;
      const nowS = this.engine.clock.now() / 1000;
      if (claims.iss !== this.issuerUrl) return { ok: false, reason: 'wrong_issuer' };
      if (!opts.ignoreExp && typeof claims.exp === 'number' && claims.exp <= nowS) return { ok: false, reason: 'expired' };
      if (typeof claims.nbf === 'number' && claims.nbf > nowS + 60) return { ok: false, reason: 'not_yet_valid' };
      return { ok: true, claims };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }

  secret(prefix: string): string {
    return `${prefix}_${randomToken(24)}`;
  }
}
