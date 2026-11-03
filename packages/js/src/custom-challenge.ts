import type { FapiClient } from './fapi';

/**
 * The application's own second factor (a question, a code sent elsewhere, an
 * identity check): ask Atlas to run the application's challenge for this
 * sign-in attempt, show the prompt, then submit the answer as the attempt's
 * `code` with `strategy: 'custom_challenge'` (e.g. `submit({ code, strategy:
 * 'custom_challenge' })`). Offered when `account.customSecondFactor` is true.
 */
export async function prepareCustomChallenge(
  client: FapiClient,
  attemptId: string,
): Promise<{ prompt: string; hint: string | null; expiresAt: number }> {
  const response = await client.post<{ prompt?: unknown; hint?: unknown; expires_at?: unknown }>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_second_factor`,
    { strategy: 'custom_challenge' },
  );
  if (!response.ok) {
    const first = response.errors[0];
    const error = new Error(first?.message ?? 'Could not start the challenge.') as Error & { code?: string };
    if (first?.code) error.code = first.code;
    throw error;
  }
  const d = response.data;
  return {
    prompt: typeof d?.prompt === 'string' ? d.prompt : '',
    hint: typeof d?.hint === 'string' ? d.hint : null,
    expiresAt: typeof d?.expires_at === 'number' ? d.expires_at : 0,
  };
}
