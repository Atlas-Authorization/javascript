/* eslint-disable @typescript-eslint/no-explicit-any */
import { AtlasBackend, createTestIssuer, type TestIssuer } from '@atlasauth/backend';
import type { Engine } from './engine';
import type { Obj } from './openapi';
import { randomToken } from './store';

/** The issuer used when none is given: a reserved `.invalid` host, so no production verifier can ever be configured with it. */
export const DEFAULT_TEST_ISSUER = 'https://emulator.atlas.invalid';

export interface MintSessionInput {
  userId: string;
  sessionId: string;
  organizationId?: string | null;
  claims?: Obj;
  ttlSeconds?: number;
}

/**
 * Real signed tokens. Keys are generated in memory on first use and never written anywhere, so a token
 * this engine signs can only verify against this engine's own JWKS. Every token also carries
 * `atlas_emulator: true`, and the issuer defaults to a reserved host.
 */
export class TokenService {
  private issuers: TestIssuer[] = [];
  private initializing: Promise<void> | null = null;
  private issuerUrl: string;
  private rotations = 0;

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
    this.issuers = [];
    this.initializing = null;
    this.rotations = 0;
  }

  reset(): void {
    this.issuers = [];
    this.initializing = null;
    this.rotations = 0;
  }

  private async make(alg: 'RS256' | 'ES256'): Promise<TestIssuer> {
    const kid = `emu-${this.engine.instanceId}-${++this.rotations}`;
    return createTestIssuer({ alg, issuer: this.issuerUrl, kid, now: this.engine.clock.now });
  }

  private async ensure(): Promise<void> {
    this.initializing ??= this.make('RS256').then((i) => void this.issuers.push(i));
    await this.initializing;
  }

  private current(): TestIssuer {
    const cur = this.issuers[this.issuers.length - 1];
    if (!cur) throw new Error('token service not initialised');
    return cur;
  }

  async jwks(): Promise<{ keys: Obj[] }> {
    await this.ensure();
    return { keys: this.issuers.flatMap((i) => i.jwks.keys as Obj[]) };
  }

  /** Publish a new signing key and sign with it from now on. The old key stays in the JWKS, so tokens already out keep verifying. */
  async rotate(alg: 'RS256' | 'ES256' = 'RS256'): Promise<{ kid: string; previous_kid: string }> {
    await this.ensure();
    const previous = this.current().kid;
    const next = await this.make(alg);
    this.issuers.push(next);
    return { kid: next.kid, previous_kid: previous };
  }

  async signingKeys(): Promise<Obj[]> {
    await this.ensure();
    const cur = this.current().kid;
    return [...this.issuers].reverse().map((i) => ({ object: 'signing_key', kid: i.kid, alg: (i.jwks.keys[0] as Obj).alg, current: i.kid === cur }));
  }

  async mintSession(input: MintSessionInput): Promise<{ jwt: string; claims: Obj; expiresIn: number }> {
    await this.ensure();
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

  /** Verify as a resource server would: against the engine JWKS, issuer and clock. */
  async verify(token: string): Promise<{ ok: true; claims: Obj } | { ok: false; reason: string }> {
    await this.ensure();
    const backend = new AtlasBackend({ jwks: await this.jwks(), issuer: this.issuerUrl, now: this.engine.clock.now } as any);
    const r = await backend.verify(token);
    return r.ok ? { ok: true, claims: r.claims as Obj } : { ok: false, reason: r.reason };
  }

  secret(prefix: string): string {
    return `${prefix}_${randomToken(24)}`;
  }
}
