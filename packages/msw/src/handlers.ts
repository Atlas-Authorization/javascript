/**
 * MSW (v2) request handlers that stand in for Atlas's Frontend API (FAPI, the
 * publishable-key browser surface) and Backend API (BAPI, the secret-key
 * administrative surface). Each handler reads and mutates a {@link AtlasMock}
 * store, so the mocked endpoints behave like a real instance across calls — a
 * sign-in attempt advances, a minted session authenticates `me`, a created user
 * appears in the next list.
 *
 * ```ts
 * import { setupServer } from 'msw/node';
 * import { atlasHandlers, createAtlasMock } from '@atlasauth/msw';
 *
 * const mock = createAtlasMock({ users: [{ email: 'ada@example.com', password: 'pw' }] });
 * const server = setupServer(...atlasHandlers(mock));
 * ```
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import type { AtlasMock, MockAttempt } from './state';
import {
  errorBody,
  listEnvelope,
  presentMeUser,
  presentMembership,
  presentOrganization,
  presentSession,
  presentSignInAttempt,
  presentSignUpAttempt,
  presentUser,
} from './serializers';

export interface AtlasHandlersOptions {
  /** Override the FAPI origin the handlers mount on (defaults to `mock.fapiBaseUrl`). */
  fapiBaseUrl?: string;
  /** Override the BAPI origin the handlers mount on (defaults to `mock.bapiBaseUrl`). */
  bapiBaseUrl?: string;
}

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/**
 * Build the full set of FAPI + BAPI handlers for a mock store. Spread the result
 * into `setupServer(...)` (Node) or `setupWorker(...)` (browser).
 */
export function atlasHandlers(mock: AtlasMock, options: AtlasHandlersOptions = {}): HttpHandler[] {
  const fapi = (options.fapiBaseUrl ?? mock.fapiBaseUrl).replace(/\/+$/, '');
  const bapi = (options.bapiBaseUrl ?? mock.bapiBaseUrl).replace(/\/+$/, '');
  return [...fapiHandlers(mock, fapi), ...bapiHandlers(mock, bapi)];
}

// ---------------------------------------------------------------------------
// Auth guards — the publishable-key (FAPI) and secret-key (BAPI) gates.
// ---------------------------------------------------------------------------

/** FAPI is identified by a publishable key (`x-publishable-key` header or `?publishable_key`). */
function requirePublishableKey(request: Request): Response | null {
  const header = request.headers.get('x-publishable-key');
  const fromQuery = new URL(request.url).searchParams.get('publishable_key');
  const key = header ?? fromQuery;
  if (!key) {
    return HttpResponse.json(
      errorBody('VALIDATION_FAILED', 'A publishable key is required.', 'publishable_key'),
      { status: 400 },
    );
  }
  return null;
}

/** BAPI requires a secret key: `Authorization: Bearer sk_…`, matching the instance's. */
function requireSecretKey(mock: AtlasMock, request: Request): Response | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return HttpResponse.json(
      errorBody('UNAUTHENTICATED', 'Missing Authorization: Bearer <secret key>.'),
      { status: 401 },
    );
  }
  const presented = header.slice('Bearer '.length).trim();
  // Either secret-key format: `sk_…` or `atlas_<env>_sk_…`.
  if (!/^(sk_|atlas_(live|test)_sk_)/.test(presented) || presented !== mock.instance.secretKey) {
    return HttpResponse.json(
      errorBody('INVALID_KEY', 'The API key is invalid or has been revoked.'),
      { status: 401 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// FAPI — the publishable-key browser surface.
// ---------------------------------------------------------------------------

function fapiHandlers(mock: AtlasMock, base: string): HttpHandler[] {
  const now = () => Date.now();

  const newAttempt = (kind: MockAttempt['kind'], partial: Partial<MockAttempt>): MockAttempt => {
    const id = mock.ids.next(kind === 'sign_in' ? 'signInAttempt' : 'signUpAttempt');
    const attempt: MockAttempt = {
      id,
      kind,
      status: partial.status ?? 'needs_first_factor',
      identifier: partial.identifier ?? null,
      userId: partial.userId ?? null,
      strategy: partial.strategy ?? null,
      pendingCode: partial.pendingCode ?? null,
      pollSecret: partial.pollSecret ?? null,
      ticket: partial.ticket ?? null,
      sessionId: partial.sessionId ?? null,
      createdAt: now(),
      expiresAt: now() + ATTEMPT_TTL_MS,
    };
    mock.attempts.push(attempt);
    return attempt;
  };

  /** Complete an attempt: mint a session + a one-time ticket, mirror onto the attempt. */
  const complete = (attempt: MockAttempt): void => {
    if (!attempt.userId) return;
    const session = mock.createSession(attempt.userId);
    attempt.status = 'complete';
    attempt.sessionId = session.id;
    attempt.ticket = `tkt_${attempt.id}`;
  };

  return [
    // GET /v1/client/environment — enabled first factors + social providers.
    http.get(`${base}/v1/client/environment`, ({ request }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      return HttpResponse.json({
        object: 'environment',
        first_factors: mock.instance.firstFactors,
        social_providers: mock.instance.socialProviders,
      });
    }),

    // GET /v1/client — the session-boot the SDK calls on every page load.
    http.get(`${base}/v1/client`, ({ request }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const session = mock.activeSessionId ? mock.findSession(mock.activeSessionId) : undefined;
      if (!session || session.status !== 'active') {
        return HttpResponse.json({
          object: 'client',
          session: null,
          sessions: [],
          last_active_session_id: null,
          user: null,
          organization_memberships: [],
        });
      }
      const user = mock.findUser(session.userId);
      if (!user) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown user.'), { status: 404 });
      }
      const memberships = mock.memberships.filter((m) => m.userId === user.id);
      return HttpResponse.json({
        object: 'client',
        session: {
          object: 'session',
          id: session.id,
          status: session.status,
          last_active_organization_id: session.activeOrganizationId,
          expire_at: session.expiresAt,
          abandon_at: session.idleExpiresAt,
        },
        sessions: [
          {
            object: 'session',
            id: session.id,
            status: session.status,
            last_active_organization_id: session.activeOrganizationId,
            expire_at: session.expiresAt,
            abandon_at: session.idleExpiresAt,
            user: presentMeUser(mock, user),
          },
        ],
        last_active_session_id: session.id,
        jwt: session.jwt,
        expires_in: Math.round((session.expiresAt - now()) / 1000),
        user: presentMeUser(mock, user),
        organization_memberships: memberships.map((m) =>
          presentMembership(mock, m.organizationId, m.role),
        ),
      });
    }),

    // POST /v1/client/sign_ins — start an attempt from an identifier.
    http.post(`${base}/v1/client/sign_ins`, async ({ request }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const body = (await readJson(request)) as { identifier?: string; strategy?: string };
      const identifier = body.identifier?.trim().toLowerCase();
      if (!identifier) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'An identifier is required.', 'identifier'),
          { status: 400 },
        );
      }
      // An unknown identifier still produces a real attempt (no userId) that fails
      // at the first factor — the response does not branch on account existence.
      const user = mock.findUserByEmail(identifier);
      const attempt = newAttempt('sign_in', {
        status: 'needs_first_factor',
        identifier,
        userId: user?.id ?? null,
      });
      return HttpResponse.json(presentSignInAttempt(mock, attempt), { status: 201 });
    }),

    // POST /v1/client/sign_ins/:id/prepare_first_factor — send a code / magic link.
    http.post(`${base}/v1/client/sign_ins/:id/prepare_first_factor`, async ({ request, params }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const attempt = mock.findAttempt(String(params.id));
      if (!attempt || attempt.kind !== 'sign_in') {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown sign-in attempt.'), { status: 404 });
      }
      const body = (await readJson(request)) as { strategy?: string };
      const strategy = body.strategy;
      if (strategy !== 'email_code' && strategy !== 'email_link' && strategy !== 'phone_code') {
        return HttpResponse.json(
          errorBody(
            'VALIDATION_FAILED',
            'Supported strategies are email_code, email_link and phone_code.',
            'strategy',
          ),
          { status: 400 },
        );
      }
      attempt.strategy = strategy;
      attempt.pendingCode = mock.instance.testOtp;
      attempt.pollSecret = `pol_${attempt.id}`;
      return HttpResponse.json({
        object: 'sign_in_attempt',
        id: attempt.id,
        status: attempt.status,
        strategy,
        poll_secret: attempt.pollSecret,
      });
    }),

    // POST /v1/client/sign_ins/:id/attempt_first_factor — present the factor.
    http.post(`${base}/v1/client/sign_ins/:id/attempt_first_factor`, async ({ request, params }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const attempt = mock.findAttempt(String(params.id));
      if (!attempt || attempt.kind !== 'sign_in') {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown sign-in attempt.'), { status: 404 });
      }
      const body = (await readJson(request)) as {
        strategy?: string;
        password?: string;
        code?: string;
      };
      const strategy = body.strategy;
      const user = attempt.userId ? mock.findUser(attempt.userId) : undefined;

      if (strategy === 'email_code' || strategy === 'phone_code') {
        if (!body.code) {
          return HttpResponse.json(errorBody('VALIDATION_FAILED', 'A code is required.', 'code'), {
            status: 400,
          });
        }
        if (!user || body.code !== (attempt.pendingCode ?? mock.instance.testOtp)) {
          return HttpResponse.json(
            errorBody('VERIFICATION_FAILED', 'That code is incorrect or has expired.', 'code'),
            { status: 400 },
          );
        }
        complete(attempt);
        return HttpResponse.json({ ...presentSignInAttempt(mock, attempt), ticket: attempt.ticket });
      }

      if (strategy !== 'password') {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'Unsupported first-factor strategy.', 'strategy'),
          { status: 400 },
        );
      }
      if (!body.password) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'A password is required.', 'password'),
          { status: 400 },
        );
      }
      // A wrong password — or an unknown identifier — fails identically (§13.2).
      if (!user || user.password == null || user.password !== body.password) {
        return HttpResponse.json(
          errorBody('VERIFICATION_FAILED', 'The credentials are incorrect.', 'password'),
          { status: 400 },
        );
      }
      complete(attempt);
      return HttpResponse.json({ ...presentSignInAttempt(mock, attempt), ticket: attempt.ticket });
    }),

    // GET /v1/client/sign_ins/:id — poll an attempt (needs the poll secret).
    http.get(`${base}/v1/client/sign_ins/:id`, ({ request, params }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const secret = new URL(request.url).searchParams.get('poll_secret');
      if (!secret) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'A poll_secret is required.', 'poll_secret'),
          { status: 400 },
        );
      }
      const attempt = mock.findAttempt(String(params.id));
      // A wrong secret is answered exactly like an unknown attempt.
      if (!attempt || attempt.kind !== 'sign_in' || attempt.pollSecret !== secret) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown sign-in attempt.'), { status: 404 });
      }
      if (attempt.status !== 'complete') {
        return HttpResponse.json(presentSignInAttempt(mock, attempt));
      }
      return HttpResponse.json({ ...presentSignInAttempt(mock, attempt), ticket: attempt.ticket });
    }),

    // POST /v1/client/sign_ups — start a sign-up.
    http.post(`${base}/v1/client/sign_ups`, async ({ request }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const body = (await readJson(request)) as { email?: string; password?: string };
      if (!body.email) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'An email address is required.', 'email'),
          { status: 400 },
        );
      }
      if (!body.password) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'A password is required.', 'password'),
          { status: 400 },
        );
      }
      const email = body.email.trim().toLowerCase();
      if (mock.findUserByEmail(email)) {
        return HttpResponse.json(
          errorBody('IDENTIFIER_EXISTS', 'That address is already in use.', 'email'),
          { status: 409 },
        );
      }
      // Create the (unverified) user now; completion is gated on verification.
      const user = mock.addUser({ email, emailVerified: false, password: body.password });
      const attempt = newAttempt('sign_up', {
        status: 'needs_email_verification',
        identifier: email,
        userId: user.id,
        strategy: 'email_code',
        pendingCode: mock.instance.testOtp,
      });
      return HttpResponse.json(presentSignUpAttempt(attempt), { status: 201 });
    }),

    // POST /v1/client/sign_ups/:id/prepare_verification — (re)send the code.
    http.post(`${base}/v1/client/sign_ups/:id/prepare_verification`, async ({ request, params }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const attempt = mock.findAttempt(String(params.id));
      if (!attempt || attempt.kind !== 'sign_up') {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown sign-up attempt.'), { status: 404 });
      }
      attempt.pendingCode = mock.instance.testOtp;
      return HttpResponse.json(presentSignUpAttempt(attempt));
    }),

    // POST /v1/client/sign_ups/:id/attempt_verification — present the code.
    http.post(`${base}/v1/client/sign_ups/:id/attempt_verification`, async ({ request, params }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const attempt = mock.findAttempt(String(params.id));
      if (!attempt || attempt.kind !== 'sign_up') {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown sign-up attempt.'), { status: 404 });
      }
      const body = (await readJson(request)) as { code?: string };
      if (!body.code) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'A verification code is required.', 'code'),
          { status: 400 },
        );
      }
      if (body.code !== (attempt.pendingCode ?? mock.instance.testOtp)) {
        return HttpResponse.json(
          errorBody('VERIFICATION_FAILED', 'That code is incorrect or has expired.', 'code'),
          { status: 400 },
        );
      }
      // Verify the address, then complete + mint a session (same as sign-in).
      const user = attempt.userId ? mock.findUser(attempt.userId) : undefined;
      if (user) {
        const primary = user.emails[0];
        if (primary) {
          primary.verified = true;
          user.primaryEmailId = primary.id;
        }
      }
      complete(attempt);
      return HttpResponse.json({ ...presentSignUpAttempt(attempt), ticket: attempt.ticket });
    }),

    // POST /v1/client/tickets/exchange — swap a completed attempt's ticket for a session.
    http.post(`${base}/v1/client/tickets/exchange`, async ({ request }) => {
      const guard = requirePublishableKey(request);
      if (guard) return guard;
      const body = (await readJson(request)) as { attempt_id?: string; ticket?: string };
      if (!body.attempt_id) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'An attempt_id is required.', 'attempt_id'),
          { status: 400 },
        );
      }
      if (!body.ticket) {
        return HttpResponse.json(errorBody('VALIDATION_FAILED', 'A ticket is required.', 'ticket'), {
          status: 400,
        });
      }
      const attempt = mock.findAttempt(body.attempt_id);
      if (
        !attempt ||
        attempt.status !== 'complete' ||
        !attempt.userId ||
        attempt.ticket !== body.ticket
      ) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'That sign-in attempt is not complete.', 'attempt_id'),
          { status: 400 },
        );
      }
      // One-time: burn the ticket so a replay fails.
      attempt.ticket = null;
      const session = attempt.sessionId ? mock.findSession(attempt.sessionId) : undefined;
      if (!session) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown session.'), { status: 404 });
      }
      mock.activeSessionId = session.id;
      return HttpResponse.json({
        object: 'session',
        id: session.id,
        jwt: session.jwt,
        expires_in: Math.round((session.expiresAt - now()) / 1000),
      });
    }),

    // GET /v1/client/me — the signed-in user (Bearer session jwt).
    http.get(`${base}/v1/client/me`, ({ request }) => {
      const header = request.headers.get('authorization');
      const jwt = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
      const session = jwt
        ? mock.sessionForJwt(jwt)
        : mock.activeSessionId
          ? mock.findSession(mock.activeSessionId)
          : undefined;
      if (!session || session.status !== 'active') {
        return HttpResponse.json(errorBody('UNAUTHENTICATED', 'Authentication required.'), {
          status: 401,
        });
      }
      const user = mock.findUser(session.userId);
      if (!user) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown user.'), { status: 404 });
      }
      return HttpResponse.json(presentMeUser(mock, user));
    }),

    // GET /.well-known/jwks.json — the token-verification key set.
    http.get(`${base}/.well-known/jwks.json`, () =>
      HttpResponse.json(mock.instance.jwks, {
        headers: { 'cache-control': 'public, max-age=3600, stale-if-error=86400' },
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// BAPI — the secret-key administrative surface.
// ---------------------------------------------------------------------------

function bapiHandlers(mock: AtlasMock, base: string): HttpHandler[] {
  /** Cursor pagination over an id-sorted (desc) list — the §9.1 envelope. */
  const paginate = <T extends { id: string }>(rows: T[], url: URL) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);
    const startingAfter = url.searchParams.get('starting_after');
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const filtered = startingAfter ? sorted.filter((r) => r.id < startingAfter) : sorted;
    const hasMore = filtered.length > limit;
    const page = hasMore ? filtered.slice(0, limit) : filtered;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null;
    return { page, hasMore, nextCursor };
  };

  return [
    // GET /v1/users — cursor-paginated list.
    http.get(`${base}/v1/users`, ({ request }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const live = mock.users.filter((u) => !u.deletedAt);
      const { page, hasMore, nextCursor } = paginate(live, new URL(request.url));
      return HttpResponse.json(listEnvelope(page.map(presentUser), hasMore, nextCursor));
    }),

    // POST /v1/users — create a user.
    http.post(`${base}/v1/users`, async ({ request }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const body = (await readJson(request)) as Record<string, unknown>;
      const rawEmail = Array.isArray(body.email_address)
        ? (body.email_address[0] as string | undefined)
        : (body.email_address as string | undefined);
      const email = rawEmail?.trim().toLowerCase();
      if (!email?.includes('@')) {
        return HttpResponse.json(
          errorBody('VALIDATION_FAILED', 'A valid email_address is required.', 'email_address'),
          { status: 400 },
        );
      }
      const emailVerified = body.email_verified === true;
      if (emailVerified && mock.findUserByEmail(email)) {
        return HttpResponse.json(
          errorBody('IDENTIFIER_EXISTS', 'That address is already in use.'),
          { status: 409 },
        );
      }
      const user = mock.addUser({
        email,
        emailVerified,
        password: typeof body.password === 'string' ? body.password : undefined,
        firstName: typeof body.first_name === 'string' ? body.first_name : undefined,
        lastName: typeof body.last_name === 'string' ? body.last_name : undefined,
        externalId: typeof body.external_id === 'string' ? body.external_id : undefined,
        publicMetadata: isRecord(body.public_metadata) ? body.public_metadata : undefined,
        privateMetadata: isRecord(body.private_metadata) ? body.private_metadata : undefined,
        unsafeMetadata: isRecord(body.unsafe_metadata) ? body.unsafe_metadata : undefined,
      });
      return HttpResponse.json(presentUser(user), { status: 201 });
    }),

    // GET /v1/users/:id — one user (404 for unknown / soft-deleted).
    http.get(`${base}/v1/users/:id`, ({ request, params }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const includeDeleted = new URL(request.url).searchParams.get('include_deleted') === 'true';
      const user = mock.findUser(String(params.id), includeDeleted);
      if (!user) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown user.'), { status: 404 });
      }
      return HttpResponse.json(presentUser(user));
    }),

    // PATCH /v1/users/:id — update profile / metadata.
    http.patch(`${base}/v1/users/:id`, async ({ request, params }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const user = mock.findUser(String(params.id));
      if (!user) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown user.'), { status: 404 });
      }
      const body = (await readJson(request)) as Record<string, unknown>;
      if ('first_name' in body) user.firstName = (body.first_name as string | null) ?? null;
      if ('last_name' in body) user.lastName = (body.last_name as string | null) ?? null;
      if (isRecord(body.public_metadata)) user.publicMetadata = body.public_metadata;
      if (isRecord(body.private_metadata)) user.privateMetadata = body.private_metadata;
      if ('external_id' in body) {
        const v = body.external_id;
        user.externalId = typeof v === 'string' && v.trim() ? v.trim() : null;
      }
      if (typeof body.password === 'string' && body.password.length > 0) user.password = body.password;
      user.updatedAt = Date.now();
      return HttpResponse.json(presentUser(user));
    }),

    // DELETE /v1/users/:id — soft delete.
    http.delete(`${base}/v1/users/:id`, ({ request, params }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const user = mock.findUser(String(params.id));
      if (!user) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown user.'), { status: 404 });
      }
      user.deletedAt = Date.now();
      return HttpResponse.json({ object: 'user', id: user.id, deleted: true });
    }),

    // GET /v1/organizations — cursor-paginated list.
    http.get(`${base}/v1/organizations`, ({ request }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const { page, hasMore, nextCursor } = paginate(mock.organizations, new URL(request.url));
      return HttpResponse.json(listEnvelope(page.map(presentOrganization), hasMore, nextCursor));
    }),

    // POST /v1/organizations — create.
    http.post(`${base}/v1/organizations`, async ({ request }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const body = (await readJson(request)) as Record<string, unknown>;
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return HttpResponse.json(errorBody('VALIDATION_FAILED', 'A name is required.', 'name'), {
          status: 400,
        });
      }
      const org = mock.addOrganization({
        name: body.name.trim(),
        slug: typeof body.slug === 'string' ? body.slug : undefined,
        createdBy: typeof body.created_by === 'string' ? body.created_by : undefined,
        maxAllowedMemberships:
          typeof body.max_allowed_memberships === 'number'
            ? body.max_allowed_memberships
            : undefined,
        publicMetadata: isRecord(body.public_metadata) ? body.public_metadata : undefined,
      });
      return HttpResponse.json(presentOrganization(org), { status: 201 });
    }),

    // GET /v1/organizations/:id — one organization.
    http.get(`${base}/v1/organizations/:id`, ({ request, params }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const org = mock.findOrganization(String(params.id));
      if (!org) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown organization.'), { status: 404 });
      }
      return HttpResponse.json(presentOrganization(org));
    }),

    // POST /v1/sessions — mint a session for a user (headless, in one call).
    http.post(`${base}/v1/sessions`, async ({ request }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const body = (await readJson(request)) as { user_id?: string; actor?: { sub?: string } };
      if (!body.user_id) {
        return HttpResponse.json(errorBody('VALIDATION_FAILED', 'A user_id is required.', 'user_id'), {
          status: 400,
        });
      }
      const user = mock.findUser(body.user_id);
      if (!user) {
        return HttpResponse.json(errorBody('VALIDATION_FAILED', 'Unknown user.', 'user_id'), {
          status: 400,
        });
      }
      if (user.banned) {
        return HttpResponse.json(errorBody('VALIDATION_FAILED', 'That user is banned.', 'user_id'), {
          status: 400,
        });
      }
      const actor =
        typeof body.actor?.sub === 'string' && body.actor.sub.trim() ? body.actor.sub.trim() : undefined;
      const session = mock.createSession(user.id, { impersonatedBy: actor });
      return HttpResponse.json(
        {
          object: 'session',
          id: session.id,
          user_id: user.id,
          jwt: session.jwt,
          refresh_token: session.refreshToken,
          expires_in: Math.round((session.expiresAt - Date.now()) / 1000),
          ...(actor ? { impersonated_by: actor } : {}),
        },
        { status: 201 },
      );
    }),

    // GET /v1/sessions/:id — one session (operator view).
    http.get(`${base}/v1/sessions/:id`, ({ request, params }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const session = mock.findSession(String(params.id));
      if (!session) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown session.'), { status: 404 });
      }
      return HttpResponse.json(presentSession(session));
    }),

    // POST /v1/sessions/:id/revoke — revoke a session.
    http.post(`${base}/v1/sessions/:id/revoke`, ({ request, params }) => {
      const guard = requireSecretKey(mock, request);
      if (guard) return guard;
      const session = mock.findSession(String(params.id));
      if (!session) {
        return HttpResponse.json(errorBody('NOT_FOUND', 'Unknown session.'), { status: 404 });
      }
      session.status = 'revoked';
      if (mock.activeSessionId === session.id) mock.activeSessionId = null;
      return HttpResponse.json({ object: 'session', id: session.id, status: 'revoked' });
    }),
  ];
}

// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
