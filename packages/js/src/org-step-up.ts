/**
 * Switching to an organization whose policy is `mfaEnforcement: "require_step_up"`
 * on a session without a recent enough second factor is refused with
 * `STEP_UP_REQUIRED` / reason `org_mfa_step_up_required`. The SDKs' `setActive`
 * throws an {@link OrgStepUpError} for it; the org switcher asks for an
 * authenticator code or a passkey ({@link runOrgStepUp}) and retries.
 */
import type { FapiClient } from './fapi';
import { getPasskeyAssertion, passkeysSupported } from './passkey';
import { stepUp } from './step-up';

export const ORG_STEP_UP_REASON = 'org_mfa_step_up_required';

export interface OrgStepUpError extends Error {
  code?: string;
  reason: typeof ORG_STEP_UP_REASON;
  /** The policy's accepted factor kinds (`totp`, `passkey`, ...); absent means any. */
  allowedFactors?: string[];
}

export function isOrgStepUpError(err: unknown): err is OrgStepUpError {
  return !!err && (err as { reason?: unknown }).reason === ORG_STEP_UP_REASON;
}

/** The error to throw for a refused set-active response, or null when it is some other refusal. */
export async function orgStepUpErrorFromResponse(response: Response): Promise<OrgStepUpError | null> {
  const body = (await response.json().catch(() => null)) as {
    errors?: Array<{ code?: string; reason?: string; message?: string; meta?: { allowed_factors?: unknown } }>;
  } | null;
  const first = body?.errors?.[0];
  if (first?.reason !== ORG_STEP_UP_REASON) return null;
  const allowed = first.meta?.allowed_factors;
  return Object.assign(new Error(first.message ?? 'A second factor is required.'), {
    code: first.code,
    reason: ORG_STEP_UP_REASON,
    ...(Array.isArray(allowed) ? { allowedFactors: allowed.filter((f): f is string => typeof f === 'string') } : {}),
  }) as OrgStepUpError;
}

/** Which prompts to offer: the code field unless totp is excluded, the passkey button when allowed and supported. */
export function orgStepUpOptions(err: OrgStepUpError, host?: unknown): { totp: boolean; passkey: boolean } {
  const allowed = err.allowedFactors;
  return {
    totp: !allowed || allowed.includes('totp'),
    passkey: (!allowed || allowed.includes('passkey')) && passkeysSupported(host),
  };
}

/** Step up with an authenticator code or a passkey. Resolves to an error message on failure. */
export async function runOrgStepUp(
  client: FapiClient,
  input: { code: string } | { passkey: true },
  fallbackMessage = 'Verification failed.',
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if ('code' in input) {
      const res = await stepUp(client, { strategy: 'totp', code: input.code });
      return res.ok ? { ok: true } : { ok: false, message: res.errors[0]?.message ?? fallbackMessage };
    }
    const begin = await client.post<Record<string, unknown>>('/v1/client/me/step_up/passkey', {});
    if (!begin.ok || !begin.data) return { ok: false, message: begin.errors[0]?.message ?? fallbackMessage };
    const { handle: _handle, ...assertion } = await getPasskeyAssertion(begin.data);
    const res = await stepUp(client, { strategy: 'passkey', ...assertion });
    return res.ok ? { ok: true } : { ok: false, message: res.errors[0]?.message ?? fallbackMessage };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : fallbackMessage };
  }
}

/**
 * `setActive(id)`, and when it needs a step-up resolve to that error instead of
 * throwing (the caller shows the prompt, then calls this again). Other errors rethrow.
 */
export async function activateOrgOrStepUp(
  setActive: (id: string | null) => Promise<void>,
  id: string | null,
): Promise<OrgStepUpError | null> {
  try {
    await setActive(id);
    return null;
  } catch (err) {
    if (isOrgStepUpError(err)) return err;
    throw err;
  }
}
