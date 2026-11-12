/**
 * Headless sign-in and sign-up: one typed step at a time, no UI.
 *
 * `createSignInFlow()` / `createSignUpFlow()` wrap the same requests the
 * prebuilt components send. You render whatever the current `step` asks for and
 * call the matching method; the flow never decides the next step itself, the
 * server does. Captcha is handled for you: when the server asks for one the step
 * is `needs_captcha`, and `solveCaptcha(container)` draws the widget for the
 * right flow and submits its token.
 *
 * Errors carry a stable `reason` (`form_password_incorrect`, `captcha_wrong_flow`,
 * …). Turn it into a sentence in the app's language with `reasonMessage`.
 */
import { nextStep, type AttemptView, type FieldError, type PendingPolicy, type PendingRequiredAction, type ProfileCompletionField } from './attempt';
import { fetchInstanceSettings, type InstanceSettings } from './instance-settings';
import { acknowledgeRecoveryCodes, mfaChoicesFrom, pendingRecoveryCodes, prepareMfaEnrollment, type MfaEnrollment } from './mfa-enrollment';
import { acceptAttemptPolicies, type PolicyAcceptance } from './policies';
import { signInWithPasskey } from './passkey-sign-in';
import { startOauthRedirect } from './redirect';
import { renderCaptchaWidget, type CaptchaFlowKey, type FlowCaptcha } from './captcha-widget';
import {
  advance,
  prepareFactor,
  completeRequiredAction,
  startSignUp,
  resendSignUpVerification,
  initialFlow,
  type FapiClient,
  type FlowState,
} from './fapi';

/** The second factors a headless flow can set up mid-sign-in: an authenticator app, or texted codes. */
export type EnrollableMethod = 'totp' | 'phone_code';

/** What a `needs_required_action` step asks for, by kind. Submit it with the method named on each. */
export type RequiredActionStep =
  /** `updatePassword(password)`. */
  | { kind: 'update_password' }
  /** `sendEmailVerification()`, then `submitEmailVerificationCode(code)`. */
  | { kind: 'verify_email' }
  /** `updateProfile({ firstName, lastName, username })`. */
  | { kind: 'update_profile' }
  /** Progressive profiling: `submitRequiredFields(values)`, or `submitRequiredFields({}, { skip: true })` when every field is optional. */
  | { kind: 'complete_profile'; fields: ProfileCompletionField[] }
  /** A server-driven form: `submitRequiredFields(values)`. */
  | { kind: 'journey_form'; title: string | null; intro: string | null; fields: ProfileCompletionField[] }
  /** `startIdentityVerification()`, send the person to `url`, then `checkIdentityVerification()`. */
  | { kind: 'identity_verification'; url: string | null; status: string | null }
  /** The application closes it: send the person to `url`; nothing to submit here. */
  | { kind: 'custom'; url: string | null };

/** Second-factor strategies the server accepts. Not narrowed per account: that would reveal what the account has. */
export const SECOND_FACTOR_STRATEGIES = ['totp', 'backup_code', 'sms', 'email_code'] as const;

export type FlowStep =
  | { type: 'needs_identifier' }
  | { type: 'needs_captcha'; flow: CaptchaFlowKey; captcha: FlowCaptcha | null }
  | { type: 'needs_first_factor'; factors: string[] }
  | { type: 'needs_second_factor'; factors: string[] }
  | { type: 'needs_policy_acceptance'; policies: PendingPolicy[] }
  | { type: 'needs_email_verification' }
  /**
   * The account must set up a second factor to finish signing in. Call `startTotpEnrollment()` (then show `enrollment.secret` /
   * `enrollment.uri` as a QR code) or `sendEnrollmentPhone(phone)`, then `submitEnrollmentCode(code)`.
   */
  | { type: 'needs_mfa_enrollment'; methods: EnrollableMethod[]; /** Authenticator codes to ask for (1 or 2). */ totpCodes: 1 | 2; enrollment: MfaEnrollment | null }
  /** Enrolment finished: show these recovery codes once, then call `acknowledgeRecoveryCodes()`. The session already exists. */
  | { type: 'show_recovery_codes'; codes: string[] }
  /** The user owes one action before the session is issued; `remaining` counts the others behind it. */
  | { type: 'needs_required_action'; action: RequiredActionStep; remaining: number }
  /** Send the browser to `url` (OAuth); it comes back signed in. */
  | { type: 'redirect'; url: string }
  /** A step this flow does not drive (an unknown status, a second factor other than an authenticator app or texts, an action kind this SDK does not know): hand over to the prebuilt component. */
  | { type: 'needs_other'; status: string }
  | { type: 'complete'; sessionId: string | null };

export interface FlowSnapshot {
  step: FlowStep;
  /** The errors of the last call. Each has a stable `reason`. */
  errors: FieldError[];
  /** The first error's stable reason, or the captcha refusal's. */
  reason: string | null;
  busy: boolean;
}

export interface FlowOptions {
  client: FapiClient;
}

interface Core {
  /** The current step, errors and busy flag. */
  getSnapshot(): FlowSnapshot;
  subscribe(listener: (snapshot: FlowSnapshot) => void): () => void;
  /** Draw the captcha widget for this flow into `container`, then submit its token. */
  solveCaptcha(container: HTMLElement): Promise<FlowSnapshot>;
  /** Submit a captcha token you obtained yourself. */
  submitCaptcha(token: string): Promise<FlowSnapshot>;
  /** Send the browser to a social provider; the step becomes `redirect`. */
  startOAuth(provider: string, redirectUrl: string): Promise<FlowSnapshot>;
  /** Accept the policies a `needs_policy_acceptance` step lists. */
  acceptPolicies(acceptances: PolicyAcceptance[]): Promise<FlowSnapshot>;
  /** Forget everything and go back to the first step. */
  reset(): FlowSnapshot;
}

/** The typed step for the first owed action, or null for a kind this SDK does not know. */
function requiredActionStep(a: PendingRequiredAction, iv: AttemptView['identity_verification']): RequiredActionStep | null {
  switch (a.action) {
    case 'update_password':
    case 'verify_email':
    case 'update_profile':
      return { kind: a.action };
    case 'complete_profile':
      return { kind: 'complete_profile', fields: a.fields ?? [] };
    case 'journey_form':
      return { kind: 'journey_form', title: a.title ?? null, intro: a.intro ?? null, fields: a.fields ?? [] };
    case 'identity_verification':
      return { kind: 'identity_verification', url: iv?.url ?? a.url, status: iv?.status ?? null };
    case 'custom':
      return { kind: 'custom', url: a.url };
    default:
      return null;
  }
}

const CAPTCHA_CODES = ['CAPTCHA_REQUIRED', 'CAPTCHA_FAILED'];

function makeCore(opts: FlowOptions, captchaFlow: CaptchaFlowKey) {
  const { client } = opts;
  let flow: FlowState = initialFlow;
  let step: FlowStep = { type: 'needs_identifier' };
  let busy = false;
  let errors: FieldError[] = [];
  let reason: string | null = null;
  let captchaToken: string | null = null;
  let captchaSettings: FlowCaptcha | null | undefined;
  let settings: InstanceSettings | null | undefined;
  let enrollment: MfaEnrollment | null = null;
  let redirect: string | null = null;
  const listeners = new Set<(s: FlowSnapshot) => void>();

  const snapshot = (): FlowSnapshot => ({ step, errors, reason, busy });
  const emit = () => {
    const s = snapshot();
    for (const l of listeners) l(s);
    return s;
  };

  const loadSettings = async () => {
    if (settings === undefined) settings = await fetchInstanceSettings(client);
    return settings;
  };

  const loadCaptcha = async (): Promise<FlowCaptcha | null> => {
    if (captchaSettings === undefined) {
      captchaSettings = (await loadSettings())?.captchaFlows[captchaFlow] ?? null;
    }
    return captchaSettings;
  };

  const stepFor = async (attempt: AttemptView | null): Promise<FlowStep> => {
    if (redirect) return { type: 'redirect', url: redirect };
    if (!attempt) return { type: 'needs_identifier' };
    const next = nextStep(attempt);
    switch (next.kind) {
      case 'collect_identifier':
      case 'restart':
        return { type: 'needs_identifier' };
      case 'collect_captcha':
        return { type: 'needs_captcha', flow: captchaFlow, captcha: await loadCaptcha() };
      case 'collect_first_factor':
        return { type: 'needs_first_factor', factors: next.strategies };
      case 'collect_second_factor':
        return { type: 'needs_second_factor', factors: [...SECOND_FACTOR_STRATEGIES] };
      case 'accept_policies':
        return { type: 'needs_policy_acceptance', policies: next.policies };
      case 'collect_email_code':
        return { type: 'needs_email_verification' };
      case 'done': {
        const codes = pendingRecoveryCodes(flow);
        return codes ? { type: 'show_recovery_codes', codes } : { type: 'complete', sessionId: next.sessionId };
      }
      case 'enroll_second_factor': {
        const choices = mfaChoicesFrom((await loadSettings())?.account);
        const methods: EnrollableMethod[] = [...(choices.totp ? (['totp'] as const) : []), ...(choices.sms ? (['phone_code'] as const) : [])];
        if (!methods.length) return { type: 'needs_other', status: attempt.status };
        return { type: 'needs_mfa_enrollment', methods, totpCodes: choices.totpCodes, enrollment };
      }
      case 'complete_required_action': {
        const [owed, ...rest] = next.actions;
        const action = owed && requiredActionStep(owed, attempt.identity_verification);
        return action ? { type: 'needs_required_action', action, remaining: rest.length } : { type: 'needs_other', status: attempt.status };
      }
      case 'await_oauth':
      case 'collect_new_password':
      case 'unknown':
        return { type: 'needs_other', status: attempt.status };
    }
  };

  /** Run one call, fold its resulting FlowState in, exchange a completion ticket, and publish. */
  const run = async (call: () => Promise<FlowState>): Promise<FlowSnapshot> => {
    busy = true;
    emit();
    let next = await call();
    if (next.ticket && next.attempt?.id) {
      const exchanged = await client.post('/v1/client/tickets/exchange', { attempt_id: next.attempt.id, ticket: next.ticket });
      next = exchanged.ok ? { ...next, ticket: null } : { ...next, errors: exchanged.errors };
    }
    flow = next;
    errors = next.errors;
    reason = errors[0]?.reason ?? next.attempt?.reason ?? null;
    busy = false;
    step = await stepFor(next.attempt);
    return emit();
  };

  /** A captcha error on a call that has no attempt yet becomes the captcha step. */
  const captchaStepFromErrors = async (): Promise<boolean> => {
    if (!errors.some((e) => CAPTCHA_CODES.includes(e.code))) return false;
    step = { type: 'needs_captcha', flow: captchaFlow, captcha: await loadCaptcha() };
    emit();
    return true;
  };

  return {
    get flow() { return flow; },
    get enrollment() { return enrollment; },
    set enrollment(e: MfaEnrollment | null) { enrollment = e; },
    acknowledgeCodes() {
      flow = acknowledgeRecoveryCodes(flow);
      return stepFor(flow.attempt).then((s) => { step = s; return emit(); });
    },
    get captchaToken() { return captchaToken; },
    takeCaptchaToken() { const t = captchaToken; captchaToken = null; return t; },
    setCaptchaToken(t: string) { captchaToken = t; },
    get errors() { return errors; },
    run,
    captchaStepFromErrors,
    setRedirect(url: string) { redirect = url; },
    api(extra: { submitCaptcha(token: string): Promise<FlowSnapshot> }): Core {
      return {
        getSnapshot: snapshot,
        subscribe(l) { listeners.add(l); return () => void listeners.delete(l); },
        submitCaptcha: extra.submitCaptcha,
        async solveCaptcha(container) {
          const settings = await loadCaptcha();
          if (!settings) {
            errors = [{ code: 'CAPTCHA_UNAVAILABLE', reason: 'captcha_unavailable', message: 'No captcha is configured for this flow.' }];
            reason = 'captcha_unavailable';
            return emit();
          }
          try {
            return await extra.submitCaptcha(await renderCaptchaWidget(settings, container).token);
          } catch {
            errors = [{ code: 'CAPTCHA_FAILED', reason: 'captcha_failed', message: 'The security check did not complete.' }];
            reason = 'captcha_failed';
            return emit();
          }
        },
        async startOAuth(provider, redirectUrl) {
          const started = await startOauthRedirect(client, { provider, redirectUrl });
          if (!started) {
            errors = [{ code: 'OAUTH_START_FAILED', reason: 'oauth_start_failed', message: 'Could not start the social sign-in.' }];
            reason = 'oauth_start_failed';
            return emit();
          }
          redirect = started.authorizationUrl;
          step = { type: 'redirect', url: started.authorizationUrl };
          errors = [];
          reason = null;
          return emit();
        },
        acceptPolicies: (acceptances) => run(() => acceptAttemptPolicies(client, flow, acceptances)),
        reset() {
          flow = initialFlow; step = { type: 'needs_identifier' }; errors = []; reason = null; captchaToken = null; redirect = null; enrollment = null;
          return emit();
        },
      };
    },
  };
}

export interface SignInFlow extends Core {
  /** `needs_identifier`: start with an email, username or phone number. */
  submitIdentifier(identifier: string): Promise<FlowSnapshot>;
  /** `needs_first_factor`: the password. */
  submitPassword(password: string): Promise<FlowSnapshot>;
  /** `needs_first_factor`: email the person a code (then `submitEmailCode`). */
  sendEmailCode(): Promise<FlowSnapshot>;
  /** `needs_first_factor`: the emailed code. */
  submitEmailCode(code: string): Promise<FlowSnapshot>;
  /** Sign in with a passkey (starts at `needs_identifier`; needs no identifier). */
  signInWithPasskey(): Promise<FlowSnapshot>;
  /** `needs_second_factor`: a code for `strategy` (default: authenticator app). */
  submitSecondFactor(code: string, strategy?: (typeof SECOND_FACTOR_STRATEGIES)[number], options?: { rememberDevice?: boolean }): Promise<FlowSnapshot>;
  /** `needs_second_factor`: send a text or emailed code, then `submitSecondFactor(code, 'sms' | 'email_code')`. */
  sendSecondFactorCode(strategy: 'sms' | 'email_code'): Promise<FlowSnapshot>;
  /** `needs_mfa_enrollment`: begin the authenticator app. The step's `enrollment` then holds `secret` and `uri` (and `qrCode` when sent). */
  startTotpEnrollment(): Promise<FlowSnapshot>;
  /** `needs_mfa_enrollment`: text a code to `phone` (E.164). The step's `enrollment.phone` is the masked number. */
  sendEnrollmentPhone(phone: string): Promise<FlowSnapshot>;
  /** `needs_mfa_enrollment`: confirm with the code the app shows (and `secondCode`, the next one, when the step's `totpCodes` is 2) or the texted code. */
  submitEnrollmentCode(code: string, secondCode?: string): Promise<FlowSnapshot>;
  /** `show_recovery_codes`: the person saved the codes; the step becomes `complete`. */
  acknowledgeRecoveryCodes(): Promise<FlowSnapshot>;
  /** `needs_required_action` / `update_password`. */
  updatePassword(password: string): Promise<FlowSnapshot>;
  /** `needs_required_action` / `verify_email`: mail a code. */
  sendEmailVerification(): Promise<FlowSnapshot>;
  /** `needs_required_action` / `verify_email`: the mailed code. */
  submitEmailVerificationCode(code: string): Promise<FlowSnapshot>;
  /** `needs_required_action` / `update_profile`. */
  updateProfile(input: { firstName?: string; lastName?: string; username?: string }): Promise<FlowSnapshot>;
  /** `needs_required_action` / `complete_profile` or `journey_form`: values by field key. */
  submitRequiredFields(values: Record<string, string>, options?: { skip?: boolean }): Promise<FlowSnapshot>;
  /** `needs_required_action` / `identity_verification`: open the check; the step's `url` is where the person goes. */
  startIdentityVerification(redirectUrl?: string): Promise<FlowSnapshot>;
  /** `needs_required_action` / `identity_verification`: read the verdict after the person came back. */
  checkIdentityVerification(): Promise<FlowSnapshot>;
}

export function createSignInFlow(opts: FlowOptions): SignInFlow {
  const core = makeCore(opts, 'signIn');
  const { client } = opts;
  let identifier = '';
  const attemptId = () => core.flow.attempt?.id ?? '';

  const start = (id: string) => {
    identifier = id;
    return core.run(() => advance(client, { ...initialFlow }, { identifier: id, ...(core.captchaToken ? { captcha_token: core.takeCaptchaToken()! } : {}) }));
  };
  // A captcha asked for by the passkey button is answered by trying the passkey again, not by an identifier.
  let viaPasskey = false;
  const passkey = async () => {
    viaPasskey = true;
    const snap = await core.run(() =>
      signInWithPasskey(client, { captcha: core.captchaToken ? async () => core.takeCaptchaToken() : null }),
    );
    viaPasskey = await core.captchaStepFromErrors();
    return viaPasskey ? api.getSnapshot() : snap;
  };
  const submitCaptcha = async (token: string) => {
    core.setCaptchaToken(token);
    return viaPasskey ? passkey() : start(core.flow.attempt?.identifier ?? identifier);
  };
  const api = core.api({ submitCaptcha });

  const prepareEnrollment = (input: Parameters<typeof prepareMfaEnrollment>[2]) =>
    core.run(async () => {
      const out = await prepareMfaEnrollment(client, attemptId(), input);
      if (out.enrollment) core.enrollment = out.enrollment;
      return { ...core.flow, errors: out.errors };
    });

  return {
    ...api,
    submitIdentifier: (id) => {
      viaPasskey = false;
      return start(id);
    },
    submitPassword: (password) => core.run(() => advance(client, core.flow, { password })),
    sendEmailCode: () => core.run(() => prepareFactor(client, core.flow, 'email_code')),
    submitEmailCode: (code) => core.run(() => advance(client, core.flow, { code })),
    signInWithPasskey: passkey,
    submitSecondFactor: (code, strategy = 'totp', options = {}) =>
      core.run(() =>
        advance(client, core.flow, {
          code,
          ...(strategy === 'email_code' ? { strategy } : {}),
          ...(options.rememberDevice ? { remember_device: 'true' } : {}),
        }),
      ),
    async sendSecondFactorCode(strategy) {
      const res = await client.post(`/v1/client/sign_ins/${encodeURIComponent(attemptId())}/prepare_second_factor`, { strategy });
      return core.run(async () => ({ ...core.flow, errors: res.ok ? [] : res.errors }));
    },
    startTotpEnrollment: () => prepareEnrollment({ strategy: 'totp' }),
    sendEnrollmentPhone: (phone) => prepareEnrollment({ strategy: 'phone_code', phone: phone.trim() }),
    submitEnrollmentCode: (code, secondCode = '') => {
      const e = core.enrollment;
      if (!e) return Promise.resolve(api.getSnapshot());
      return core.run(() =>
        advance(client, core.flow, e.strategy === 'phone_code' ? { factorId: e.factorId, enrollStrategy: 'phone_code', code } : { factorId: e.factorId, code, secondCode }),
      );
    },
    acknowledgeRecoveryCodes: () => core.acknowledgeCodes(),
    updatePassword: (password) => core.run(() => completeRequiredAction(client, core.flow, { action: 'update_password', password })),
    sendEmailVerification: () => core.run(() => completeRequiredAction(client, core.flow, { action: 'verify_email', step: 'send' })),
    submitEmailVerificationCode: (code) => core.run(() => completeRequiredAction(client, core.flow, { action: 'verify_email', step: 'verify', code })),
    updateProfile: ({ firstName, lastName, username }) =>
      core.run(() =>
        completeRequiredAction(client, core.flow, {
          action: 'update_profile',
          ...(firstName !== undefined ? { first_name: firstName } : {}),
          ...(lastName !== undefined ? { last_name: lastName } : {}),
          ...(username !== undefined ? { username } : {}),
        }),
      ),
    submitRequiredFields: (values, options = {}) =>
      core.run(() => completeRequiredAction(client, core.flow, { fields: values, ...(options.skip ? { skip: true } : {}) })),
    startIdentityVerification: (redirectUrl) =>
      core.run(() => completeRequiredAction(client, core.flow, { action: 'identity_verification', step: 'start', ...(redirectUrl ? { redirect_url: redirectUrl } : {}) })),
    checkIdentityVerification: () => core.run(() => completeRequiredAction(client, core.flow, { action: 'identity_verification' })),
  };
}

export interface SignUpInput {
  email: string;
  password: string;
  /** The extra fields the instance collects (name, company, …). */
  fields?: Record<string, string>;
  username?: string;
  /** The legal-consent tick, when the instance requires it. */
  consent?: boolean;
  unsafeMetadata?: Record<string, unknown>;
  policyAcceptances?: PolicyAcceptance[];
}

export interface SignUpFlow extends Core {
  /** `needs_identifier`: create the account. */
  submit(input: SignUpInput): Promise<FlowSnapshot>;
  /** `needs_email_verification`: the emailed code. */
  submitEmailCode(code: string): Promise<FlowSnapshot>;
  /** `needs_email_verification`: send the code again. */
  resendEmailCode(): Promise<FlowSnapshot>;
}

export function createSignUpFlow(opts: FlowOptions): SignUpFlow {
  const core = makeCore(opts, 'signUp');
  const { client } = opts;
  let last: SignUpInput | null = null;

  const submit = async (input: SignUpInput) => {
    last = input;
    const token = core.takeCaptchaToken();
    const snap = await core.run(() => startSignUp(client, { ...input, ...(token ? { captchaToken: token } : {}) }));
    if (!(await core.captchaStepFromErrors())) return snap;
    return api.getSnapshot();
  };
  const submitCaptcha = async (token: string) => {
    core.setCaptchaToken(token);
    return last ? submit(last) : api.getSnapshot();
  };
  const api = core.api({ submitCaptcha });
  return {
    ...api,
    submit,
    submitEmailCode: (code) => core.run(() => advance(client, core.flow, { code })),
    resendEmailCode: () => core.run(() => resendSignUpVerification(client, core.flow)),
  };
}
