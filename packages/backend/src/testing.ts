import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import type { Jwks } from './jwks-cache';
import type { SessionClaims } from './verify';

/**
 * §1.3(c) hermetic test fixtures.
 *
 * A customer's CI must be able to prove its `@atlasauth/backend` verification
 * works — accepts a good session token, rejects a bad one — WITHOUT reaching a
 * live Atlas instance or its JWKS URL. So this module mints tokens with an
 * ephemeral RS256 keypair it generates on the spot and hands back that key's
 * public JWKS. Feed the JWKS to `new AtlasBackend({ jwks, issuer })` and the
 * whole round trip — mint, sign, verify — happens in-process, offline.
 *
 * This is dev/test tooling shaped like Clerk's `@clerk/testing`: it lives in
 * its own module (imported only by tests that want it, never by the hot
 * verification path) and leans on `jose`, which the package already ships.
 */

/** Options for {@link createTestIssuer}. All optional — the defaults are usable as-is. */
export interface CreateTestIssuerOptions {
  /** The `iss` the fixture stamps on every token. Defaults to a local test URL. */
  issuer?: string;
  /** The `kid` on the signing key and in the published JWKS. */
  kid?: string;
  /**
   * A clock, in epoch milliseconds, for `iat`/`exp`. Pass the SAME `now` you
   * give `AtlasBackend` to make time deterministic across mint and verify.
   */
  now?: () => number;
  /** Default token lifetime in seconds, matching Atlas's 60 s default. */
  ttlSeconds?: number;
}

/** A fixture issuer: an in-memory keypair, its public JWKS, and a token minter. */
export interface TestIssuer {
  /** The `iss` this fixture stamps — pass it straight to `AtlasBackend({ issuer })`. */
  issuer: string;
  /** The public JSON Web Key Set — pass it to `AtlasBackend({ jwks })` for offline verify. */
  jwks: Jwks;
  /** The `kid` shared by the signing key and the JWKS entry. */
  kid: string;
  /** The private signing key, for tests that need to sign something by hand. */
  privateKey: KeyLike;
  /**
   * Mint a signed session JWT. Defaults produce a token this fixture's JWKS
   * verifies as a first-party session (`token_use:'session'`, valid `iss`,
   * `sub`, `sid`, `azp`, `iat`/`exp`). Any field in `claims` overrides a
   * default — set `iss` to forge a wrong-issuer token, `exp` to forge an
   * expired one, add `org_id`/`org_permissions` to exercise authorization.
   */
  mintSession(claims?: Partial<SessionClaims>): Promise<string>;
}

const DEFAULT_ISSUER = 'https://test-instance.fapi.atlas.local';
const DEFAULT_KID = 'atlas-test-key-1';
const DEFAULT_TTL_SECONDS = 60;

/**
 * Build an offline test issuer. Generates an RS256 keypair, exposes its public
 * JWKS, and returns a `mintSession` that signs tokens with the private half.
 *
 * ```ts
 * const fx = await createTestIssuer();
 * const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer });
 * const r = await atlas.verify(await fx.mintSession({ sub: 'user_x' }));
 * // r.ok === true — no network call was made.
 * ```
 */
export async function createTestIssuer(
  options: CreateTestIssuerOptions = {},
): Promise<TestIssuer> {
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  const kid = options.kid ?? DEFAULT_KID;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const clock = options.now ?? Date.now;

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  // The published key: the public half plus the `kid`/`alg`/`use` a JWKS
  // consumer keys on — the same shape Atlas serves at `/.well-known/jwks.json`.
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks: Jwks = { keys: [publicJwk] };

  async function mintSession(claims: Partial<SessionClaims> = {}): Promise<string> {
    const nowSeconds = Math.floor(clock() / 1000);
    // System defaults first, caller overrides last — so `mintSession({ iss })`
    // or `mintSession({ exp })` forges exactly the token a rejection test needs.
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: 'user_test',
      sid: 'sess_test',
      azp: issuer,
      sv: 1,
      mfa: false,
      // The §13.1 marker the SDK's requireSessionToken path accepts. A fixture
      // token is a session token, never an OP access/id token.
      token_use: 'session',
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      ...claims,
    };

    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(privateKey);
  }

  return { issuer, jwks, kid, privateKey, mintSession };
}
