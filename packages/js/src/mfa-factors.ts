/**
 * The additional authentication factors, client half: counter-based tokens (HOTP), YubiKeys
 * (Yubico OTP), Duo, security questions for password reset, and smart card sign-in. The
 * signed-in calls below need a recent sign-in (the same step-up gate as every 2FA change).
 *
 * HOTP and Yubico OTP codes are typed into the ordinary second-factor `code` field at
 * sign-in, so they need no extra call there. Duo is a redirect: see {@link prepareDuo}.
 */
import type { FapiClient, FapiResponse } from './fapi';

interface EnrolledFactor {
  object: 'mfa_factor';
  id: string;
  type: string;
  verified: boolean;
  backup_codes?: string[];
}

export interface HotpEnrollment extends EnrolledFactor {
  /** The base32 secret, shown once. Program it into the token or app. */
  secret: string;
  /** The `otpauth://hotp/` URI (for a QR code). */
  uri: string;
  digits: number;
}

/** Start HOTP enrolment: returns the secret and URI once. Confirm with {@link verifyHotp}. */
export function startHotp(client: FapiClient): Promise<FapiResponse<HotpEnrollment>> {
  return client.post<HotpEnrollment>('/v1/client/me/mfa/hotp');
}

/** Confirm HOTP enrolment with the token's next code; the response carries the recovery codes once. */
export function verifyHotp(client: FapiClient, factorId: string, code: string): Promise<FapiResponse<EnrolledFactor>> {
  return client.post<EnrolledFactor>(`/v1/client/me/mfa/hotp/${encodeURIComponent(factorId)}/verify`, { code });
}

/** Re-synchronise a token whose counter ran far ahead, from two consecutive codes. */
export function resyncHotp(client: FapiClient, factorId: string, codes: [string, string]): Promise<FapiResponse<{ resynced: true }>> {
  return client.post<{ resynced: true }>(`/v1/client/me/mfa/hotp/${encodeURIComponent(factorId)}/resync`, { codes });
}

/** Enrol a YubiKey: the user touches the key into a field and you pass the typed OTP. */
export function enrollYubikey(client: FapiClient, otp: string): Promise<FapiResponse<EnrolledFactor & { public_id: string }>> {
  return client.post(`/v1/client/me/mfa/yubikey`, { otp });
}

/** A string a YubiKey could have typed (modhex, 32 to 48 characters). Handy to route a field's input. */
export const looksLikeYubicoOtp = (value: string): boolean => /^[cbdefghijklnrtuv]{32,48}$/i.test(value.trim());

export interface DuoPrompt {
  /** Send the browser here. Duo returns it to the Frontend API, then to `returnUrl` when given. */
  authorizationUrl: string;
}

/** Begin Duo enrolment. After the redirect back, call {@link finishDuoEnrollment} with the returned `factorId`. */
export function startDuoEnrollment(
  client: FapiClient,
  opts: { returnUrl?: string } = {},
): Promise<FapiResponse<EnrolledFactor & { authorization_url: string }>> {
  return client.post<EnrolledFactor & { authorization_url: string }>('/v1/client/me/mfa/duo', opts.returnUrl ? { return_url: opts.returnUrl } : {});
}

/** Complete Duo enrolment after the user approved Duo's prompt. Answers 400 until Duo has confirmed. */
export function finishDuoEnrollment(client: FapiClient, factorId: string): Promise<FapiResponse<EnrolledFactor>> {
  return client.post<EnrolledFactor>(`/v1/client/me/mfa/duo/${encodeURIComponent(factorId)}/verify`);
}

/** At the second-factor step: get Duo's authorization URL for this sign-in attempt. */
export async function prepareDuo(
  client: FapiClient,
  attemptId: string,
  opts: { returnUrl?: string } = {},
): Promise<{ prompt: DuoPrompt | null; response: FapiResponse<{ authorization_url: string }> }> {
  const response = await client.post<{ authorization_url: string }>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_second_factor`,
    { strategy: 'duo', ...(opts.returnUrl ? { return_url: opts.returnUrl } : {}) },
  );
  return { prompt: response.ok && response.data ? { authorizationUrl: response.data.authorization_url } : null, response };
}

/**
 * Poll the sign-in after sending the user to Duo. Returns the attempt as it stands: the
 * status stays `needs_second_factor` until Duo's callback has recorded an approval for this
 * attempt, then `complete`.
 */
export function pollDuo(client: FapiClient, attemptId: string): Promise<FapiResponse<Record<string, unknown>>> {
  return client.post(`/v1/client/sign_ins/${encodeURIComponent(attemptId)}/attempt_second_factor`, { strategy: 'duo' });
}

export interface SecurityQuestions {
  enabled: boolean;
  /** How many questions the user answers. */
  required: number;
  availableQuestions: string[];
  /** The questions the user chose (never the answers). */
  answeredQuestions: string[];
}

interface SecurityQuestionsWire {
  enabled: boolean;
  required: number;
  available_questions: string[];
  answered_questions: string[];
}

const questionsFrom = (w: SecurityQuestionsWire): SecurityQuestions => ({
  enabled: w.enabled,
  required: w.required,
  availableQuestions: w.available_questions,
  answeredQuestions: w.answered_questions,
});

/** The offered questions and the signed-in user's chosen ones. */
export async function getSecurityQuestions(client: FapiClient): Promise<SecurityQuestions | null> {
  const res = await client.get<SecurityQuestionsWire>('/v1/client/me/security_questions');
  return res.ok && res.data ? questionsFrom(res.data) : null;
}

/** Set (replace) the answers. `answers` has exactly `required` distinct questions from the offered list. */
export async function setSecurityQuestions(
  client: FapiClient,
  answers: Array<{ question: string; answer: string }>,
): Promise<{ questions: SecurityQuestions | null; response: FapiResponse<SecurityQuestionsWire> }> {
  const response = await client.request<SecurityQuestionsWire>('/v1/client/me/security_questions', {
    method: 'PUT',
    body: JSON.stringify({ answers }),
  });
  return { questions: response.ok && response.data ? questionsFrom(response.data) : null, response };
}

export function removeSecurityQuestions(client: FapiClient): Promise<FapiResponse<{ deleted: boolean }>> {
  return client.request('/v1/client/me/security_questions', { method: 'DELETE' });
}

/**
 * During a password reset, once the emailed code (and any second factor) is accepted: the
 * questions the user must answer before choosing a password. Send the answers as
 * `security_answers` with `set_new_password`.
 */
export async function getResetSecurityQuestions(client: FapiClient, resetId: string): Promise<{ required: boolean; questions: string[] } | null> {
  const res = await client.get<{ required: boolean; questions: string[] }>(`/v1/client/password_resets/${encodeURIComponent(resetId)}/security_questions`);
  return res.ok && res.data ? { required: res.data.required, questions: res.data.questions } : null;
}

/**
 * Smart card / PIV / CAC sign-in. The browser presents the card's certificate in the TLS
 * handshake to a Frontend API host that requests client certificates; your proxy forwards the
 * result and Atlas signs the user in. Resolves like a passkey sign-in: a completed attempt
 * (`status: "complete"`, with the session set), or `needs_second_factor` when the account's
 * MFA is still owed.
 */
export function signInWithSmartCard(client: FapiClient): Promise<FapiResponse<Record<string, unknown>>> {
  return client.post<Record<string, unknown>>('/v1/client/sign_ins/smart_card');
}
