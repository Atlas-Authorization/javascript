/**
 * The sign-in's MFA steps, shared by the prebuilt components of every framework
 * SDK: setting up a second factor mid-sign-in (`needs_mfa_enrollment`) and the
 * texted / emailed alternatives at the second-factor step.
 *
 * Enrolment (§11.1 MFA policy `required`, for an account with no factor yet):
 *
 *   - Authenticator app: `prepare_mfa_enrollment` (`strategy: "totp"`) returns
 *     the setup key, the otpauth URI and its QR image (`qr_code`, a data: URL);
 *     the user confirms with the code(s) the app shows.
 *   - Text message, where the app offers the SMS factor and can text: the user
 *     types a phone number, `prepare_mfa_enrollment` (`strategy: "phone_code"`)
 *     texts a code, and the user confirms with it.
 *
 * Either confirmation (`attempt_mfa_enrollment`, posted by `advance` with the
 * values {@link MfaEnrollmentController.submit} returns) completes the sign-in
 * and comes with the account's one-time recovery codes. `advance` moves them
 * off the attempt into `FlowState.recoveryCodes`; the components show them
 * ({@link pendingRecoveryCodes}: copy, download as .txt, "I've saved my codes")
 * and only then exchange the ticket ({@link acknowledgeRecoveryCodes}).
 *
 * The component draws the state; {@link createMfaEnrollment} owns the requests,
 * so every framework behaves the same.
 */
import type { FieldError } from './attempt';
import type { AccountUx } from './environment';
import type { FapiClient, FlowState } from './fapi';

export type MfaEnrollmentStrategy = 'totp' | 'phone_code';

/** What the app lets a sign-in's MFA steps offer. */
export interface MfaChoices {
  /** Set up an authenticator app. */
  totp: boolean;
  /** Set up texted codes, and "Text me a code instead" at the second factor. */
  sms: boolean;
  /** "Email me a code instead" at the second factor. */
  emailCode: boolean;
  /** How many authenticator codes enrolment asks for. */
  totpCodes: 1 | 2;
  /** "Use Duo instead" at the second factor (see `prepareDuo`). */
  duo?: boolean;
}

/**
 * The MFA choices from the instance's settings (`InstanceSettings.account`).
 * A server that does not publish `account.mfa` gets the authenticator app only,
 * with two code fields (an instance asking for one code uses the first). Texted
 * codes are offered only where the server says the app can text, so nobody is
 * shown an option that cannot work.
 */
export function mfaChoicesFrom(account: Pick<AccountUx, 'emailSecondFactor' | 'mfa'> | null | undefined): MfaChoices {
  const mfa = account?.mfa;
  return {
    totp: mfa ? mfa.totp : true,
    sms: mfa ? mfa.sms : false,
    emailCode: account?.emailSecondFactor === true,
    totpCodes: mfa ? mfa.totpCodes : 2,
    ...(mfa?.duo === true ? { duo: true } : {}),
  };
}

/** A factor being set up: the authenticator's setup, or the number a code was texted to. */
export interface MfaEnrollment {
  strategy: MfaEnrollmentStrategy;
  factorId: string;
  /** totp: the setup key (shown once). */
  secret?: string;
  /** totp: the otpauth:// URI. */
  uri?: string;
  /** totp: the URI as a QR image (a data: URL), when the server sends one. */
  qrCode?: string;
  /** phone_code: the number the code was texted to, masked. */
  phone?: string;
}

/** `POST /v1/client/sign_ins/:id/prepare_mfa_enrollment`. */
export async function prepareMfaEnrollment(
  client: FapiClient,
  attemptId: string,
  input: { strategy: 'totp' } | { strategy: 'phone_code'; phone: string },
): Promise<{ enrollment: MfaEnrollment | null; errors: FieldError[]; status: number }> {
  const response = await client.post<Record<string, unknown>>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_mfa_enrollment`,
    input.strategy === 'phone_code' ? { strategy: 'phone_code', phone: input.phone } : { strategy: 'totp' },
  );
  const d = response.data;
  if (!response.ok || !d || typeof d.factor_id !== 'string') {
    return { enrollment: null, errors: response.errors, status: response.status };
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const enrollment: MfaEnrollment = { strategy: input.strategy, factorId: d.factor_id };
  if (input.strategy === 'totp') {
    if (str(d.secret)) enrollment.secret = str(d.secret);
    if (str(d.uri)) enrollment.uri = str(d.uri);
    // Only an image URL a page can show safely.
    const qr = str(d.qr_code);
    if (qr && /^data:image\//.test(qr)) enrollment.qrCode = qr;
  } else if (str(d.phone)) {
    enrollment.phone = str(d.phone);
  }
  return { enrollment, errors: [], status: response.status };
}

/** A setup key split into groups of four, for reading off the screen. */
export function groupSetupKey(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * A refusal that means the factor cannot be set up here at all (turned off, or
 * the app cannot text), as opposed to a mistake the user can fix (a bad number).
 */
function factorUnavailable(errors: FieldError[], status: number): boolean {
  if (status === 409) return true;
  return errors.some((e) => e.code === 'STRATEGY_DISABLED' || e.param === 'strategy');
}

export interface MfaEnrollmentState {
  /** The methods on offer, in display order. */
  options: MfaEnrollmentStrategy[];
  /** The method being set up; null while the user chooses (both are offered). */
  method: MfaEnrollmentStrategy | null;
  /** The prepared factor; null before prepare (and, for texts, before the number is sent). */
  enrollment: MfaEnrollment | null;
  busy: boolean;
  /** This step's own errors (prepare); the confirmation's come back on the flow. */
  errors: FieldError[];
  /** How many authenticator code fields to draw. */
  totpCodes: 1 | 2;
}

export interface MfaEnrollmentController {
  readonly state: MfaEnrollmentState;
  /** Called after every state change; returns the unsubscribe. */
  subscribe(listener: (state: MfaEnrollmentState) => void): () => void;
  /**
   * Begin (or keep) the step for this attempt. A new attempt starts over; with
   * only the authenticator app on offer its setup is fetched straight away.
   */
  start(attemptId: string): void;
  /** Pick a method: the authenticator app is prepared at once; texts ask for a number first. */
  choose(method: MfaEnrollmentStrategy): Promise<void>;
  /** Text a code to `phone` (E.164). */
  sendPhone(phone: string): Promise<void>;
  /** Text the code again (same number). */
  resend(): Promise<void>;
  /**
   * The form's submit. Before a code was texted it sends the typed `phone` and
   * resolves null; otherwise it resolves the values to `advance` with (the
   * factor id and the code(s)), or null when there is nothing to submit yet.
   */
  submit(values: Record<string, string>): Promise<Record<string, string> | null>;
  /** Forget the step (the flow left it). */
  reset(): void;
}

/** The enrolment step's state and requests, independent of any framework. */
export function createMfaEnrollment(
  client: FapiClient,
  choices: MfaChoices | (() => MfaChoices),
): MfaEnrollmentController {
  const read = () => (typeof choices === 'function' ? choices() : choices);
  const offered = (c: MfaChoices): MfaEnrollmentStrategy[] => {
    const out: MfaEnrollmentStrategy[] = [];
    if (c.totp) out.push('totp');
    if (c.sms) out.push('phone_code');
    // Nothing on offer is a misconfiguration; the authenticator app is the
    // default the server enrols, so ask for it rather than draw nothing.
    return out.length ? out : ['totp'];
  };
  const empty = (): MfaEnrollmentState => {
    const c = read();
    return { options: offered(c), method: null, enrollment: null, busy: false, errors: [], totpCodes: c.totpCodes };
  };

  let state = empty();
  let attemptId: string | null = null;
  let phone = '';
  let generation = 0;
  const listeners = new Set<(s: MfaEnrollmentState) => void>();
  const set = (patch: Partial<MfaEnrollmentState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const prepare = async (input: { strategy: 'totp' } | { strategy: 'phone_code'; phone: string }) => {
    const id = attemptId;
    if (!id) return;
    const gen = generation;
    set({ busy: true, errors: [] });
    const out = await prepareMfaEnrollment(client, id, input);
    if (gen !== generation) return; // the flow moved on meanwhile
    if (out.enrollment) {
      set({ busy: false, enrollment: out.enrollment, errors: [] });
      return;
    }
    if (factorUnavailable(out.errors, out.status) && state.options.length > 1) {
      // Not available after all: drop it and carry on with what is left.
      const options = state.options.filter((m) => m !== input.strategy);
      set({ busy: false, options, method: null, enrollment: null, errors: out.errors });
      if (options.length === 1) await controller.choose(options[0]!);
      return;
    }
    set({ busy: false, errors: out.errors });
  };

  const controller: MfaEnrollmentController = {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(id) {
      if (id === attemptId) return;
      generation += 1;
      attemptId = id;
      phone = '';
      state = empty();
      set({});
      if (state.options.length === 1) void controller.choose(state.options[0]!);
    },
    async choose(method) {
      if (!state.options.includes(method)) return;
      set({ method, enrollment: null, errors: [] });
      if (method === 'totp') await prepare({ strategy: 'totp' });
    },
    async sendPhone(value) {
      const number = value.trim();
      if (!number) {
        set({ errors: [{ code: 'FORM_PARAM_MISSING', message: 'A phone number is required.', param: 'phone' }] });
        return;
      }
      phone = number;
      await prepare({ strategy: 'phone_code', phone: number });
    },
    async resend() {
      if (state.method === 'phone_code' && phone) await prepare({ strategy: 'phone_code', phone });
    },
    async submit(values) {
      if (state.method === 'phone_code' && !state.enrollment) {
        await controller.sendPhone(values.phone ?? '');
        return null;
      }
      const e = state.enrollment;
      if (!e) return null;
      const out: Record<string, string> =
        e.strategy === 'phone_code'
        ? { factorId: e.factorId, enrollStrategy: 'phone_code', code: values.code ?? '' }
        : { factorId: e.factorId, code: values.code ?? '', secondCode: values.secondCode ?? '' };
      return out;
    },
    reset() {
      generation += 1;
      attemptId = null;
      phone = '';
      state = empty();
      set({});
    },
  };
  return controller;
}

/**
 * The enrolment form's submit button: the catalog key of its label, or null
 * when the step has nothing to submit yet (choosing a method, or fetching the
 * authenticator's setup). `mfa.sendCode` before a code was texted.
 */
export function enrollmentSubmitKey(state: MfaEnrollmentState): 'mfa.sendCode' | 'signIn.submit' | null {
  if (state.method === null) return null;
  if (state.method === 'phone_code' && !state.enrollment) return 'mfa.sendCode';
  return state.enrollment ? 'signIn.submit' : null;
}

/**
 * "Text me a code instead" / "Email me a code instead" at the second-factor
 * step: `prepare_second_factor` sends the code (to the account's enrolled phone,
 * or its verified email), and it is then submitted like any second-factor code.
 * Resolves the masked number / address; throws with the server's message (and
 * `code`) when the channel is not offered for this sign-in.
 */
export async function prepareSecondFactorCode(
  client: FapiClient,
  attemptId: string,
  strategy: 'sms' | 'email_code',
): Promise<{ sentTo: string }> {
  const response = await client.post<{ sent_to?: unknown }>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_second_factor`,
    { strategy },
  );
  if (!response.ok) {
    const first = response.errors[0];
    const error = new Error(first?.message ?? 'Could not send the code.') as Error & { code?: string };
    if (first?.code) error.code = first.code;
    throw error;
  }
  return { sentTo: typeof response.data?.sent_to === 'string' ? response.data.sent_to : '' };
}

/**
 * The recovery codes in an `attempt_mfa_enrollment` response (`backup_codes`):
 * the non-empty strings, or null when there are none.
 */
export function recoveryCodesFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const codes = value.filter((c): c is string => typeof c === 'string' && c.length > 0);
  return codes.length ? codes : null;
}

/**
 * The recovery codes to show before the sign-in finishes: set while an
 * enrolment has completed the attempt and the user has not yet said they saved
 * them. A component that gets codes here draws them (once) instead of the
 * finished step, and holds the ticket exchange until
 * {@link acknowledgeRecoveryCodes}.
 */
export function pendingRecoveryCodes(state: Pick<FlowState, 'attempt' | 'recoveryCodes'>): string[] | null {
  if (state.attempt?.status !== 'complete') return null;
  return state.recoveryCodes && state.recoveryCodes.length ? state.recoveryCodes : null;
}

/** The flow once the user has saved the codes: forgotten, ready for the ticket exchange. */
export function acknowledgeRecoveryCodes(state: FlowState): FlowState {
  return { ...state, recoveryCodes: null };
}

/** The codes as a text file's contents: one per line. */
export function recoveryCodesText(codes: readonly string[]): string {
  return `${codes.join('\n')}\n`;
}

/** Copy the codes (one per line) to the clipboard. Resolves whether it worked. */
export async function copyRecoveryCodes(codes: readonly string[]): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?(text: string): Promise<void> } } }).navigator
    ?.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(codes.join('\n'));
    return true;
  } catch {
    return false;
  }
}

/** Whether this page can offer the codes as a download. */
export function canDownloadRecoveryCodes(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

/**
 * Save the codes as a .txt file (`recovery-codes.txt`) through a temporary
 * object URL, revoked straight after. Returns whether the download started.
 */
export function downloadRecoveryCodes(codes: readonly string[], filename = 'recovery-codes.txt'): boolean {
  if (!canDownloadRecoveryCodes()) return false;
  const url = URL.createObjectURL(new Blob([recoveryCodesText(codes)], { type: 'text/plain;charset=utf-8' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body ?? document.documentElement).appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
