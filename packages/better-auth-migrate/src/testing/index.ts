import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { betterAuthEncrypt, type BetterAuthSecret } from '../ba-crypto';
import { exportBetterAuth, type BetterAuthContextLike, type BetterAuthLike, type ExportBetterAuthOptions } from '../export';
import type { ImportPublicKey } from '../transport';

/**
 * Fixture generator: a Better Auth instance in memory, with the exact model and
 * field names Better Auth 1.7 writes (core schema plus the two-factor, passkey,
 * api-key, organization (with teams and dynamic roles), admin, username,
 * phone-number, anonymous, stripe, sso, oauth-provider and jwt plugins), filled
 * with rows encoded the way Better Auth encodes them: scrypt `salt:key`
 * passwords, two-factor secrets and backup codes encrypted with the app secret,
 * base64 COSE passkey keys, SHA-256 base64url API key hashes, JSON-string
 * permissions and metadata.
 *
 * It needs no network and no database; the adapter answers the same
 * `findMany`/`count` calls a real adapter does (keyset pagination by id). Atlas's
 * own import tests build their bundles with it.
 */

/** Field names per model, as Better Auth's schema declares them (logical names). */
export const BETTER_AUTH_FIELDS: Record<string, readonly string[]> = {
  user: [
    'id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt',
    // two-factor
    'twoFactorEnabled',
    // admin
    'role', 'banned', 'banReason', 'banExpires',
    // username
    'username', 'displayUsername',
    // phone-number
    'phoneNumber', 'phoneNumberVerified',
    // anonymous
    'isAnonymous',
    // stripe
    'stripeCustomerId',
  ],
  session: ['id', 'expiresAt', 'token', 'createdAt', 'updatedAt', 'ipAddress', 'userAgent', 'userId', 'impersonatedBy', 'activeOrganizationId', 'activeTeamId'],
  account: [
    'id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken',
    'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'password', 'createdAt', 'updatedAt',
  ],
  verification: ['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'],
  twoFactor: ['id', 'secret', 'backupCodes', 'userId', 'verified', 'failedVerificationCount', 'lockedUntil'],
  passkey: ['id', 'name', 'publicKey', 'userId', 'credentialID', 'counter', 'deviceType', 'backedUp', 'transports', 'createdAt', 'aaguid'],
  apikey: [
    'id', 'configId', 'name', 'start', 'referenceId', 'prefix', 'key', 'refillInterval', 'refillAmount',
    'lastRefillAt', 'enabled', 'rateLimitEnabled', 'rateLimitTimeWindow', 'rateLimitMax', 'requestCount',
    'remaining', 'lastRequest', 'expiresAt', 'createdAt', 'updatedAt', 'permissions', 'metadata',
  ],
  organization: ['id', 'name', 'slug', 'logo', 'createdAt', 'updatedAt', 'metadata', 'stripeCustomerId'],
  organizationRole: ['id', 'organizationId', 'role', 'permission', 'createdAt', 'updatedAt'],
  member: ['id', 'organizationId', 'userId', 'role', 'createdAt'],
  invitation: ['id', 'organizationId', 'email', 'role', 'teamId', 'status', 'expiresAt', 'createdAt', 'inviterId'],
  team: ['id', 'name', 'organizationId', 'createdAt', 'updatedAt'],
  teamMember: ['id', 'teamId', 'userId', 'createdAt'],
  subscription: [
    'id', 'plan', 'referenceId', 'stripeCustomerId', 'stripeSubscriptionId', 'status', 'periodStart', 'periodEnd',
    'trialStart', 'trialEnd', 'cancelAtPeriodEnd', 'cancelAt', 'canceledAt', 'endedAt', 'seats', 'billingInterval', 'stripeScheduleId',
  ],
  ssoProvider: ['id', 'issuer', 'oidcConfig', 'samlConfig', 'userId', 'providerId', 'organizationId', 'domain', 'domainVerified'],
  oauthClient: [
    'id', 'clientId', 'clientSecret', 'disabled', 'skipConsent', 'enableEndSession', 'subjectType', 'scopes', 'userId',
    'createdAt', 'updatedAt', 'name', 'uri', 'icon', 'contacts', 'tos', 'policy', 'redirectUris', 'postLogoutRedirectUris',
    'tokenEndpointAuthMethod', 'grantTypes', 'responseTypes', 'requirePKCE', 'referenceId', 'metadata',
  ],
  oauthApplication: ['id', 'name', 'icon', 'metadata', 'clientId', 'clientSecret', 'redirectUrls', 'type', 'disabled', 'userId', 'createdAt', 'updatedAt'],
  oauthConsent: ['id', 'clientId', 'userId', 'referenceId', 'scopes', 'createdAt', 'updatedAt'],
  oauthAccessToken: ['id', 'token', 'clientId', 'sessionId', 'userId', 'referenceId', 'refreshId', 'expiresAt', 'createdAt', 'scopes'],
  jwks: ['id', 'publicKey', 'privateKey', 'createdAt', 'expiresAt', 'alg', 'crv'],
};

type Row = Record<string, unknown>;

/** An in-memory Better Auth database adapter (the subset the exporter calls). */
export class MemoryAdapter {
  readonly calls: Array<{ model: string; limit?: number; after?: unknown }> = [];
  constructor(readonly db: Record<string, Row[]>) {}

  async findMany<T = Row>(data: {
    model: string;
    where?: Array<{ field: string; value: unknown; operator?: string }>;
    limit?: number;
    sortBy?: { field: string; direction: 'asc' | 'desc' };
    offset?: number;
  }): Promise<T[]> {
    let rows = [...(this.db[data.model] ?? [])];
    for (const w of data.where ?? []) {
      const op = w.operator ?? 'eq';
      rows = rows.filter((r) => {
        const v = r[w.field] as string;
        const target = w.value as string;
        if (op === 'gt') return v > target;
        if (op === 'eq') return v === target;
        throw new Error(`MemoryAdapter: operator ${op} not supported`);
      });
    }
    if (data.sortBy) {
      const { field, direction } = data.sortBy;
      rows.sort((a, b) => (String(a[field]) < String(b[field]) ? -1 : String(a[field]) > String(b[field]) ? 1 : 0) * (direction === 'asc' ? 1 : -1));
    }
    this.calls.push({ model: data.model, limit: data.limit, after: data.where?.[0]?.value });
    const start = data.offset ?? 0;
    // Hand back copies, as a real adapter returns fresh objects.
    return rows.slice(start, data.limit !== undefined ? start + data.limit : undefined).map((r) => ({ ...r })) as T[];
  }

  async count(data: { model: string }): Promise<number> {
    return (this.db[data.model] ?? []).length;
  }
}

/** A Better Auth-shaped instance over a {@link MemoryAdapter}. */
export function createFakeBetterAuth(input: {
  data: Record<string, Row[]>;
  secret?: BetterAuthSecret;
  baseURL?: string;
  plugins?: Array<{ id: string; options?: Record<string, unknown> }>;
  socialProviders?: string[];
  encryptOAuthTokens?: boolean;
  version?: string;
}): BetterAuthLike & { adapter: MemoryAdapter } {
  for (const [model, rows] of Object.entries(input.data)) {
    const fields = BETTER_AUTH_FIELDS[model];
    if (!fields) throw new Error(`Fixture model ${model} is not a Better Auth model.`);
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!fields.includes(k)) throw new Error(`Fixture ${model}.${k} is not a field of Better Auth's ${model} model.`);
      }
    }
  }
  const adapter = new MemoryAdapter(input.data);
  const secret = input.secret ?? 'better-auth-secret-0123456789abcdef';
  const ctx: BetterAuthContextLike = {
    adapter,
    tables: Object.fromEntries(Object.keys(input.data).map((m) => [m, { modelName: m, fields: {} }])),
    secret: typeof secret === 'string' ? secret : '',
    secretConfig: secret,
    baseURL: input.baseURL ?? 'https://app.example.com',
    version: input.version ?? '1.7.12',
    options: {
      basePath: '/api/auth',
      plugins: input.plugins ?? [],
      socialProviders: Object.fromEntries((input.socialProviders ?? []).map((p) => [p, {}])),
      account: { encryptOAuthTokens: input.encryptOAuthTokens === true },
    },
  };
  return { $context: Promise.resolve(ctx), adapter };
}

/** Better Auth's default password hash: scrypt N=16384 r=16 p=1, `hexsalt:hexkey`. */
export function betterAuthPasswordHash(password: string, salt = randomBytes(16).toString('hex')): string {
  const key = scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${key.toString('hex')}`;
}

/** Better Auth's default API key hash (SHA-256, base64url, no padding). */
export function betterAuthKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('base64url');
}

/** The plaintext values the fixture's encrypted/hashed rows were built from (for assertions). */
export interface FixturePlain {
  passwords: Record<string, string>;
  totpSecret: string;
  backupCodes: string[];
  apiKey: string;
  orgApiKey: string;
  sessionToken: string;
  confidentialClientSecret: string;
  encryptedClientSecret: string;
  legacyClientSecret: string;
}

export interface Fixture {
  auth: BetterAuthLike & { adapter: MemoryAdapter };
  data: Record<string, Row[]>;
  plain: FixturePlain;
  secret: string;
}

const iso = (d: Date) => d;

/**
 * A complete Better Auth estate: two organizations (one with a team and a custom
 * role), five users covering every plugin field (admin role, timed ban,
 * username, phone, anonymous, two-factor, passkey), credential + social + SSO
 * accounts, members, team members, a pending and an accepted invitation, user
 * and organization API keys, OIDC and SAML SSO providers, OAuth clients in all
 * three secret storages, a consent, a Stripe subscription, a JWKS key and a
 * live and an expired session.
 *
 * Ids are fixed so tests can assert on them; pass `idPrefix` to keep two
 * fixtures in one database apart.
 */
export function generateFixture(opts: { secret?: string; now?: Date; idPrefix?: string; rpId?: string; withPasswords?: boolean } = {}): Fixture {
  const secret = opts.secret ?? 'better-auth-secret-0123456789abcdef';
  const now = opts.now ?? new Date();
  const p = opts.idPrefix ?? 'ba';
  const id = (s: string) => `${p}_${s}`;
  const day = 24 * 3600 * 1000;
  const past = new Date(now.getTime() - 30 * day);
  const future = new Date(now.getTime() + 30 * day);
  const emailDomain = `${p}.example.com`;

  const passwords = { alice: 'correct horse battery staple', dave: 'another long passphrase 42' };
  const totpSecret = 'k3Jx9QwErTyUiOpAsDfGhJkLzXcVbNm1';
  const backupCodes = ['ABCDE-12345', 'fghij-67890', 'KLMNO-13579'];
  const apiKey = `ba_${randomBytes(24).toString('base64url')}`;
  const orgApiKey = `ba_${randomBytes(24).toString('base64url')}`;
  const sessionToken = randomBytes(24).toString('base64url');
  const confidentialClientSecret = randomBytes(24).toString('base64url');
  const encryptedClientSecret = randomBytes(24).toString('base64url');
  const legacyClientSecret = randomBytes(24).toString('base64url');

  // A COSE EC2 P-256 public key, as base64 (Better Auth stores `base64.encode(credential.publicKey)`).
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), randomBytes(32), Buffer.from('225820', 'hex'), randomBytes(32)]);

  const hash = (pw: string) => (opts.withPasswords === false ? null : betterAuthPasswordHash(pw));

  const data: Record<string, Row[]> = {
    organization: [
      { id: id('org_acme'), name: 'Acme', slug: `${p}-acme`, logo: 'https://cdn.example.com/acme.png', createdAt: iso(past), updatedAt: iso(past), metadata: JSON.stringify({ tier: 'gold' }), stripeCustomerId: 'cus_org_acme' },
      { id: id('org_beta'), name: 'Beta Co', slug: `${p}-beta`, logo: null, createdAt: iso(past), updatedAt: iso(past), metadata: null, stripeCustomerId: null },
    ],
    organizationRole: [
      { id: id('orgrole_billing'), organizationId: id('org_acme'), role: 'billing', permission: JSON.stringify({ invoice: ['read', 'pay'] }), createdAt: iso(past), updatedAt: iso(past) },
    ],
    user: [
      {
        id: id('user_alice'), name: 'Alice Liddell', email: `alice@${emailDomain}`, emailVerified: true, image: 'https://cdn.example.com/alice.png',
        createdAt: iso(past), updatedAt: iso(past), twoFactorEnabled: true, role: 'admin', banned: false, banReason: null, banExpires: null,
        username: 'alice', displayUsername: 'Alice', phoneNumber: '+14155550101', phoneNumberVerified: true, isAnonymous: false, stripeCustomerId: 'cus_alice',
      },
      {
        id: id('user_bob'), name: 'Bob Builder', email: `bob@${emailDomain}`, emailVerified: false, image: null,
        createdAt: iso(past), updatedAt: iso(past), twoFactorEnabled: false, role: 'user', banned: true, banReason: 'spam', banExpires: iso(future),
        username: null, displayUsername: null, phoneNumber: null, phoneNumberVerified: false, isAnonymous: false, stripeCustomerId: null,
      },
      {
        id: id('user_carol'), name: 'Anonymous', email: `temp-${p}carol@${emailDomain}`, emailVerified: false, image: null,
        createdAt: iso(past), updatedAt: iso(past), twoFactorEnabled: false, role: 'user', banned: false, banReason: null, banExpires: null,
        username: null, displayUsername: null, phoneNumber: null, phoneNumberVerified: false, isAnonymous: true, stripeCustomerId: null,
      },
      {
        id: id('user_dave'), name: 'Dave', email: `dave@${emailDomain}`, emailVerified: true, image: null,
        createdAt: iso(past), updatedAt: iso(past), twoFactorEnabled: false, role: 'support,user', banned: false, banReason: null, banExpires: null,
        username: 'dave', displayUsername: 'Dave', phoneNumber: null, phoneNumberVerified: false, isAnonymous: false, stripeCustomerId: null,
      },
      {
        id: id('user_erin'), name: 'Erin', email: `erin@${emailDomain}`, emailVerified: true, image: null,
        createdAt: iso(past), updatedAt: iso(past), twoFactorEnabled: false, role: 'user', banned: true, banReason: 'old ban', banExpires: iso(past),
        username: null, displayUsername: null, phoneNumber: null, phoneNumberVerified: false, isAnonymous: false, stripeCustomerId: null,
      },
    ],
    ssoProvider: [
      {
        id: id('sso_oidc'), issuer: 'https://login.acme-idp.example', providerId: `${p}-acme-oidc`, organizationId: id('org_acme'), userId: id('user_alice'),
        domain: `acme-${p}.example`, domainVerified: true, samlConfig: null,
        oidcConfig: JSON.stringify({
          issuer: 'https://login.acme-idp.example', pkce: true, clientId: 'acme-client', clientSecret: 'acme-oidc-secret',
          discoveryEndpoint: 'https://login.acme-idp.example/.well-known/openid-configuration', scopes: ['openid', 'email', 'profile'],
          tokenEndpointAuthentication: 'client_secret_basic', mapping: { id: 'sub', email: 'email', name: 'name' },
        }),
      },
      {
        id: id('sso_saml'), issuer: `https://sp.${emailDomain}`, providerId: `${p}-beta-saml`, organizationId: id('org_beta'), userId: id('user_dave'),
        domain: `beta-${p}.example`, domainVerified: false, oidcConfig: null,
        samlConfig: JSON.stringify({
          issuer: `https://sp.${emailDomain}`, entryPoint: 'https://idp.beta.example/sso',
          cert: '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUFIXTURE\n-----END CERTIFICATE-----',
          callbackUrl: `https://app.example.com/api/auth/sso/saml2/callback/${p}-beta-saml`,
          idpMetadata: { entityID: 'https://idp.beta.example/metadata' }, spMetadata: {},
        }),
      },
    ],
    account: [
      { id: id('acct_alice_pw'), accountId: id('user_alice'), providerId: 'credential', userId: id('user_alice'), password: hash(passwords.alice), createdAt: iso(past), updatedAt: iso(past) },
      { id: id('acct_bob_google'), accountId: `g-${p}-1001`, providerId: 'google', userId: id('user_bob'), accessToken: 'ya29.fixture', refreshToken: '1//fixture', scope: 'openid,email', createdAt: iso(past), updatedAt: iso(past) },
      { id: id('acct_bob_twitter'), accountId: `tw-${p}-2002`, providerId: 'twitter', userId: id('user_bob'), createdAt: iso(past), updatedAt: iso(past) },
      { id: id('acct_dave_pw'), accountId: id('user_dave'), providerId: 'credential', userId: id('user_dave'), password: hash(passwords.dave), createdAt: iso(past), updatedAt: iso(past) },
      { id: id('acct_dave_sso'), accountId: `saml-${p}-dave`, providerId: `${p}-beta-saml`, userId: id('user_dave'), createdAt: iso(past), updatedAt: iso(past) },
      { id: id('acct_dave_custom'), accountId: `kc-${p}-77`, providerId: 'keycloak', userId: id('user_dave'), createdAt: iso(past), updatedAt: iso(past) },
    ],
    twoFactor: [
      {
        id: id('tf_alice'), userId: id('user_alice'), verified: true, failedVerificationCount: 0, lockedUntil: null,
        secret: betterAuthEncrypt(secret, totpSecret),
        backupCodes: betterAuthEncrypt(secret, JSON.stringify(backupCodes)),
      },
    ],
    passkey: [
      {
        id: id('pk_alice'), name: 'MacBook Touch ID', userId: id('user_alice'), credentialID: randomBytes(16).toString('base64url'),
        publicKey: cose.toString('base64'), counter: 7, deviceType: 'multiDevice', backedUp: true, transports: 'internal,hybrid',
        createdAt: iso(past), aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
      },
    ],
    member: [
      { id: id('mem_alice_acme'), organizationId: id('org_acme'), userId: id('user_alice'), role: 'owner', createdAt: iso(past) },
      { id: id('mem_dave_acme'), organizationId: id('org_acme'), userId: id('user_dave'), role: 'billing', createdAt: iso(past) },
      { id: id('mem_dave_beta'), organizationId: id('org_beta'), userId: id('user_dave'), role: 'member,admin', createdAt: iso(past) },
    ],
    team: [{ id: id('team_eng'), name: 'Engineering', organizationId: id('org_acme'), createdAt: iso(past), updatedAt: iso(past) }],
    teamMember: [
      { id: id('tm_alice'), teamId: id('team_eng'), userId: id('user_alice'), createdAt: iso(past) },
      { id: id('tm_dave'), teamId: id('team_eng'), userId: id('user_dave'), createdAt: iso(past) },
    ],
    invitation: [
      { id: id('inv_pending'), organizationId: id('org_acme'), email: `frank@${emailDomain}`, role: 'member', teamId: id('team_eng'), status: 'pending', expiresAt: iso(future), createdAt: iso(past), inviterId: id('user_alice') },
      { id: id('inv_accepted'), organizationId: id('org_acme'), email: `dave@${emailDomain}`, role: 'billing', teamId: null, status: 'accepted', expiresAt: iso(past), createdAt: iso(past), inviterId: id('user_alice') },
    ],
    apikey: [
      {
        id: id('key_alice'), configId: 'default', name: 'CI key', start: apiKey.slice(0, 6), referenceId: id('user_alice'), prefix: 'ba_', key: betterAuthKeyHash(apiKey),
        refillInterval: day, refillAmount: 1000, lastRefillAt: iso(past), enabled: true, rateLimitEnabled: true, rateLimitTimeWindow: 60_000, rateLimitMax: 100,
        requestCount: 3, remaining: 997, lastRequest: iso(past), expiresAt: iso(future), createdAt: iso(past), updatedAt: iso(past),
        permissions: JSON.stringify({ files: ['read', 'write'] }), metadata: JSON.stringify({ plan: 'pro' }),
      },
      {
        id: id('key_acme'), configId: 'org', name: 'Acme server', start: orgApiKey.slice(0, 6), referenceId: id('org_acme'), prefix: 'ba_', key: betterAuthKeyHash(orgApiKey),
        refillInterval: null, refillAmount: null, lastRefillAt: null, enabled: true, rateLimitEnabled: false, rateLimitTimeWindow: null, rateLimitMax: null,
        requestCount: 0, remaining: null, lastRequest: null, expiresAt: null, createdAt: iso(past), updatedAt: iso(past), permissions: null, metadata: null,
      },
    ],
    oauthClient: [
      {
        id: id('oc_conf'), clientId: `${p}-client-confidential`, clientSecret: betterAuthKeyHash(confidentialClientSecret), disabled: false, skipConsent: false,
        enableEndSession: true, subjectType: 'public', scopes: ['openid', 'profile', 'email', 'offline_access'], userId: id('user_alice'),
        createdAt: iso(past), updatedAt: iso(past), name: 'Partner Portal', uri: 'https://partner.example.com', icon: 'https://partner.example.com/icon.png',
        contacts: ['ops@partner.example.com'], tos: null, policy: null, redirectUris: ['https://partner.example.com/callback'],
        postLogoutRedirectUris: ['https://partner.example.com/'], tokenEndpointAuthMethod: 'client_secret_basic', grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'], requirePKCE: true, referenceId: null, metadata: null,
      },
      {
        id: id('oc_public'), clientId: `${p}-client-spa`, clientSecret: null, disabled: false, skipConsent: true, enableEndSession: false, subjectType: 'public',
        scopes: ['openid', 'profile'], userId: null, createdAt: iso(past), updatedAt: iso(past), name: 'SPA', uri: null, icon: null, contacts: null, tos: null,
        policy: null, redirectUris: ['https://spa.example.com/cb'], postLogoutRedirectUris: [], tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code'],
        responseTypes: ['code'], requirePKCE: true, referenceId: null, metadata: null,
      },
    ],
    oauthApplication: [
      {
        id: id('oa_legacy'), name: 'Legacy app', icon: null, metadata: JSON.stringify({ team: 'core' }), clientId: `${p}-legacy-client`, clientSecret: legacyClientSecret,
        redirectUrls: 'https://legacy.example.com/cb,https://legacy.example.com/cb2', type: 'web', disabled: false, userId: id('user_alice'), createdAt: iso(past), updatedAt: iso(past),
      },
    ],
    oauthConsent: [{ id: id('consent_1'), clientId: `${p}-client-confidential`, userId: id('user_alice'), referenceId: null, scopes: ['openid', 'profile'], createdAt: iso(past), updatedAt: iso(past) }],
    oauthAccessToken: [{ id: id('oat_1'), token: 'opaque-access', clientId: `${p}-client-confidential`, sessionId: null, userId: id('user_alice'), referenceId: null, refreshId: null, expiresAt: iso(future), createdAt: iso(past), scopes: ['openid'] }],
    subscription: [
      {
        id: id('sub_acme'), plan: 'pro', referenceId: id('org_acme'), stripeCustomerId: 'cus_org_acme', stripeSubscriptionId: `sub_${p}_acme`, status: 'active',
        periodStart: iso(past), periodEnd: iso(future), trialStart: null, trialEnd: null, cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, endedAt: null,
        seats: 5, billingInterval: 'month', stripeScheduleId: null,
      },
    ],
    jwks: [
      {
        id: id('jwk_1'), alg: 'EdDSA', crv: 'Ed25519', createdAt: iso(past), expiresAt: null,
        publicKey: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: randomBytes(32).toString('base64url') }),
        privateKey: betterAuthEncrypt(secret, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: 'private-material' })),
      },
    ],
    session: [
      { id: id('sess_live'), expiresAt: iso(future), token: sessionToken, createdAt: iso(past), updatedAt: iso(past), ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0', userId: id('user_alice'), impersonatedBy: null, activeOrganizationId: id('org_acme'), activeTeamId: null },
      { id: id('sess_old'), expiresAt: iso(past), token: randomBytes(24).toString('base64url'), createdAt: iso(past), updatedAt: iso(past), ipAddress: null, userAgent: null, userId: id('user_bob'), impersonatedBy: null, activeOrganizationId: null, activeTeamId: null },
    ],
    verification: [{ id: id('ver_1'), identifier: `email-verification:bob@${emailDomain}`, value: 'token', expiresAt: iso(future), createdAt: iso(past), updatedAt: iso(past) }],
  };

  // The encrypted-storage client secret: an extra client whose secret is sealed with the app secret.
  data.oauthClient!.push({
    ...data.oauthClient![0]!,
    id: id('oc_encrypted'),
    clientId: `${p}-client-encrypted`,
    name: 'Encrypted secret client',
    clientSecret: betterAuthEncrypt(secret, encryptedClientSecret),
  });

  const auth = createFakeBetterAuth({
    data,
    secret,
    plugins: [
      { id: 'two-factor', options: { issuer: 'Acme' } },
      { id: 'passkey', options: { rpID: opts.rpId ?? 'app.example.com' } },
      { id: 'api-key' },
      { id: 'organization', options: { teams: { enabled: true } } },
      { id: 'admin' },
      { id: 'username' },
      { id: 'phone-number' },
      { id: 'anonymous' },
      { id: 'stripe' },
      { id: 'sso' },
      { id: 'oauth-provider', options: { storeClientSecret: 'hashed' } },
      { id: 'jwt' },
      { id: 'multi-session' },
    ],
    socialProviders: ['google', 'twitter'],
  });

  return {
    auth,
    data,
    secret,
    plain: { passwords, totpSecret, backupCodes, apiKey, orgApiKey, sessionToken, confidentialClientSecret, encryptedClientSecret, legacyClientSecret },
  };
}

/**
 * Export a fixture straight into a sealed bundle held in memory. Pass the import
 * key to seal to. Note the `oc_encrypted` client stores its secret encrypted
 * while the rest are hashed; `oauthClientSecretStorage` applies to all of
 * them, so the fixture exports twice-encoded rows exactly as a mixed estate would
 * after a storage change: the encrypted one arrives with `clientSecretHash` set to
 * its ciphertext, which Atlas reports as a secret that needs rotating.
 */
export async function buildFixtureBundle(
  fixture: Fixture,
  publicKey: ImportPublicKey | { kid: string; public_key: string } | string,
  options: Partial<Omit<ExportBetterAuthOptions, 'out' | 'publicKey'>> = {},
): Promise<{ text: string; sha256: string; counts: Record<string, number> }> {
  const lines: string[] = [];
  const result = await exportBetterAuth(fixture.auth, {
    ...options,
    publicKey,
    out: { write: (line) => void lines.push(line) },
  });
  return { text: `${lines.join('\n')}\n`, sha256: result.sha256, counts: result.counts };
}
