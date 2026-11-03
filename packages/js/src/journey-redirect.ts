/**
 * The ticket exchange answers with `redirect_url` when the instance's sign-in
 * journey names where the user goes after signing in. Only an https URL is
 * honoured; anything else is ignored.
 */
export function journeyRedirectUrl(body: unknown): string | null {
  const url = body && typeof body === 'object' ? (body as { redirect_url?: unknown }).redirect_url : undefined;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Read `redirect_url` off a ticket-exchange Response without consuming it. */
export async function journeyRedirectFrom(response: Response | undefined | null): Promise<string | null> {
  if (!response || !response.ok) return null;
  try {
    return journeyRedirectUrl(await response.clone().json());
  } catch {
    return null;
  }
}
