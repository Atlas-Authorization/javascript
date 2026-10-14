/**
 * The in-memory mock backend that {@link ../handlers} reads and mutates.
 *
 * `createAtlasMock(seed?)` returns a mutable store standing in for ONE Atlas
 * instance: its environment config, users (with email addresses), organizations
 * and memberships, live sign-in / sign-up attempts, and sessions. The handlers
 * advance this store — a sign-in attempt really transitions across calls, a
 * created user really appears in the next list — so a test drives the same state
 * machine the real server runs, without a server.
 *
 * Everything is deterministic: ids come from a seedable per-prefix counter, so a
 * test that seeds the same thing gets byte-identical ids every run.
 */

/** The Atlas entity kinds this mock mints ids for. Mirrors `@atlas/shared`'s prefixes. */
export const ID_PREFIXES = {
  instance: 'ins',
  user: 'user',
  emailAddress: 'eml',
  session: 'sess',
  signInAttempt: 'sia',
  signUpAttempt: 'sia',
  organization: 'org',
  organizationMembership: 'orgmem',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

/** A single email address on a user — the Clerk-compatible `email_address` shape. */
export interface MockEmail {
  id: string;
  email: string;
  verified: boolean;
  primary: boolean;
}

/** A user in the mock store. Field names are internal; the handlers serialise them. */
export interface MockUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string | null;
  locale: string | null;
  externalId: string | null;
  /** The plaintext password the mock checks on a password sign-in (never serialised). */
  password: string | null;
  emails: MockEmail[];
  primaryEmailId: string | null;
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
  unsafeMetadata: Record<string, unknown>;
  mfaEnabled: boolean;
  isAnonymous: boolean;
  banned: boolean;
  deletedAt: number | null;
  lastSignInAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** An organization in the mock store. */
export interface MockOrganization {
  id: string;
  name: string;
  slug: string | null;
  imageUrl: string | null;
  parentOrganizationId: string | null;
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
  maxAllowedMemberships: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A user's membership of an organization, with the role they hold in it. */
export interface MockMembership {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: number;
}

/** A live session minted by a completed sign-in or a backend mint. */
export interface MockSession {
  id: string;
  userId: string;
  status: 'active' | 'revoked' | 'ended';
  activeOrganizationId: string | null;
  impersonatedBy: string | null;
  /** The opaque bearer the mock hands back as `jwt` and accepts on `me`. */
  jwt: string;
  refreshToken: string;
  lastActiveAt: number;
  expiresAt: number;
  idleExpiresAt: number;
  createdAt: number;
}

/** A live sign-in or sign-up attempt, advanced across prepare/attempt calls. */
export interface MockAttempt {
  id: string;
  kind: 'sign_in' | 'sign_up';
  status:
    | 'needs_identifier'
    | 'needs_first_factor'
    | 'needs_second_factor'
    | 'needs_email_verification'
    | 'complete'
    | 'abandoned';
  identifier: string | null;
  userId: string | null;
  strategy: string | null;
  /** The code the next `attempt_*` call must present (email_code / verification). */
  pendingCode: string | null;
  /** Returned to the originating tab by `prepare_first_factor` (sign-in only). */
  pollSecret: string | null;
  /** One-time ticket issued on completion, redeemed at `tickets/exchange`. */
  ticket: string | null;
  sessionId: string | null;
  createdAt: number;
  expiresAt: number;
}

/** A social provider surfaced by `GET /v1/client/environment`. */
export interface MockSocialProvider {
  provider: string;
  native?: boolean;
  mode?: 'native' | 'redirect';
  label?: string | null;
  display_name?: string | null;
  allow_sign_in?: boolean;
  allow_sign_up?: boolean;
}

/** The instance / environment config the environment + JWKS endpoints report. */
export interface MockInstance {
  id: string;
  /** The FAPI origin the handlers are mounted on (publishable-key surface). */
  fapiBaseUrl: string;
  /** The BAPI origin the handlers are mounted on (secret-key surface). */
  bapiBaseUrl: string;
  publishableKey: string;
  secretKey: string;
  /** The enabled first factors, surfaced as `environment.first_factors`. */
  firstFactors: string[];
  socialProviders: MockSocialProvider[];
  /** The fixed OTP every email_code / verification accepts in the mock. */
  testOtp: string;
  jwks: { keys: unknown[] };
}

/** Seed for {@link createAtlasMock}. Everything is optional; sane defaults fill the rest. */
export interface AtlasMockSeed {
  instance?: Partial<MockInstance>;
  users?: SeedUser[];
  organizations?: SeedOrganization[];
}

/** A friendly user seed — the mock normalises it into a {@link MockUser}. */
export interface SeedUser {
  id?: string;
  email?: string;
  emailVerified?: boolean;
  password?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  imageUrl?: string;
  locale?: string;
  externalId?: string;
  publicMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
  unsafeMetadata?: Record<string, unknown>;
  mfaEnabled?: boolean;
  isAnonymous?: boolean;
}

/** A friendly organization seed. */
export interface SeedOrganization {
  id?: string;
  name: string;
  slug?: string;
  imageUrl?: string;
  publicMetadata?: Record<string, unknown>;
  maxAllowedMemberships?: number;
  createdBy?: string;
  /** User ids to seat as members, with their role (defaults to `member`). */
  members?: Array<{ userId: string; role?: string }>;
}

const DEFAULT_JWKS = {
  keys: [
    {
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: 'atlas-mock-key-1',
      // A fixed, well-formed modulus/exponent pair — shape-correct for a JWKS
      // consumer (it never actually verifies a signature against the mock).
      n: 'wXy5u0Zq8m2V6nF3pQ8rT1sW4xY7zA0bC3dE6fG9hJkL2mN5oP8qR1sT4uV7wX0yZ3aB6cD9eF2gH5iJ8kL1mN4oP7qR0sT3uV6wX9yZ2aB5cD8eF1gH4iJ7kL0mN3oP6qR9sT2uV5wX8yZ1aB4cD7eF0gH3iJ6kL9mN2oP5qR8sT1uV4wX7yZ0aB3cD6eF9gH2iJ5kL8mN1oP4qR7sT0uV3wX6yZ9',
      e: 'AQAB',
    },
  ],
};

/**
 * A deterministic, seedable id factory. Each entity kind has its own monotonic
 * counter, so `user(1)`, `user(2)`, … are stable across runs. Ids keep the
 * Atlas `<prefix>_<...>` shape (e.g. `user_0000000000000000000000000001`).
 */
export class IdFactory {
  private readonly counters = new Map<string, number>();

  next(kind: EntityKind): string {
    const prefix = ID_PREFIXES[kind];
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(26, '0')}`;
  }

  reset(): void {
    this.counters.clear();
  }
}

/**
 * The mutable mock store. Created by {@link createAtlasMock}; the handlers close
 * over one instance of this and mutate it in place.
 */
export class AtlasMock {
  readonly instance: MockInstance;
  readonly users: MockUser[] = [];
  readonly organizations: MockOrganization[] = [];
  readonly memberships: MockMembership[] = [];
  readonly attempts: MockAttempt[] = [];
  readonly sessions: MockSession[] = [];
  /** The session the `GET /v1/client` boot reports as active (set on exchange). */
  activeSessionId: string | null = null;

  readonly ids = new IdFactory();
  private readonly seed: AtlasMockSeed;

  constructor(seed: AtlasMockSeed = {}) {
    this.seed = seed;
    const inst = seed.instance ?? {};
    this.instance = {
      id: inst.id ?? this.ids.next('instance'),
      fapiBaseUrl: trimSlash(inst.fapiBaseUrl ?? 'https://fapi.atlas.test'),
      bapiBaseUrl: trimSlash(inst.bapiBaseUrl ?? 'https://api.atlas.test'),
      publishableKey: inst.publishableKey ?? 'pk_test_atlas',
      secretKey: inst.secretKey ?? 'sk_test_atlas',
      firstFactors: inst.firstFactors ?? ['password', 'email_code'],
      socialProviders: inst.socialProviders ?? [],
      testOtp: inst.testOtp ?? '424242',
      jwks: inst.jwks ?? DEFAULT_JWKS,
    };
    this.applySeed(seed);
  }

  private applySeed(seed: AtlasMockSeed): void {
    for (const u of seed.users ?? []) this.addUser(u);
    for (const o of seed.organizations ?? []) this.addOrganization(o);
  }

  /** The FAPI origin the handlers are mounted on. */
  get fapiBaseUrl(): string {
    return this.instance.fapiBaseUrl;
  }

  /** The BAPI origin the handlers are mounted on. */
  get bapiBaseUrl(): string {
    return this.instance.bapiBaseUrl;
  }

  /** Seat a user into the store, normalising a friendly seed into a {@link MockUser}. */
  addUser(seed: SeedUser): MockUser {
    const now = Date.now();
    const id = seed.id ?? this.ids.next('user');
    const emails: MockEmail[] = [];
    let primaryEmailId: string | null = null;
    if (seed.email) {
      const emailId = this.ids.next('emailAddress');
      const verified = seed.emailVerified ?? true;
      emails.push({
        id: emailId,
        email: seed.email.trim().toLowerCase(),
        verified,
        primary: true,
      });
      // The primary points only at a VERIFIED address (§4.2), so `primary_email`
      // is never an unverified placeholder.
      primaryEmailId = verified ? emailId : null;
    }
    const user: MockUser = {
      id,
      firstName: seed.firstName ?? null,
      lastName: seed.lastName ?? null,
      username: seed.username ?? null,
      imageUrl: seed.imageUrl ?? null,
      locale: seed.locale ?? null,
      externalId: seed.externalId ?? null,
      password: seed.password ?? null,
      emails,
      primaryEmailId,
      publicMetadata: seed.publicMetadata ?? {},
      privateMetadata: seed.privateMetadata ?? {},
      unsafeMetadata: seed.unsafeMetadata ?? {},
      mfaEnabled: seed.mfaEnabled ?? false,
      isAnonymous: seed.isAnonymous ?? false,
      banned: false,
      deletedAt: null,
      lastSignInAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.push(user);
    return user;
  }

  /** Seat an organization (and any seeded members) into the store. */
  addOrganization(seed: SeedOrganization): MockOrganization {
    const now = Date.now();
    const org: MockOrganization = {
      id: seed.id ?? this.ids.next('organization'),
      name: seed.name,
      slug: seed.slug ?? null,
      imageUrl: seed.imageUrl ?? null,
      parentOrganizationId: null,
      publicMetadata: seed.publicMetadata ?? {},
      privateMetadata: {},
      maxAllowedMemberships: seed.maxAllowedMemberships ?? null,
      createdBy: seed.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.push(org);
    for (const m of seed.members ?? []) {
      this.addMembership(m.userId, org.id, m.role ?? 'member');
    }
    return org;
  }

  /** Add a membership tying a user to an organization with a role. */
  addMembership(userId: string, organizationId: string, role = 'member'): MockMembership {
    const membership: MockMembership = {
      id: this.ids.next('organizationMembership'),
      userId,
      organizationId,
      role,
      createdAt: Date.now(),
    };
    this.memberships.push(membership);
    return membership;
  }

  /** Find a user by id (ignores soft-deleted unless asked). */
  findUser(id: string, includeDeleted = false): MockUser | undefined {
    const user = this.users.find((u) => u.id === id);
    if (!user) return undefined;
    if (user.deletedAt && !includeDeleted) return undefined;
    return user;
  }

  /** Find a user by any of their verified email addresses. */
  findUserByEmail(email: string): MockUser | undefined {
    const needle = email.trim().toLowerCase();
    return this.users.find(
      (u) => !u.deletedAt && u.emails.some((e) => e.email === needle && e.verified),
    );
  }

  findOrganization(id: string): MockOrganization | undefined {
    return this.organizations.find((o) => o.id === id);
  }

  findAttempt(id: string): MockAttempt | undefined {
    return this.attempts.find((a) => a.id === id);
  }

  findSession(id: string): MockSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** The live session a FAPI bearer `jwt` authenticates as, or undefined. */
  sessionForJwt(jwt: string): MockSession | undefined {
    return this.sessions.find((s) => s.jwt === jwt && s.status === 'active');
  }

  /** Mint a live session for a user (the same object a completed sign-in yields). */
  createSession(userId: string, opts: { impersonatedBy?: string } = {}): MockSession {
    const now = Date.now();
    const id = this.ids.next('session');
    const session: MockSession = {
      id,
      userId,
      status: 'active',
      activeOrganizationId: null,
      impersonatedBy: opts.impersonatedBy ?? null,
      jwt: `jwt_${id}`,
      refreshToken: `rt_${id}`,
      lastActiveAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      idleExpiresAt: now + 30 * 60 * 1000,
      createdAt: now,
    };
    this.sessions.push(session);
    const user = this.users.find((u) => u.id === userId);
    if (user) user.lastSignInAt = now;
    return session;
  }

  /** Reset the store to its original seed — the per-test teardown helper. */
  reset(): void {
    this.users.length = 0;
    this.organizations.length = 0;
    this.memberships.length = 0;
    this.attempts.length = 0;
    this.sessions.length = 0;
    this.activeSessionId = null;
    this.ids.reset();
    // Re-mint the instance id consumed before the seed ran, so ids line up.
    if (!this.seed.instance?.id) this.ids.next('instance');
    this.applySeed(this.seed);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Create a mutable mock Atlas backend. Pass a seed to pre-populate users,
 * organizations and the instance/environment config; everything is optional.
 *
 * @example
 * const mock = createAtlasMock({
 *   instance: { firstFactors: ['password'] },
 *   users: [{ email: 'ada@example.com', password: 'hunter2' }],
 * });
 */
export function createAtlasMock(seed?: AtlasMockSeed): AtlasMock {
  return new AtlasMock(seed);
}
