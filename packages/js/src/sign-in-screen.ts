/**
 * The view-model of a sign-in screen, with no UI and no framework.
 *
 * `createSignInScreen()` drives `createSignInFlow()` and answers the questions a
 * screen asks: which step am I on, which methods can the person use, which
 * fields do I draw, what do I show when it fails. You render `getView()`, call
 * the actions, and re-render on `subscribe`. The server still decides the next
 * step; this only shapes the flow's answers for a form. Errors come back as
 * sentences in the app's language (`localization`), never as codes.
 *
 * The steps after the credentials are driven too: setting up a second factor
 * (authenticator app with its QR code, or texts), saving the recovery codes,
 * accepting policies and the required actions (new password, verify email,
 * profile, a server-driven form, identity verification). `other` is only a step
 * this SDK does not know yet; `flow` is there for it.
 */
import { localizedErrorMessage, type ErrorStrings } from './errors';
import type { PendingPolicy, ProfileCompletionField } from './attempt';
import type { PolicyAcceptance } from './policies';
import { fetchInstanceSettings, type InstanceSettings, type PublicSignUpField } from './instance-settings';
import { createSignInFlow, createSignUpFlow, type FlowOptions, type FlowSnapshot, type FlowStep, type RequiredActionStep, type SignInFlow, type SignUpFlow } from './sign-in-flow';

export type SignInScreenStep =
  /** Sign-up only: the create-account form (`fields`: email, password and the instance's sign-up fields). */
  | 'details'
  | 'identifier'
  | 'first_factor'
  | 'second_factor'
  | 'captcha'
  | 'redirect'
  /** Mid-sign-in second-factor setup: pick `totp` or `sms`, see `enrollment`. */
  | 'enroll_second_factor'
  /** The factor is set up: show `recoveryCodes` once, then `acknowledgeRecoveryCodes()`. */
  | 'recovery_codes'
  /** `policies` to accept: `acceptPolicies()`. */
  | 'policies'
  /** A mailed code to confirm the address. */
  | 'email_verification'
  /** One owed action: see `requiredAction`. */
  | 'required_action'
  /** A step this SDK does not know yet; use `flow`. */
  | 'other'
  | 'complete';

/** What the person can do on a step. `passkey`, `apple` and `google` on the identifier step are one-tap alternatives to typing an identifier. */
export type SignInMethod = 'password' | 'email_code' | 'passkey' | 'apple' | 'google' | 'totp' | 'sms' | 'backup_code';

export interface ScreenField {
  /** `identifier`, `password`, `code`, `second_code`, `phone`, `new_password`, `first_name`, `last_name`, `username`, or a server-defined field key. */
  name: string;
  /**
   * What to draw. `select` is one choice from `options`, `multi_select` several (submit them as a list),
   * `checkbox` a yes / no (`'true'` / `'false'`; its `link` sits in the label), `file` a reference the app
   * obtained itself (an upload id or an https URL), `phone` a number in international form (+15551234567).
   */
  kind: 'text' | 'password' | 'code' | 'phone' | 'email' | 'number' | 'date' | 'select' | 'multi_select' | 'checkbox' | 'textarea' | 'file';
  /** The platform autofill hint (`username`, `current-password`, `new-password`, `one-time-code`, `tel`, `email`). */
  autoComplete: 'username' | 'current-password' | 'new-password' | 'one-time-code' | 'tel' | 'email' | 'off';
  secure: boolean;
  /** Server-defined fields: the label to show, whether it must be filled, and the choices of a select. */
  label?: string;
  required?: boolean;
  options?: string[];
  /** The label of each option, by option value, in the person's language. */
  optionLabels?: Record<string, string>;
  placeholder?: string;
  help?: string;
  /** checkbox: a link in its label (https). */
  link?: { text: string; url: string };
  /** file: the types the picker offers and the size limit. */
  accept?: string[];
  maxBytes?: number;
  /** What the person saved earlier for this field: prefill it. */
  value?: string | number | boolean | string[];
}

/** Mid-sign-in second-factor setup. */
export interface ScreenEnrollment {
  /** The authenticator app's setup, once started: scan `qrSvg` (trusted markup) or `qrCode` (a data URL), or type `secret`. */
  totp: { secret: string; uri: string; qrSvg: string | null; qrCode: string | null } | null;
  /** How many consecutive authenticator codes to ask for (field `code`, then `second_code`). */
  totpCodes: 1 | 2;
  /** After a text was sent: the masked number; the next field is the code. */
  phone: string | null;
}

/** What the owed action asks for; the fields to draw are in the view's `fields`. */
export interface ScreenRequiredAction {
  kind: RequiredActionStep['kind'];
  title: string | null;
  intro: string | null;
  /** identity_verification and custom: where to send the person. */
  url: string | null;
  /** identity_verification: the check's status. */
  status: string | null;
  /** How many more actions are queued behind this one. */
  remaining: number;
  /** complete_profile: every field is optional, so it may be skipped (`submit({ skip: 'true' })`). */
  skippable: boolean;
}

export interface SignInScreenView {
  step: SignInScreenStep;
  /** The choices for this step's factor (a password or an emailed code; an authenticator code, text, recovery code or passkey). */
  methods: SignInMethod[];
  /** The method the form is on: one of `methods`, or null where there is nothing to choose. */
  method: SignInMethod | null;
  /** The one-tap sign-ins the app set up (identifier step only). */
  alternatives: SignInMethod[];
  /** What to draw for the current method. Empty for a passkey (the platform prompt is the form). */
  fields: ScreenField[];
  /** The current method needs a code sent first (`sendCode()`), and it has not been yet. */
  needsSend: boolean;
  /** A code was sent for the current method; `resend()` is `sendCode()` again. */
  codeSent: boolean;
  /** After a text: the masked number it went to. */
  sentTo: string | null;
  busy: boolean;
  /** The last failure as a sentence, or null. A dismissed system sheet is not a failure. */
  error: string | null;
  /** The stable reason behind `error`, for your own handling. */
  reason: string | null;
  /** The attempt id (for support or your own routes), once there is one. */
  attemptId: string | null;
  /** enroll_second_factor. */
  enrollment: ScreenEnrollment | null;
  /** recovery_codes: shown once. */
  recoveryCodes: string[] | null;
  /** policies. */
  policies: PendingPolicy[];
  /** required_action. */
  requiredAction: ScreenRequiredAction | null;
  /** Sign-up screens: the terms and privacy links and whether agreeing is required (send `consent: 'true'`). Null on a sign-in screen. */
  legal: InstanceSettings['legal'] | null;
  /** The flow's own step, for `other` and for the details of `captcha` / `redirect`. */
  flowStep: FlowStep;
}

export interface SignInScreenOptions extends FlowOptions {
  /** A `@atlasauth/localizations` bundle (or lookup function) for error sentences. */
  localization?: ErrorStrings | null;
}

export interface SignInScreen {
  getView(): SignInScreenView;
  subscribe(listener: (view: SignInScreenView) => void): () => void;
  /** The underlying flow, for the steps reported as `other`. */
  readonly flow: SignInFlow;
  /**
   * Pick a method on the current step (a text or an emailed code is not sent until `sendCode()`).
   * On `enroll_second_factor`, `totp` starts the authenticator setup.
   */
  selectMethod(method: SignInMethod): Promise<void>;
  /** Send the code the current step needs (emailed first-factor code, a text / emailed second-factor code, or the verify-email code of a required action). */
  sendCode(): Promise<void>;
  /** The same as `sendCode()`, for a "send again" button. */
  resend(): Promise<void>;
  /**
   * Submit the form of the current step. Values are by field name (`identifier`, `password`, `code`);
   * `remember_device: 'true'` on a second factor skips it next time. For the passkey method no values are needed.
   */
  submit(values?: Record<string, string>): Promise<void>;
  /** The one-tap sign-ins (identifier step). */
  signInWithPasskey(): Promise<void>;
  signInWithApple(): Promise<void>;
  signInWithGoogle(): Promise<void>;
  /** recovery_codes: the person saved them. */
  acknowledgeRecoveryCodes(): Promise<void>;
  /**
   * policies: accept what the step lists (all of it, or only `only` keys). Pass `scrolledToEnd` / `viewMs` as
   * evidence for a scroll-to-accept policy.
   */
  acceptPolicies(options?: { only?: string[]; scrolledToEnd?: boolean; viewMs?: number }): Promise<void>;
  /** required_action / identity_verification: open the check; the action's `url` is where the person goes. */
  startIdentityVerification(redirectUrl?: string): Promise<void>;
  /** required_action / identity_verification: read the verdict after the person came back. */
  checkIdentityVerification(): Promise<void>;
  /** Answer a `captcha` step with a token you obtained yourself. */
  submitCaptcha(token: string): Promise<void>;
  /** required_action / journey_form: keep the answers so far (by field name) without finishing the step. They return as each field's `value`. */
  saveDraft(values?: Record<string, string>): Promise<void>;
  /** A `file` field: upload the picked file; answers the upload id to submit as that field's value, or null (the reason is in `view.errors`). */
  uploadFile(field: string, file: Blob): Promise<string | null>;
  /** Start over from the identifier. */
  reset(): void;
}

/** The sign-up screen: {@link SignInScreen} without the sign-in-only one-tap methods, over a sign-up flow. */
export type SignUpScreen = Omit<SignInScreen, 'flow' | 'signInWithPasskey' | 'signInWithApple' | 'signInWithGoogle'> & { readonly flow: SignUpFlow };

const FIRST_FACTOR_METHODS: SignInMethod[] = ['password', 'email_code'];
const SECOND_FACTOR_METHODS: SignInMethod[] = ['totp', 'backup_code', 'sms', 'email_code', 'passkey'];
/** Dismissing a system sheet or a passkey prompt is the person's choice, not an error to show. */
const SILENT = new Set(['passkey_cancelled', 'native_cancelled']);

const FIELDS: Record<'identifier' | 'password' | 'code' | 'backup', ScreenField> = {
  identifier: { name: 'identifier', kind: 'text', autoComplete: 'username', secure: false },
  password: { name: 'password', kind: 'password', autoComplete: 'current-password', secure: true },
  code: { name: 'code', kind: 'code', autoComplete: 'one-time-code', secure: false },
  backup: { name: 'code', kind: 'code', autoComplete: 'off', secure: false },
};

const FIELD_CODE = FIELDS.code;
const FIELD_EMAIL: ScreenField = { name: 'email', kind: 'email', autoComplete: 'email', secure: false, required: true };
const FIELD_SIGN_UP_PASSWORD: ScreenField = { name: 'password', kind: 'password', autoComplete: 'new-password', secure: true, required: true };
const FIELD_SECOND_CODE: ScreenField = { name: 'second_code', kind: 'code', autoComplete: 'one-time-code', secure: false };
const FIELD_PHONE: ScreenField = { name: 'phone', kind: 'phone', autoComplete: 'tel', secure: false };
const FIELD_NEW_PASSWORD: ScreenField = { name: 'new_password', kind: 'password', autoComplete: 'new-password', secure: true };
const FIELD_KINDS: Record<string, ScreenField['kind']> = {
  email: 'email', number: 'number', date: 'date', select: 'select', multi_select: 'multi_select', phone: 'phone',
  checkbox: 'checkbox', textarea: 'textarea', file: 'file', password: 'password',
};
const profileField = (f: ProfileCompletionField): ScreenField => {
  const kind = FIELD_KINDS[f.type] ?? 'text';
  return {
    name: f.key,
    kind,
    autoComplete: kind === 'password' ? 'new-password' : kind === 'phone' ? 'tel' : kind === 'email' ? 'email' : 'off',
    secure: kind === 'password',
    label: f.label,
    required: f.required,
    ...(f.options?.length ? { options: f.options } : {}),
    ...(f.option_labels ? { optionLabels: f.option_labels } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.help ? { help: f.help } : {}),
    ...(f.link ? { link: f.link } : {}),
    ...(f.accept ? { accept: f.accept } : {}),
    ...(f.max_bytes ? { maxBytes: f.max_bytes } : {}),
    ...(f.value !== undefined ? { value: f.value } : {}),
  };
};

/** The create-account form's own fields, from the instance's public settings. */
const signUpFieldOf = (f: PublicSignUpField): ScreenField => {
  const kind: ScreenField['kind'] =
    f.type === 'tel' ? 'phone' : f.type === 'textarea' ? 'textarea' : f.type === 'checkbox' ? 'checkbox' : f.type === 'select' || f.type === 'radio' ? 'select' : f.type === 'multiselect' ? 'multi_select' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text';
  return {
    name: f.key,
    kind,
    autoComplete: kind === 'phone' ? 'tel' : kind === 'email' ? 'email' : 'off',
    secure: false,
    label: f.label,
    required: f.required,
    ...(f.options.length ? { options: f.options } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
  };
};

const screenStep = (step: FlowStep, mode: 'sign_in' | 'sign_up' = 'sign_in'): SignInScreenStep => {
  switch (step.type) {
    case 'needs_identifier': return mode === 'sign_up' ? 'details' : 'identifier';
    case 'needs_first_factor': return 'first_factor';
    case 'needs_second_factor': return 'second_factor';
    case 'needs_captcha': return 'captcha';
    case 'redirect': return 'redirect';
    case 'complete': return 'complete';
    case 'needs_mfa_enrollment': return 'enroll_second_factor';
    case 'show_recovery_codes': return 'recovery_codes';
    case 'needs_policy_acceptance': return 'policies';
    case 'needs_email_verification': return 'email_verification';
    case 'needs_required_action': return 'required_action';
    default: return 'other';
  }
};

/** The sign-in screen view-model: the credentials, then every step a journey or the account policies add. */
export function createSignInScreen(opts: SignInScreenOptions): SignInScreen {
  return createScreen(opts, 'sign_in');
}

/**
 * The sign-up screen view-model: the same steps as {@link createSignInScreen} after the credentials (verify the
 * email, policies, second-factor setup, recovery codes, required actions and journey forms), with `details` as
 * the first step: `fields` are the email, a new password and the instance's sign-up fields, `legal` the consent
 * links. `submit({ email, password, ...fields, consent: 'true' })`.
 */
export function createSignUpScreen(opts: SignInScreenOptions): SignUpScreen {
  return createScreen(opts, 'sign_up') as unknown as SignUpScreen;
}

function createScreen(opts: SignInScreenOptions, mode: 'sign_in' | 'sign_up'): SignInScreen {
  const flow = (mode === 'sign_up' ? createSignUpFlow(opts) : createSignInFlow(opts)) as unknown as SignInFlow & SignUpFlow;
  const native = opts.nativeSignIn ?? {};
  const listeners = new Set<(v: SignInScreenView) => void>();
  let selected: SignInMethod | null = null;
  let sentFor: SignInMethod | null = null;
  let lastStep: SignInScreenStep = mode === 'sign_up' ? 'details' : 'identifier';
  // Sign-up: the instance's create-account fields and consent links, read once.
  let settings: InstanceSettings | null = null;

  const alternatives = (): SignInMethod[] => {
    const out: SignInMethod[] = [];
    if (native.passkey) out.push('passkey');
    if (native.apple) out.push('apple');
    if (native.google) out.push('google');
    return out;
  };

  const build = (snap: FlowSnapshot): SignInScreenView => {
    const step = screenStep(snap.step, mode);
    if (step !== lastStep) {
      lastStep = step;
      selected = null;
      sentFor = null;
    }
    const fs = snap.step;
    const methods: SignInMethod[] =
      fs.type === 'needs_first_factor'
        ? FIRST_FACTOR_METHODS.filter((m) => fs.factors.includes(m))
        : fs.type === 'needs_second_factor'
          ? SECOND_FACTOR_METHODS.filter((m) => fs.factors.includes(m))
          : fs.type === 'needs_mfa_enrollment'
            ? fs.methods.map((m): SignInMethod => (m === 'phone_code' ? 'sms' : 'totp'))
            : [];
    const method = methods.length ? (selected && methods.includes(selected) ? selected : methods[0]!) : null;

    const enrolling = fs.type === 'needs_mfa_enrollment' ? fs.enrollment : null;
    const enrollment: ScreenEnrollment | null =
      fs.type === 'needs_mfa_enrollment'
        ? {
            totp: enrolling?.strategy === 'totp' && enrolling.secret ? { secret: enrolling.secret, uri: enrolling.uri ?? '', qrSvg: enrolling.qrSvg ?? null, qrCode: enrolling.qrCode ?? null } : null,
            totpCodes: fs.totpCodes,
            phone: enrolling?.strategy === 'phone_code' ? (enrolling.phone ?? null) : null,
          }
        : null;
    const action = fs.type === 'needs_required_action' ? fs.action : null;
    const requiredAction: ScreenRequiredAction | null =
      fs.type === 'needs_required_action' && action
        ? {
            kind: action.kind,
            title: action.kind === 'journey_form' ? action.title : null,
            intro: action.kind === 'journey_form' ? action.intro : null,
            url: action.kind === 'identity_verification' || action.kind === 'custom' ? action.url : null,
            status: action.kind === 'identity_verification' ? action.status : null,
            remaining: fs.remaining,
            skippable: action.kind === 'complete_profile' && action.fields.every((f) => !f.required),
          }
        : null;

    let fields: ScreenField[] = [];
    if (step === 'details') {
      fields = [
        FIELD_EMAIL,
        FIELD_SIGN_UP_PASSWORD,
        ...(settings?.signUpFields ?? []).filter((f) => f.key !== 'email' && f.key !== 'password').map(signUpFieldOf),
      ];
    } else if (step === 'identifier') fields = [FIELDS.identifier];
    else if (step === 'first_factor' || step === 'second_factor') {
      fields = method === 'password' ? [FIELDS.password] : method === 'backup_code' ? [FIELDS.backup] : method && method !== 'passkey' ? [FIELDS.code] : [];
    } else if (step === 'enroll_second_factor') {
      if (method === 'sms') fields = enrollment?.phone ? [FIELD_CODE] : [FIELD_PHONE];
      else if (method === 'totp' && enrollment?.totp) fields = enrollment.totpCodes === 2 ? [FIELD_CODE, FIELD_SECOND_CODE] : [FIELD_CODE];
    } else if (step === 'email_verification') fields = [FIELD_CODE];
    else if (action) {
      switch (action.kind) {
        case 'update_password': fields = [FIELD_NEW_PASSWORD]; break;
        case 'verify_email': fields = [FIELD_CODE]; break;
        case 'update_profile':
          fields = [
            { name: 'first_name', kind: 'text', autoComplete: 'off', secure: false },
            { name: 'last_name', kind: 'text', autoComplete: 'off', secure: false },
            { name: 'username', kind: 'text', autoComplete: 'username', secure: false },
          ];
          break;
        case 'complete_profile':
        case 'journey_form': fields = action.fields.map(profileField); break;
        default: break;
      }
    }
    const sends = method === 'email_code' || (method === 'sms' && step === 'second_factor');
    const failure = snap.errors[0];
    const silent = failure && SILENT.has((failure.reason ?? failure.code).toLowerCase());
    return {
      step,
      methods,
      method,
      alternatives: step === 'identifier' ? alternatives() : [],
      fields,
      needsSend: (sends && sentFor !== method) || (action?.kind === 'verify_email' && sentFor === null),
      codeSent: (sends && sentFor === method) || (action?.kind === 'verify_email' && sentFor !== null),
      sentTo: snap.sentTo,
      busy: snap.busy,
      error: failure && !silent ? localizedErrorMessage(failure, opts.localization) : snap.reason && !failure ? localizedErrorMessage({ reason: snap.reason }, opts.localization) : null,
      reason: failure ? (silent ? null : (failure.reason ?? snap.reason)) : snap.reason,
      attemptId: snap.attemptId,
      enrollment,
      recoveryCodes: fs.type === 'show_recovery_codes' ? fs.codes : null,
      policies: fs.type === 'needs_policy_acceptance' ? fs.policies : [],
      requiredAction,
      legal: mode === 'sign_up' ? (settings?.legal ?? null) : null,
      flowStep: snap.step,
    };
  };

  let view = build(flow.getSnapshot());
  flow.subscribe((snap) => {
    view = build(snap);
    for (const l of listeners) l(view);
    maybeAutoStart(view);
  });
  const refresh = () => {
    view = build(flow.getSnapshot());
    for (const l of listeners) l(view);
  };
  if (mode === 'sign_up') {
    void fetchInstanceSettings(opts.client).then((loaded) => {
      settings = loaded;
      refresh();
    }, () => undefined);
  }
  const done = async (p: Promise<unknown>) => void (await p);

  const sendCode = async () => {
    const { method, step, requiredAction } = view;
    if (mode === 'sign_up' && step === 'email_verification') return done(flow.resendEmailCode());
    if (requiredAction?.kind === 'verify_email') {
      sentFor = 'email_code';
      return done(flow.sendEmailVerification());
    }
    if (step === 'enroll_second_factor') return;
    if (method !== 'email_code' && method !== 'sms') return;
    sentFor = method;
    await done(step === 'first_factor' ? flow.sendEmailCode() : flow.sendSecondFactorCode(method));
  };

  // A lone authenticator-app option has nothing to choose: start its setup once per attempt.
  let autoStarted: string | null = null;
  const maybeAutoStart = (v: SignInScreenView) => {
    if (v.step === 'enroll_second_factor' && v.method === 'totp' && !v.enrollment?.totp && !v.busy && autoStarted !== v.attemptId && v.methods.length === 1) {
      autoStarted = v.attemptId;
      void flow.startTotpEnrollment();
    }
  };
  maybeAutoStart(view);

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    flow,
    async selectMethod(method) {
      if (!view.methods.includes(method)) return;
      selected = method;
      refresh();
      if (view.step === 'enroll_second_factor' && method === 'totp' && !view.enrollment?.totp) await done(flow.startTotpEnrollment());
    },
    sendCode,
    resend: sendCode,
    async submit(values = {}) {
      const { step, method } = view;
      const code = (values.code ?? '').trim();
      if (step === 'details') {
        const { email = '', password = '', consent, ...rest } = values;
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rest)) if (v) fields[k] = v;
        return done(flow.submit({ email: email.trim(), password, fields, ...(consent !== undefined ? { consent: consent === 'true' } : {}) }));
      }
      if (step === 'identifier') return done(flow.submitIdentifier((values.identifier ?? '').trim()));
      if (step === 'first_factor') {
        if (method === 'password') return done(flow.submitPassword(values.password ?? ''));
        if (method === 'email_code') return done(flow.submitEmailCode(code));
        return;
      }
      if (step === 'enroll_second_factor') {
        if (method === 'sms' && !view.enrollment?.phone) return done(flow.sendEnrollmentPhone((values.phone ?? '').trim()));
        if (method === 'totp' || method === 'sms') return done(flow.submitEnrollmentCode(code, (values.second_code ?? '').trim()));
        return;
      }
      if (step === 'email_verification') return done(flow.submitEmailCode(code));
      if (step === 'required_action') {
        const kind = view.requiredAction?.kind;
        if (kind === 'update_password') return done(flow.updatePassword(values.new_password ?? ''));
        if (kind === 'verify_email') return done(flow.submitEmailVerificationCode(code));
        if (kind === 'update_profile') {
          return done(
            flow.updateProfile({
              ...(values.first_name !== undefined ? { firstName: values.first_name } : {}),
              ...(values.last_name !== undefined ? { lastName: values.last_name } : {}),
              ...(values.username !== undefined ? { username: values.username } : {}),
            }),
          );
        }
        if (kind === 'complete_profile' || kind === 'journey_form') {
          const { skip, ...rest } = values;
          return done(flow.submitRequiredFields(rest, skip === 'true' ? { skip: true } : {}));
        }
        return;
      }
      if (step === 'second_factor') {
        if (method === 'passkey') return done(flow.submitPasskeySecondFactor(values.remember_device === 'true' ? { rememberDevice: true } : {}));
        if (method === 'totp' || method === 'backup_code' || method === 'sms' || method === 'email_code') {
          return done(flow.submitSecondFactor(code, method, values.remember_device === 'true' ? { rememberDevice: true } : {}));
        }
      }
    },
    async uploadFile(field, file) {
      const out = await flow.uploadJourneyFile(field, file);
      if (out.ok) return out.id;
      view = { ...view, error: out.errors[0]?.message ?? 'The file could not be uploaded.', reason: out.errors[0]?.code ?? 'upload_failed' };
      for (const l of listeners) l(view);
      return null;
    },
    saveDraft(values = {}) {
      return view.requiredAction?.kind === 'journey_form' ? done(flow.saveRequiredFieldsDraft(values)) : Promise.resolve();
    },
    acknowledgeRecoveryCodes: () => done(flow.acknowledgeRecoveryCodes()),
    acceptPolicies(options = {}) {
      const acceptances: PolicyAcceptance[] = view.policies
        .filter((p) => !options.only || options.only.includes(p.policy))
        .map((p) => ({
          policy: p.policy,
          version_id: p.version_id,
          content_sha256: p.content_sha256,
          ...(p.display === 'checkbox' || p.display === 'scroll' || p.display === 'link' ? { display: p.display as PolicyAcceptance['display'] } : {}),
          ...(options.scrolledToEnd ? { scrolled_to_end: true } : {}),
          ...(options.viewMs !== undefined ? { view_ms: options.viewMs } : {}),
        }));
      return done(flow.acceptPolicies(acceptances));
    },
    startIdentityVerification: (redirectUrl) => done(flow.startIdentityVerification(redirectUrl)),
    checkIdentityVerification: () => done(flow.checkIdentityVerification()),
    signInWithPasskey: () => done(flow.signInWithPasskey()),
    signInWithApple: () => done(flow.signInNative('apple')),
    signInWithGoogle: () => done(flow.signInNative('google')),
    submitCaptcha: (token) => done(flow.submitCaptcha(token)),
    reset() {
      flow.reset();
    },
  };
}
