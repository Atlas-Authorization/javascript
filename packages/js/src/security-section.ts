/**
 * The view-model of one account-security screen section, with no UI and no framework.
 *
 * `createSecuritySection({ client, kind })` loads what the section lists (sessions, second factors, passkeys,
 * phone numbers, recovery codes, connected accounts, the password), keeps the step the person is on (the list,
 * a QR code to scan, a code to type, recovery codes to save) and runs the actions. When the server asks the
 * person to prove a credential again (`STEP_UP_REQUIRED`), the section re-authenticates through your `choose`
 * callback and retries once; without `choose` the refusal is reported as `stepUpRequired` in the view.
 * Errors are sentences in the app's language (`localization`), never codes.
 *
 * Render `getView()`, call the actions, re-render on `subscribe`.
 */
import type { FieldError } from './attempt';
import { localizedErrorMessage, type ErrorStrings } from './errors';
import type { FapiClient } from './fapi';
import {
  changePassword,
  listMfaFactors,
  listPasskeys,
  listSessions,
  regenerateBackupCodes,
  removeMfaFactor,
  removePasskey,
  revokeAccountSession,
  revokeAllSessions,
  setPassword,
  startSms,
  startTotp,
  unlinkExternalAccount,
  verifySms,
  verifyTotp,
  type TotpEnrollment,
} from './account-security';
import {
  addPhoneNumber,
  attemptPhoneNumberVerification,
  listPhoneNumbers,
  PhoneNumberRequestError,
  preparePhoneNumberVerification,
  removePhoneNumber,
  setPrimaryPhoneNumber,
} from './phone-numbers';
import { createStepUp, type StepUpFlowOptions } from './step-up-flow';
import { StepUpCancelledError } from './step-up';

export type SecuritySectionKind = 'sessions' | 'mfa' | 'passkeys' | 'phones' | 'recovery_codes' | 'connected_accounts' | 'password';

/** `list`: the items. The others are the step of a flow inside the section. */
export type SecuritySectionStep = 'list' | 'totp_enroll' | 'sms_verify' | 'phone_verify' | 'recovery_codes' | 'change_password' | 'set_password';

export interface SectionField {
  name: 'code' | 'second_code' | 'current_password' | 'new_password';
  kind: 'code' | 'password';
  autoComplete: 'one-time-code' | 'current-password' | 'new-password';
  secure: boolean;
}

/** One row of a list. `label` is the raw name (a device, a number, a provider, a factor type such as `totp`); localize the generic ones. */
export interface SecurityItem {
  id: string;
  label: string | null;
  detail: string | null;
  /** The session making this call (sessions). */
  current: boolean;
  /** The primary number (phones). */
  primary: boolean;
  /** False for a number or factor that was added but not confirmed. */
  verified: boolean;
}

export interface SecuritySectionView {
  kind: SecuritySectionKind;
  step: SecuritySectionStep;
  /** True until the first load finishes. */
  loading: boolean;
  busy: boolean;
  items: SecurityItem[];
  /** The form to draw for the current step. */
  fields: SectionField[];
  /** After `startTotp()`: scan `qrSvg` (trusted markup from the server) or type `secret`. */
  enrollment: TotpEnrollment | null;
  /** After a text was sent: the masked number. */
  sentTo: string | null;
  /** Shown once: save them, then `acknowledgeCodes()`. */
  recoveryCodes: string[] | null;
  /** recovery_codes and mfa: how many are left. */
  backupCodesRemaining: number | null;
  /** password: whether the account has one (then `change_password`, else `set_password`). */
  hasPassword: boolean | null;
  /** Action names usable now, e.g. `remove`, `revoke_others`, `start_totp`. */
  actions: string[];
  /** The last failure as a sentence, or null. */
  error: string | null;
  reason: string | null;
  /** The server wants a recent sign-in and no `choose` callback was given. */
  stepUpRequired: boolean;
}

export interface SecuritySectionOptions {
  client: FapiClient;
  kind: SecuritySectionKind;
  /** Asks the person to re-authenticate (see `createStepUp`). Without it a refusal is reported as `stepUpRequired`. */
  choose?: StepUpFlowOptions['choose'];
  /** Runs the passkey prompt for a passkey step-up (React Native: `nativePasskeyAssertion(Passkey)`). */
  passkeyAssertion?: StepUpFlowOptions['passkeyAssertion'];
  /** Registers a passkey on this device (React Native: `registerPasskey` from `@atlasauth/expo-passkeys`); enables `addPasskey()`. */
  addPasskey?: (client: FapiClient) => Promise<{ ok: boolean; errors: FieldError[] }>;
  localization?: ErrorStrings | null;
}

export interface SecuritySection {
  getView(): SecuritySectionView;
  subscribe(listener: (view: SecuritySectionView) => void): () => void;
  /** (Re)read the list. Called once on creation. */
  load(): Promise<void>;
  /** Back to the list from a step inside the section. */
  cancel(): void;
  /** sessions, mfa, passkeys, phones, connected_accounts: remove one row (sessions: sign it out). */
  remove(id: string): Promise<void>;
  /** sessions: sign every other session out. */
  revokeOthers(): Promise<void>;
  /** mfa: begin an authenticator app; the step becomes `totp_enroll`. */
  startTotp(): Promise<void>;
  /** mfa: text a code to `phone` (E.164); the step becomes `sms_verify`. */
  startSms(phone: string): Promise<void>;
  /** phones: add a number and text it a code; the step becomes `phone_verify`. */
  addPhone(phone: string): Promise<void>;
  /** phones: text a new code to a number that is not verified yet; the step becomes `phone_verify`. */
  verifyPhone(id: string): Promise<void>;
  /** phones: make a verified number primary. */
  makePrimary(id: string): Promise<void>;
  /** passkeys: register one on this device (needs the `addPasskey` option). */
  addPasskey(): Promise<void>;
  /** recovery_codes: make a new set (the old ones stop working); the step becomes `recovery_codes`. */
  regenerateCodes(): Promise<void>;
  /** The person saved the recovery codes. */
  acknowledgeCodes(): void;
  /** Submit the form of the current step, values by field name. */
  submit(values: Record<string, string>): Promise<void>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; errors: FieldError[]; stepUpRequired: boolean };

const FIELD = {
  code: { name: 'code', kind: 'code', autoComplete: 'one-time-code', secure: false },
  second_code: { name: 'second_code', kind: 'code', autoComplete: 'one-time-code', secure: false },
  current_password: { name: 'current_password', kind: 'password', autoComplete: 'current-password', secure: true },
  new_password: { name: 'new_password', kind: 'password', autoComplete: 'new-password', secure: true },
} satisfies Record<string, SectionField>;

const ACTIONS: Record<SecuritySectionKind, string[]> = {
  sessions: ['remove', 'revoke_others'],
  mfa: ['start_totp', 'start_sms', 'remove'],
  passkeys: ['remove'],
  phones: ['add_phone', 'verify_phone', 'make_primary', 'remove'],
  recovery_codes: ['regenerate_codes'],
  connected_accounts: ['remove'],
  password: ['submit'],
};

const fail = (errors: FieldError[], stepUpRequired = false): Outcome<never> => ({ ok: false, errors, stepUpRequired });

/** A helper result (`{ ok, errors, stepUpRequired? }`) as an Outcome. */
function fromResult<R extends { ok: boolean }>(r: R): Outcome<Extract<R, { ok: true }>> {
  if (r.ok) return { ok: true, value: r as Extract<R, { ok: true }> };
  const f = r as unknown as { errors: FieldError[]; stepUpRequired?: boolean };
  return fail(f.errors, f.stepUpRequired === true);
}

/** A helper that throws (phone numbers) as an Outcome. */
async function fromThrow<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof PhoneNumberRequestError) {
      return fail([{ code: e.code, message: e.message, ...(e.param ? { param: e.param } : {}), ...(e.reason ? { reason: e.reason } : {}) }], e.needsReverification);
    }
    return fail([{ code: 'REQUEST_FAILED', message: e instanceof Error ? e.message : 'The request failed.' }]);
  }
}

export function createSecuritySection(opts: SecuritySectionOptions): SecuritySection {
  const { client, kind } = opts;
  const stepper = opts.choose ? createStepUp({ client, choose: opts.choose, ...(opts.passkeyAssertion ? { passkeyAssertion: opts.passkeyAssertion } : {}) }) : null;
  const listeners = new Set<(v: SecuritySectionView) => void>();

  let step: SecuritySectionStep = 'list';
  let loading = true;
  let busy = false;
  let items: SecurityItem[] = [];
  let enrollment: TotpEnrollment | null = null;
  let factorId: string | null = null;
  let phoneId: string | null = null;
  let sentTo: string | null = null;
  let recoveryCodes: string[] | null = null;
  let backupCodesRemaining: number | null = null;
  let hasPassword: boolean | null = null;
  let failure: FieldError | null = null;
  let stepUpRequired = false;

  const fieldsFor = (): SectionField[] => {
    switch (step) {
      case 'totp_enroll': return enrollment && enrollment.requiredCodes > 1 ? [FIELD.code, FIELD.second_code] : [FIELD.code];
      case 'sms_verify':
      case 'phone_verify': return [FIELD.code];
      case 'change_password': return [FIELD.current_password, FIELD.new_password];
      case 'set_password': return [FIELD.new_password];
      default: return [];
    }
  };

  const view = (): SecuritySectionView => ({
    kind,
    step,
    loading,
    busy,
    items,
    fields: fieldsFor(),
    enrollment,
    sentTo,
    recoveryCodes,
    backupCodesRemaining,
    hasPassword,
    actions: [...ACTIONS[kind], ...(kind === 'passkeys' && opts.addPasskey ? ['add_passkey'] : [])],
    error: failure ? localizedErrorMessage(failure, opts.localization) : null,
    reason: failure?.reason ?? null,
    stepUpRequired,
  });
  let current = view();
  const emit = () => {
    current = view();
    for (const l of listeners) l(current);
  };

  /** Run a call; on STEP_UP_REQUIRED re-authenticate through `choose` and run it once more. */
  const guard = async <T>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    const first = await call();
    if (first.ok || !first.stepUpRequired || !stepper) return first;
    try {
      await stepper.reauthenticate('sensitive_action');
    } catch (e) {
      if (e instanceof StepUpCancelledError) return fail([{ code: e.code, reason: 'step_up_cancelled', message: e.message }], true);
      const err = e as Error & { code?: string; reason?: string };
      return fail([{ code: err.code ?? 'UNAUTHENTICATED', ...(err.reason ? { reason: err.reason } : {}), message: err.message }], true);
    }
    return call();
  };

  /** Run an action: busy, step-up, publish the failure; `onOk` folds the value in. */
  const act = async <T>(call: () => Promise<Outcome<T>>, onOk: (value: T) => Promise<void> | void) => {
    busy = true;
    failure = null;
    stepUpRequired = false;
    emit();
    const out = await guard(call);
    if (out.ok) await onOk(out.value);
    else {
      failure = out.errors[0] ?? { code: 'REQUEST_FAILED', message: 'The request failed.' };
      stepUpRequired = out.stepUpRequired && !stepper;
    }
    busy = false;
    emit();
  };

  const read = async (): Promise<Outcome<void>> => {
    const apply = <V>(o: Outcome<V>, fold: (v: V) => void): Outcome<void> => (o.ok ? (fold(o.value), { ok: true, value: undefined }) : o);
    switch (kind) {
      case 'sessions':
        return apply(fromResult(await listSessions(client)), (r) => {
          items = r.sessions.map((s) => ({ id: s.id, label: s.deviceLabel ?? ([s.browser, s.os].filter(Boolean).join(' on ') || null), detail: s.location ?? s.ipAddress, current: s.current, primary: false, verified: true }));
        });
      case 'mfa':
      case 'recovery_codes':
        return apply(fromResult(await listMfaFactors(client)), (r) => {
          backupCodesRemaining = r.backupCodesRemaining;
          items = kind === 'mfa' ? r.factors.map((f) => ({ id: f.id, label: f.type, detail: f.phone ?? null, current: false, primary: false, verified: f.verified })) : [];
        });
      case 'passkeys':
        return apply(fromResult(await listPasskeys(client)), (r) => {
          items = r.passkeys.map((p) => ({ id: p.id, label: p.name ?? p.authenticator?.name ?? null, detail: null, current: false, primary: false, verified: true }));
        });
      case 'phones':
        return apply(await fromThrow(() => listPhoneNumbers(client)), (list) => {
          items = list.map((n) => ({ id: n.id, label: n.phone_number, detail: null, current: false, primary: n.primary, verified: n.verified }));
        });
      case 'connected_accounts':
      case 'password': {
        const me = await client.get<{ has_password?: boolean; external_accounts?: Array<{ id: string; provider: string; provider_email?: string | null }> }>('/v1/client/me');
        if (!me.ok || !me.data) return fail(me.errors);
        hasPassword = me.data.has_password === true;
        if (kind === 'connected_accounts') items = (me.data.external_accounts ?? []).map((a) => ({ id: a.id, label: a.provider, detail: a.provider_email ?? null, current: false, primary: false, verified: true }));
        if (kind === 'password') step = hasPassword ? 'change_password' : 'set_password';
        return { ok: true, value: undefined };
      }
    }
  };

  const load = async () => {
    busy = true;
    failure = null;
    stepUpRequired = false;
    emit();
    const out = await guard(read);
    if (!out.ok) {
      failure = out.errors[0] ?? { code: 'REQUEST_FAILED', message: 'The request failed.' };
      stepUpRequired = out.stepUpRequired && !stepper;
    }
    loading = false;
    busy = false;
    emit();
  };

  const toList = () => {
    step = kind === 'password' ? (hasPassword ? 'change_password' : 'set_password') : 'list';
    enrollment = null;
    factorId = null;
    phoneId = null;
    sentTo = null;
    return read().then(() => undefined);
  };
  const showCodes = (codes: string[]) => {
    recoveryCodes = codes;
    step = 'recovery_codes';
  };

  void load();

  return {
    getView: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    cancel() {
      failure = null;
      void toList().then(emit);
    },
    remove: (id) =>
      act(
        async (): Promise<Outcome<unknown>> => {
          if (kind === 'sessions') return fromResult(await revokeAccountSession(client, id));
          if (kind === 'mfa') return fromResult(await removeMfaFactor(client, id));
          if (kind === 'passkeys') return fromResult(await removePasskey(client, id));
          if (kind === 'phones') return fromThrow(() => removePhoneNumber(client, id));
          if (kind === 'connected_accounts') return fromResult(await unlinkExternalAccount(client, id));
          return fail([{ code: 'NOT_SUPPORTED', message: 'Nothing to remove here.' }]);
        },
        () => toList(),
      ),
    revokeOthers: () => act(async (): Promise<Outcome<unknown>> => (kind === 'sessions' ? fromResult(await revokeAllSessions(client)) : fail([{ code: 'NOT_SUPPORTED', message: 'Not available here.' }])), () => toList()),
    startTotp: () =>
      act(async () => fromResult(await startTotp(client)), (r) => {
        enrollment = r.enrollment;
        factorId = r.enrollment.factorId;
        step = 'totp_enroll';
      }),
    startSms: (phone) =>
      act(async () => fromResult(await startSms(client, phone.trim())), (r) => {
        factorId = r.factorId;
        sentTo = r.phone;
        step = 'sms_verify';
      }),
    addPhone: (phone) =>
      act(() => fromThrow(() => addPhoneNumber(client, phone.trim())), (n) => {
        phoneId = n.id;
        sentTo = n.phone_number;
        step = 'phone_verify';
      }),
    verifyPhone: (id) =>
      act(() => fromThrow(() => preparePhoneNumberVerification(client, id)), (n) => {
        phoneId = n.id;
        sentTo = n.phone_number;
        step = 'phone_verify';
      }),
    makePrimary: (id) => act(() => fromThrow(() => setPrimaryPhoneNumber(client, id)), () => toList()),
    addPasskey: () =>
      act(
        async (): Promise<Outcome<void>> => {
          if (!opts.addPasskey) return fail([{ code: 'NOT_SUPPORTED', reason: 'native_unavailable', message: 'Passkeys are not set up in this app.' }]);
          const r = await opts.addPasskey(client);
          return r.ok ? { ok: true, value: undefined } : fail(r.errors, r.errors.some((e) => e.code === 'STEP_UP_REQUIRED'));
        },
        () => toList(),
      ),
    regenerateCodes: () => act(async () => fromResult(await regenerateBackupCodes(client)), (r) => showCodes(r.codes)),
    acknowledgeCodes() {
      recoveryCodes = null;
      void toList().then(emit);
    },
    submit: (values) => {
      const code = (values.code ?? '').trim();
      if (step === 'totp_enroll' && factorId) {
        const id = factorId;
        const codes = [code, (values.second_code ?? '').trim()].filter(Boolean);
        return act(async () => fromResult(await verifyTotp(client, id, codes)), (r) => (r.backupCodes?.length ? showCodes(r.backupCodes) : toList()));
      }
      if (step === 'sms_verify' && factorId) {
        const id = factorId;
        return act(async () => fromResult(await verifySms(client, id, code)), (r) => (r.backupCodes?.length ? showCodes(r.backupCodes) : toList()));
      }
      if (step === 'phone_verify' && phoneId) {
        const id = phoneId;
        return act(() => fromThrow(() => attemptPhoneNumberVerification(client, id, code)), () => toList());
      }
      if (step === 'change_password') {
        return act(async () => fromResult(await changePassword(client, { currentPassword: values.current_password ?? '', newPassword: values.new_password ?? '' })), () => undefined);
      }
      if (step === 'set_password') {
        return act(
          async () => fromResult(await setPassword(client, values.new_password ?? '')),
          () => {
            hasPassword = true;
            step = 'change_password';
          },
        );
      }
      return Promise.resolve();
    },
  };
}
