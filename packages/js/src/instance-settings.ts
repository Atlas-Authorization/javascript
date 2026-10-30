import type { CaptchaFlowKey, FlowCaptcha } from './captcha-widget';
import { accountUxFrom, emailDeliveryFrom, type AccountUx, type EmailDelivery } from './environment';
import type { FapiClient } from './fapi';
import { referralChallengeRequired } from './referral';

/**
 * The instance's public sign-in / sign-up settings, read from
 * `GET /v1/appearance`. Public data only — the captcha provider + site key +
 * render mode per flow, the extra fields the create-account form collects, and
 * the legal-consent policy. The prebuilt sign-in / sign-up components of every
 * framework SDK read it so that turning a setting on in the dashboard (e.g.
 * captcha on sign-up) takes effect with no code change.
 */
export interface InstanceSettings {
  /** Per-flow captcha (`{ enabled: false }` when a flow draws nothing). */
  captchaFlows: Partial<Record<CaptchaFlowKey, FlowCaptcha>>;
  /** Extra fields the create-account form collects, in display order. */
  signUpFields: PublicSignUpField[];
  /** Terms / privacy links and whether agreement is required on sign-up. */
  legal: { termsUrl: string | null; privacyUrl: string | null; required: boolean };
  /**
   * Whether the app can deliver email, and what that allows: hide "Forgot
   * password?" when `passwordReset` is false, email code / link options when
   * `available` is false, and show a "can't send email" state instead of the
   * password sign-up form when `passwordSignUp` is false. All true on an older
   * server that does not say.
   */
  emailDelivery: EmailDelivery;
  /**
   * The username rule (null while usernames are off), whether "Last used"
   * badges are shown, and code-vs-link email proofs. When usernames are on, a
   * `username` entry is already in {@link signUpFields}.
   */
  account: AccountUx;
  /**
   * "Sign in with Atlas" when the instance has it on (`sign_in_with_atlas` in
   * `/v1/appearance`): the SSO connection a "Continue with Atlas" button starts
   * with {@link startSignInWithAtlas}. Absent when it is off.
   */
  signInWithAtlas?: { connectionId: string };
  /**
   * Passkey sign-in is on (`strategies.passkey`): the sign-in form offers
   * "Sign in with a passkey" and passkey autofill on the identifier field, where
   * the browser supports WebAuthn. False on an older server that does not say.
   */
  passkeySignIn?: boolean;
}

/** One configurable sign-up field, exactly as `/v1/appearance` resolves it. */
export interface PublicSignUpField {
  key: string;
  label: string;
  type:
    | 'text'
    | 'email'
    | 'tel'
    | 'url'
    | 'number'
    | 'date'
    | 'textarea'
    | 'checkbox'
    | 'select'
    | 'radio'
    | 'multiselect';
  required: boolean;
  placeholder: string | null;
  options: string[];
  builtin: boolean;
}

const NO_LEGAL: InstanceSettings['legal'] = { termsUrl: null, privacyUrl: null, required: false };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read the settings out of a `/v1/appearance` body. Defensive: an older server
 * (no `captchaFlows`) or a malformed body yields empty settings, so the
 * components behave exactly as they did before these settings existed.
 */
export function instanceSettingsFrom(body: unknown): InstanceSettings {
  const root = isRecord(body) ? body : {};
  const appearance = isRecord(root.appearance) ? root.appearance : {};

  const captchaFlows: InstanceSettings['captchaFlows'] = {};
  if (isRecord(root.captchaFlows)) {
    for (const key of ['signUp', 'signIn', 'guest', 'passwordReset'] as const) {
      const flow = root.captchaFlows[key];
      if (!isRecord(flow)) continue;
      captchaFlows[key] = {
        enabled: flow.enabled === true,
        ...(typeof flow.provider === 'string' ? { provider: flow.provider } : {}),
        ...(typeof flow.siteKey === 'string' ? { siteKey: flow.siteKey } : {}),
        ...(flow.widget === 'invisible' || flow.widget === 'managed' || flow.widget === 'visible'
          ? { widget: flow.widget }
          : {}),
        // Atlas's own captcha: where to fetch each challenge.
        ...(typeof flow.challengeUrl === 'string' && /^https?:\/\//.test(flow.challengeUrl)
          ? { challengeUrl: flow.challengeUrl }
          : {}),
      };
    }
  }

  const signUpFields = Array.isArray(appearance.signUpFields)
    ? (appearance.signUpFields.filter(
        (f) => isRecord(f) && typeof f.key === 'string' && typeof f.label === 'string',
      ) as PublicSignUpField[])
    : [];

  const legalRaw = isRecord(appearance.legal) ? appearance.legal : null;
  const legal = legalRaw
    ? {
        termsUrl: typeof legalRaw.termsUrl === 'string' ? legalRaw.termsUrl : null,
        privacyUrl: typeof legalRaw.privacyUrl === 'string' ? legalRaw.privacyUrl : null,
        required: legalRaw.required === true,
      }
    : NO_LEGAL;

  const account = accountUxFrom(root);
  // Usernames on: the create-account form collects one, drawn as the first
  // extra field (keyed `username` — the server takes it as the username).
  if (account.username && !signUpFields.some((f) => f.key === 'username')) {
    signUpFields.unshift({
      key: 'username',
      label: 'Username',
      type: 'text',
      required: account.username.requiredAtSignUp,
      placeholder: null,
      options: [],
      builtin: true,
    });
  }

  const strategies = isRecord(root.strategies) ? root.strategies : {};
  const atlas = isRecord(root.sign_in_with_atlas) ? root.sign_in_with_atlas : null;
  const signInWithAtlas =
    atlas && atlas.enabled === true && typeof atlas.connection_id === 'string' && atlas.connection_id
      ? { connectionId: atlas.connection_id }
      : undefined;

  return {
    captchaFlows,
    signUpFields,
    legal,
    emailDelivery: emailDeliveryFrom(root),
    account,
    passkeySignIn: strategies.passkey === true,
    ...(signInWithAtlas ? { signInWithAtlas } : {}),
  };
}

/**
 * Start "Sign in with Atlas": `POST /v1/client/sign_ins/sso` for the instance's
 * Atlas connection, returning the authorization URL to send the browser to (it
 * comes back to `redirectUrl` signed in). Resolves `{ error }` with the server's
 * message when it cannot start.
 */
export async function startSignInWithAtlas(
  client: FapiClient,
  connectionId: string,
  redirectUrl: string,
): Promise<{ url: string } | { error: string }> {
  try {
    const res = await client.post<{ authorization_url?: string }>('/v1/client/sign_ins/sso', {
      connection_id: connectionId,
      redirect_url: redirectUrl,
    });
    const url = res.data?.authorization_url;
    if (res.ok && url) return { url };
    return { error: res.errors?.[0]?.message ?? 'Could not start Sign in with Atlas.' };
  } catch {
    return { error: 'Could not start Sign in with Atlas.' };
  }
}

/**
 * Fetch the instance's public settings (`GET /v1/appearance`). Null when the
 * server can't be reached or answers with an error — the components then fall
 * back to their defaults, and the server still enforces every gate.
 */
export async function fetchInstanceSettings(client: FapiClient): Promise<InstanceSettings | null> {
  try {
    const response = await client.get<unknown>('/v1/appearance');
    if (!response.ok) return null;
    const settings = instanceSettingsFrom(response.data);
    return (await referralChallengeRequired(client)) ? withReferralChallenge(settings) : settings;
  } catch {
    return null;
  }
}

/**
 * Split a create-account form's values into the `startSignUp` input: `email` and
 * `password` are the credentials, everything else is a configured sign-up field
 * (blank optional fields are dropped, so the server never sees empty strings).
 * `consent` is the legal-consent tick (send `true` when no agreement is
 * required — the server only enforces it when the instance opts in).
 */
export function toSignUpInput(
  values: Record<string, string>,
  consent: boolean,
  captchaToken?: string | null,
): {
  email: string;
  password: string;
  fields: Record<string, string>;
  consent: boolean;
  captchaToken?: string;
} {
  const { email = '', password = '', ...rest } = values;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) if (value) fields[key] = value;
  return { email, password, fields, consent, ...(captchaToken ? { captchaToken } : {}) };
}

/**
 * Referral attribution: the instance requires the bot challenge for a sign-up
 * that carries a referral code, and one was captured on this page. The sign-up
 * form and the sign-in identifier step (a passwordless sign-in to a new
 * address creates the account) then always show the captcha, even when it is
 * otherwise off, as long as the instance has a provider to draw. The server
 * enforces the same rule.
 */
export function withReferralChallenge(settings: InstanceSettings): InstanceSettings {
  return { ...settings, captchaFlows: referralChallengeFlows(settings.captchaFlows) };
}

/** {@link withReferralChallenge} on a bare `captchaFlows` map. */
export function referralChallengeFlows(
  flows: Partial<Record<CaptchaFlowKey, FlowCaptcha>>,
): Partial<Record<CaptchaFlowKey, FlowCaptcha>> {
  const out = { ...flows };
  for (const key of ['signUp', 'signIn'] as const) {
    const flow = out[key];
    if (flow && flow.provider && !flow.enabled) out[key] = { ...flow, enabled: true };
  }
  return out;
}
