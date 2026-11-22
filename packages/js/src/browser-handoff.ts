import type { FapiClient } from './fapi';

/**
 * Open a signed-in browser from a signed-in app. Returns a one-time link that redeems a short-lived ticket and lands on
 * `redirectUrl` (one of the application's allowed origins), where the browser SDK turns it into the browser's own
 * session. Needs the user's own session, a recent sign-in, and `session.browserHandoff` turned on for the application.
 * Resolves null when refused; the response errors say why (not enabled, step-up needed, origin not allowed).
 */
export async function createBrowserHandoff(
  client: FapiClient,
  input: { redirectUrl: string; ttlSeconds?: number },
): Promise<{ url: string; expiresAt: string } | null> {
  const response = await client.post<{ url?: string; expires_at?: string }>('/v1/client/me/browser_handoff', {
    redirect_url: input.redirectUrl,
    ...(input.ttlSeconds !== undefined ? { ttl_seconds: input.ttlSeconds } : {}),
  });
  const d = response.data;
  return response.ok && d?.url && d.expires_at ? { url: d.url, expiresAt: d.expires_at } : null;
}
