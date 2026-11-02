import { DEFAULT_API_URL } from '@atlasauth/backend';
import { AtlasSignInError } from './sign-in-as';

/**
 * A session token for a test user, for end-to-end tests that need a bearer
 * token rather than a browser session (the referral panel's widget, an API
 * under test). `POST /v1/sessions` with a secret key mints a real session.
 *
 * DEVELOPMENT instances only: a production secret key (`sk_live_…`) is refused
 * here before any request is made. Throws on failure, like {@link getSignInUrl}.
 */
export interface GetSessionTokenOptions {
  /** A development instance secret key (`sk_test_...`). */
  secretKey: string;
  /** The user to mint for. One of `userId` or `email` is required. */
  userId?: string;
  /** Resolve the user by (exact, case-insensitive) email address. */
  email?: string;
  /** Per-session data to attach (at most 2 KB). */
  customData?: Record<string, unknown>;
  /** @default `https://api.atlasauth.net` */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function getSessionToken(options: GetSessionTokenOptions): Promise<{ jwt: string; sessionId: string }> {
  if (!options.secretKey) throw new AtlasSignInError('A secret key is required.', 0);
  if (options.secretKey.startsWith('sk_live_')) {
    throw new AtlasSignInError('getSessionToken only works on development instances; refusing a production secret key.', 0, 'production_refused');
  }
  if (!options.userId && !options.email) throw new AtlasSignInError('A userId or an email is required.', 0);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.secretKey}`, 'content-type': 'application/json', accept: 'application/json' };
  const fail = (what: string, status: number, data: { errors?: Array<{ code?: string; message?: string }> } | null): never => {
    const err = data?.errors?.[0];
    throw new AtlasSignInError(`Could not ${what} (${status}${err?.code ? ` ${err.code}` : ''}): ${err?.message ?? 'unexpected response'}`, status, err?.code);
  };

  let userId = options.userId;
  if (!userId) {
    const res = await fetchImpl(`${base}/v1/users?email_address=${encodeURIComponent(options.email!)}&limit=2`, { headers });
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }>; errors?: never } | null;
    if (!res.ok) return fail('look the user up', res.status, body);
    if (body?.data?.length !== 1 || typeof body.data[0]?.id !== 'string') {
      throw new AtlasSignInError(`Expected exactly one user with email ${options.email}, found ${body?.data?.length ?? 0}.`, 404, 'user_not_found');
    }
    userId = body.data[0].id;
  }

  const res = await fetchImpl(`${base}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_id: userId, ...(options.customData ? { custom_data: options.customData } : {}) }),
  });
  const data = (await res.json().catch(() => null)) as { id?: unknown; jwt?: unknown; errors?: Array<{ code?: string; message?: string }> } | null;
  if (!res.ok || typeof data?.jwt !== 'string' || typeof data.id !== 'string') return fail('mint a session token', res.status, data);
  return { jwt: data.jwt, sessionId: data.id };
}
