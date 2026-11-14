import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';
import type { ScreenField, SecuritySectionView, SignInMethod, SignInScreenView } from '@atlasauth/js';

/*
 * The element builders behind the default React Native screens. They are plain functions from a view-model to
 * React elements over an injected set of primitives, so they are unit-tested without a renderer (pass string
 * element types and read the tree) and `native-screens.tsx`, the only file that imports `react-native`, stays a
 * thin layer of hooks and state. Thin on purpose: every decision (which step, which fields, which error) is in
 * the view-model from `@atlasauth/js`; these only draw it, with a theme and per-element style overrides.
 */

type Any = ComponentType<any> | string;

/** The `react-native` components the screens draw with. */
export interface ScreenPrimitives {
  View: Any;
  Text: Any;
  TextInput: Any;
  Pressable: Any;
  ScrollView: Any;
  ActivityIndicator: Any;
  Switch: Any;
}

/** Colours and sizes the default screens use. Override any of them with `theme`. */
export interface ScreenTheme {
  background: string;
  text: string;
  muted: string;
  primary: string;
  primaryText: string;
  border: string;
  danger: string;
  radius: number;
  spacing: number;
  fontSize: number;
}

export const DEFAULT_SCREEN_THEME: ScreenTheme = {
  background: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  primary: '#2563eb',
  primaryText: '#ffffff',
  border: '#d1d5db',
  danger: '#b91c1c',
  radius: 8,
  spacing: 12,
  fontSize: 16,
};

/** Style objects merged over the themed defaults, by element role. */
export interface ScreenStyles {
  root?: object;
  title?: object;
  text?: object;
  label?: object;
  input?: object;
  button?: object;
  buttonText?: object;
  primaryButton?: object;
  primaryButtonText?: object;
  link?: object;
  error?: object;
  chip?: object;
  chipSelected?: object;
  row?: object;
  code?: object;
}

/** Every string the screens show, English by default. Override any key (a translation, different wording). */
export const DEFAULT_SCREEN_STRINGS: Record<string, string> = {
  'step.details': 'Create your account',
  'step.identifier': 'Sign in',
  'step.first_factor': 'Enter your password',
  'step.second_factor': 'Confirm it is you',
  'step.captcha': 'Security check',
  'step.redirect': 'Continuing',
  'step.enroll_second_factor': 'Set up a second factor',
  'step.recovery_codes': 'Save your recovery codes',
  'step.policies': 'Accept to continue',
  'step.email_verification': 'Check your email',
  'step.required_action': 'One more step',
  'step.other': 'Continue in the app',
  'step.complete': 'You are signed in',
  'field.identifier': 'Email, phone or username',
  'field.email': 'Email',
  'field.password': 'Password',
  'field.new_password': 'New password',
  'field.code': 'Code',
  'field.second_code': 'Next code',
  'field.phone': 'Phone number',
  'field.first_name': 'First name',
  'field.last_name': 'Last name',
  'field.username': 'Username',
  'method.password': 'Password',
  'method.email_code': 'Email me a code',
  'method.passkey': 'Passkey',
  'method.apple': 'Continue with Apple',
  'method.google': 'Continue with Google',
  'method.totp': 'Authenticator app',
  'method.sms': 'Text message',
  'method.backup_code': 'Recovery code',
  'action.continue': 'Continue',
  'action.send_code': 'Send a code',
  'action.resend': 'Send again',
  'action.skip': 'Skip for now',
  'action.accept': 'Accept',
  'action.saved_codes': 'I saved them',
  'action.open': 'Open',
  'action.check': 'I have done it',
  'action.start_over': 'Start over',
  'action.back': 'Back',
  'action.remove': 'Remove',
  'action.add_passkey': 'Add a passkey',
  'action.authenticator': 'Set up an authenticator app',
  'action.sms': 'Add a text message number',
  'action.sign_out_others': 'Sign out other devices',
  'action.new_codes': 'Make new recovery codes',
  'action.add_phone': 'Add a phone number',
  'action.make_primary': 'Make primary',
  'action.verify': 'Verify',
  'text.secret': 'Or type this key into your authenticator app:',
  'text.sent_to': 'We sent a code to {to}.',
  'text.legal': 'I agree to the terms and privacy policy',
  'text.terms': 'Terms',
  'text.privacy': 'Privacy',
  'text.current': 'This device',
  'text.primary': 'Primary',
  'text.unverified': 'Not verified',
  'text.empty': 'Nothing here yet.',
  'text.loading': 'Loading',
  'text.step_up': 'For your security, sign in again to continue.',
  'section.sessions': 'Devices and sessions',
  'section.mfa': 'Second factor',
  'section.passkeys': 'Passkeys',
  'section.phones': 'Phone numbers',
  'section.recovery_codes': 'Recovery codes',
  'section.connected_accounts': 'Connected accounts',
  'section.password': 'Password',
  'step.totp_enroll': 'Set up an authenticator app',
  'step.sms_verify': 'Confirm your number',
  'step.phone_verify': 'Confirm your number',
  'step.change_password': 'Change your password',
  'step.set_password': 'Set a password',
  'field.current_password': 'Current password',
};

const t = (strings: Record<string, string> | undefined, key: string, vars?: Record<string, string>): string => {
  const template = strings?.[key] ?? DEFAULT_SCREEN_STRINGS[key] ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m) : template;
};

const el = (type: Any, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement =>
  createElement(type as never, props as never, ...children);

export interface RenderEnv {
  ui: ScreenPrimitives;
  theme?: Partial<ScreenTheme>;
  styles?: ScreenStyles;
  strings?: Record<string, string>;
  /** Open a link (a policy, a verification page); the default screens call `Linking.openURL`. */
  onLink?: (href: string) => void;
}

const themeOf = (env: RenderEnv): ScreenTheme => ({ ...DEFAULT_SCREEN_THEME, ...env.theme });

function look(env: RenderEnv) {
  const th = themeOf(env);
  const s = env.styles ?? {};
  return {
    th,
    root: { backgroundColor: th.background, padding: th.spacing * 1.5, gap: th.spacing, ...s.root },
    title: { color: th.text, fontSize: th.fontSize * 1.5, fontWeight: '600', ...s.title },
    text: { color: th.text, fontSize: th.fontSize, ...s.text },
    muted: { color: th.muted, fontSize: th.fontSize * 0.9, ...s.text },
    label: { color: th.muted, fontSize: th.fontSize * 0.85, marginBottom: 4, ...s.label },
    input: { borderWidth: 1, borderColor: th.border, borderRadius: th.radius, padding: th.spacing, color: th.text, fontSize: th.fontSize, ...s.input },
    button: { borderWidth: 1, borderColor: th.border, borderRadius: th.radius, padding: th.spacing, alignItems: 'center', ...s.button },
    buttonText: { color: th.text, fontSize: th.fontSize, ...s.buttonText },
    primary: { backgroundColor: th.primary, borderColor: th.primary, ...s.primaryButton },
    primaryText: { color: th.primaryText, fontSize: th.fontSize, fontWeight: '600', ...s.primaryButtonText },
    link: { color: th.primary, fontSize: th.fontSize, ...s.link },
    error: { color: th.danger, fontSize: th.fontSize * 0.95, ...s.error },
    chip: { borderWidth: 1, borderColor: th.border, borderRadius: th.radius, paddingVertical: 6, paddingHorizontal: th.spacing, ...s.chip },
    chipOn: { backgroundColor: th.primary, borderColor: th.primary, ...s.chipSelected },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: th.spacing / 2, alignItems: 'center', ...s.row },
    code: { color: th.text, fontFamily: 'Courier', fontSize: th.fontSize, ...s.code },
  };
}

/** A pressable that reads as a button (`primary`) or a text link (`link`). */
function button(env: RenderEnv, label: string, onPress: () => void, kind: 'primary' | 'plain' | 'link' = 'plain', extra: Record<string, unknown> = {}): ReactElement {
  const l = look(env);
  const { ui } = env;
  if (kind === 'link') {
    return el(ui.Pressable, { key: label, accessibilityRole: 'link', onPress, ...extra }, el(ui.Text, { style: l.link }, label));
  }
  return el(
    ui.Pressable,
    { key: label, accessibilityRole: 'button', onPress, style: kind === 'primary' ? [l.button, l.primary] : l.button, ...extra },
    el(ui.Text, { style: kind === 'primary' ? l.primaryText : l.buttonText }, label),
  );
}

/** Field values the person typed, by field name. A multi-select holds a list; everything else a string. */
export type FieldValues = Record<string, string | string[]>;

const KEYBOARD: Partial<Record<ScreenField['kind'], string>> = { email: 'email-address', phone: 'phone-pad', number: 'numeric', code: 'number-pad', file: 'url' };
const AUTOCOMPLETE: Record<ScreenField['autoComplete'], string> = {
  username: 'username',
  'current-password': 'current-password',
  'new-password': 'new-password',
  'one-time-code': 'one-time-code',
  tel: 'tel',
  email: 'email',
  off: 'off',
};

/** The text shown for a field: the server's label for a journey field, a known string for the built-in ones. */
export function fieldLabel(field: ScreenField, strings?: Record<string, string>): string {
  if (field.label) return field.label + (field.required ? ' *' : '');
  const key = `field.${field.name}`;
  return strings?.[key] ?? DEFAULT_SCREEN_STRINGS[key] ?? field.name;
}

/** One field: a text box, a switch, a list of choices or a reference box, by `kind`. */
export function renderField(env: RenderEnv, field: ScreenField, value: string | string[] | undefined, onChange: (next: string | string[]) => void): ReactElement {
  const l = look(env);
  const { ui } = env;
  const label = fieldLabel(field, env.strings);
  const help = field.help ? el(ui.Text, { key: 'help', style: l.muted }, field.help) : null;

  if (field.kind === 'checkbox') {
    const on = value === 'true';
    return el(
      ui.View,
      { key: field.name, style: l.row },
      el(ui.Switch, { value: on, onValueChange: (v: boolean) => onChange(v ? 'true' : 'false'), accessibilityLabel: label }),
      el(ui.Text, { style: l.text }, label + ' '),
      // Only an https link is ever offered.
      field.link && field.link.url.startsWith('https://') ? button(env, field.link.text, () => env.onLink?.(field.link!.url), 'link') : null,
      help,
    );
  }

  if (field.kind === 'select' || field.kind === 'multi_select') {
    const multi = field.kind === 'multi_select';
    const picked = Array.isArray(value) ? value : value ? [value] : [];
    return el(
      ui.View,
      { key: field.name },
      el(ui.Text, { style: l.label }, label),
      el(
        ui.View,
        { style: l.row },
        (field.options ?? []).map((o) => {
          const on = picked.includes(o);
          return el(
            ui.Pressable,
            {
              key: o,
              accessibilityRole: multi ? 'checkbox' : 'radio',
              accessibilityState: { selected: on, checked: on },
              onPress: () => onChange(multi ? (on ? picked.filter((x) => x !== o) : [...picked, o]) : o),
              style: on ? [l.chip, l.chipOn] : l.chip,
            },
            el(ui.Text, { style: on ? l.primaryText : l.buttonText }, field.optionLabels?.[o] ?? o),
          );
        }),
      ),
      help,
    );
  }

  const text = typeof value === 'string' ? value : '';
  return el(
    ui.View,
    { key: field.name },
    el(ui.Text, { style: l.label }, label),
    el(ui.TextInput, {
      value: text,
      onChangeText: (v: string) => onChange(v),
      secureTextEntry: field.secure,
      autoComplete: AUTOCOMPLETE[field.autoComplete],
      autoCapitalize: field.kind === 'text' || field.kind === 'textarea' ? undefined : 'none',
      autoCorrect: false,
      keyboardType: KEYBOARD[field.kind],
      multiline: field.kind === 'textarea',
      placeholder: field.kind === 'date' ? 'YYYY-MM-DD' : field.placeholder,
      accessibilityLabel: label,
      style: l.input,
    }),
    help,
  );
}

/** What a screen can do, as the view-model offers it. A sign-in screen and a sign-up screen both satisfy it. */
export interface AuthActions {
  submit(values?: Record<string, string>): Promise<void>;
  selectMethod(method: SignInMethod): Promise<void>;
  sendCode(): Promise<void>;
  resend(): Promise<void>;
  signInWithPasskey?(): Promise<void>;
  signInWithApple?(): Promise<void>;
  signInWithGoogle?(): Promise<void>;
  acknowledgeRecoveryCodes(): Promise<void>;
  acceptPolicies(): Promise<void>;
  startIdentityVerification(redirectUrl?: string): Promise<void>;
  checkIdentityVerification(): Promise<void>;
  /** journey_form: keep the answers so far. The bound screens call it (debounced) as the person types. */
  saveDraft?(values?: Record<string, string>): Promise<void>;
  reset(): void;
}

export interface AuthScreenProps {
  view: SignInScreenView;
  actions: AuthActions;
  values: FieldValues;
  onValues: (next: FieldValues) => void;
}

/** A list value as a form submits it: a multi-select travels comma-joined. */
export const toSubmitValues = (values: FieldValues): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));

const SIGN_IN_METHOD_LABEL = (m: SignInMethod) => `method.${m}`;

/** The whole screen for the view's current step. */
export function renderAuthScreen(env: RenderEnv, p: AuthScreenProps): ReactElement {
  const { view, actions } = p;
  const l = look(env);
  const { ui } = env;
  const s = env.strings;
  const set = (name: string) => (next: string | string[]) => p.onValues({ ...p.values, [name]: next });
  const submit = () => void actions.submit(toSubmitValues(p.values));
  const kids: ReactNode[] = [];

  const heading = view.requiredAction?.title || t(s, `step.${view.step}`);
  kids.push(el(ui.Text, { key: 'title', accessibilityRole: 'header', style: l.title }, heading));
  if (view.requiredAction?.intro) kids.push(el(ui.Text, { key: 'intro', style: l.text }, view.requiredAction.intro));
  if (view.sentTo) kids.push(el(ui.Text, { key: 'sent', style: l.muted }, t(s, 'text.sent_to', { to: view.sentTo })));
  if (view.error) kids.push(el(ui.Text, { key: 'error', accessibilityRole: 'alert', style: l.error }, view.error));
  if (view.busy) kids.push(el(ui.ActivityIndicator, { key: 'busy' }));

  // The one-tap sign-ins sit above the form on the identifier step.
  if (view.step === 'identifier') {
    for (const m of view.alternatives) {
      const run = m === 'passkey' ? actions.signInWithPasskey : m === 'apple' ? actions.signInWithApple : actions.signInWithGoogle;
      if (run) kids.push(button(env, t(s, SIGN_IN_METHOD_LABEL(m)), () => void run(), 'plain', { key: `alt-${m}` }));
    }
  }

  // Choose among methods (a password or an emailed code; an authenticator, a text, a recovery code).
  if (view.methods.length > 1) {
    kids.push(
      el(
        ui.View,
        { key: 'methods', style: l.row },
        view.methods.map((m) =>
          el(
            ui.Pressable,
            { key: m, accessibilityRole: 'radio', accessibilityState: { selected: view.method === m }, onPress: () => void actions.selectMethod(m), style: view.method === m ? [l.chip, l.chipOn] : l.chip },
            el(ui.Text, { style: view.method === m ? l.primaryText : l.buttonText }, t(s, SIGN_IN_METHOD_LABEL(m))),
          ),
        ),
      ),
    );
  }

  // Setting up an authenticator app: the key to type, and a slot for a QR code the app draws.
  if (view.enrollment?.totp) {
    kids.push(el(ui.Text, { key: 'secret-hint', style: l.muted }, t(s, 'text.secret')));
    kids.push(el(ui.Text, { key: 'secret', selectable: true, style: l.code }, view.enrollment.totp.secret));
  }

  if (view.step === 'recovery_codes' && view.recoveryCodes) {
    kids.push(el(ui.View, { key: 'codes' }, view.recoveryCodes.map((c) => el(ui.Text, { key: c, selectable: true, style: l.code }, c))));
    kids.push(button(env, t(s, 'action.saved_codes'), () => void actions.acknowledgeRecoveryCodes(), 'primary', { key: 'saved' }));
    return screen(env, kids);
  }

  if (view.step === 'policies') {
    for (const policy of view.policies) {
      kids.push(el(ui.Text, { key: policy.policy_id, style: l.text }, policy.title));
      if (policy.reaccept && policy.summary_of_changes) kids.push(el(ui.Text, { key: `${policy.policy_id}-s`, style: l.muted }, policy.summary_of_changes));
    }
    kids.push(button(env, t(s, 'action.accept'), () => void actions.acceptPolicies(), 'primary', { key: 'accept' }));
    return screen(env, kids);
  }

  // identity_verification and a custom step send the person elsewhere.
  const ra = view.requiredAction;
  if (ra && (ra.kind === 'identity_verification' || ra.kind === 'custom')) {
    if (ra.url) kids.push(button(env, t(s, 'action.open'), () => env.onLink?.(ra.url!), 'plain', { key: 'open' }));
    if (ra.kind === 'identity_verification') {
      kids.push(button(env, t(s, ra.status ? 'action.check' : 'action.continue'), () => void (ra.status ? actions.checkIdentityVerification() : actions.startIdentityVerification()), 'primary', { key: 'idv' }));
    }
    return screen(env, kids);
  }

  for (const field of view.fields) {
    const raw = p.values[field.name];
    const shown = raw === undefined && field.value !== undefined ? (Array.isArray(field.value) ? field.value : String(field.value)) : raw;
    kids.push(
      renderField(env, field, shown, (next) => p.onValues({ ...p.values, [field.name]: next })),
    );
  }

  // Legal consent on a sign-up form: one switch, with the links the instance published.
  if (view.step === 'details' && view.legal && (view.legal.termsUrl || view.legal.privacyUrl)) {
    kids.push(
      el(
        ui.View,
        { key: 'legal', style: l.row },
        el(ui.Switch, { value: p.values.consent === 'true', onValueChange: (v: boolean) => set('consent')(v ? 'true' : 'false'), accessibilityLabel: t(s, 'text.legal') }),
        el(ui.Text, { style: l.text }, t(s, 'text.legal') + ' '),
        view.legal.termsUrl?.startsWith('https://') ? button(env, t(s, 'text.terms'), () => env.onLink?.(view.legal!.termsUrl!), 'link', { key: 'terms' }) : null,
        view.legal.privacyUrl?.startsWith('https://') ? button(env, t(s, 'text.privacy'), () => env.onLink?.(view.legal!.privacyUrl!), 'link', { key: 'privacy' }) : null,
      ),
    );
  }

  if (view.needsSend) kids.push(button(env, t(s, 'action.send_code'), () => void actions.sendCode(), 'plain', { key: 'send' }));
  else if (view.codeSent) kids.push(button(env, t(s, 'action.resend'), () => void actions.resend(), 'link', { key: 'resend' }));

  if (view.fields.length > 0 || view.step === 'second_factor') {
    kids.push(button(env, t(s, 'action.continue'), submit, 'primary', { key: 'submit', disabled: view.busy }));
  }
  if (ra?.skippable) kids.push(button(env, t(s, 'action.skip'), () => void actions.submit({ skip: 'true' }), 'link', { key: 'skip' }));
  if (view.step !== 'identifier' && view.step !== 'details' && view.step !== 'complete') kids.push(button(env, t(s, 'action.start_over'), () => actions.reset(), 'link', { key: 'reset' }));
  return screen(env, kids);
}

function screen(env: RenderEnv, kids: ReactNode[]): ReactElement {
  return el(env.ui.ScrollView, { keyboardShouldPersistTaps: 'handled', contentContainerStyle: look(env).root }, ...kids);
}

/** What a security section can do. */
export interface SecurityActions {
  remove(id: string): Promise<void>;
  revokeOthers(): Promise<void>;
  startTotp(): Promise<void>;
  startSms(phone: string): Promise<void>;
  addPhone(phone: string): Promise<void>;
  verifyPhone(id: string): Promise<void>;
  makePrimary(id: string): Promise<void>;
  addPasskey(): Promise<void>;
  regenerateCodes(): Promise<void>;
  acknowledgeCodes(): void;
  cancel(): void;
  submit(values: Record<string, string>): Promise<void>;
}

export interface SecurityScreenProps {
  view: SecuritySectionView;
  actions: SecurityActions;
  values: FieldValues;
  onValues: (next: FieldValues) => void;
}

/** One account-security section: the list (with its row actions), or the step of a flow inside it. */
export function renderSecuritySection(env: RenderEnv, p: SecurityScreenProps): ReactElement {
  const { view, actions } = p;
  const l = look(env);
  const { ui } = env;
  const s = env.strings;
  const kids: ReactNode[] = [];
  kids.push(el(ui.Text, { key: 'title', accessibilityRole: 'header', style: l.title }, view.step === 'list' ? t(s, `section.${view.kind}`) : t(s, `step.${view.step}`)));
  if (view.stepUpRequired) kids.push(el(ui.Text, { key: 'stepup', accessibilityRole: 'alert', style: l.error }, t(s, 'text.step_up')));
  else if (view.error) kids.push(el(ui.Text, { key: 'error', accessibilityRole: 'alert', style: l.error }, view.error));
  if (view.loading || view.busy) kids.push(el(ui.ActivityIndicator, { key: 'busy' }));

  if (view.step === 'recovery_codes' && view.recoveryCodes) {
    kids.push(el(ui.View, { key: 'codes' }, view.recoveryCodes.map((c) => el(ui.Text, { key: c, selectable: true, style: l.code }, c))));
    kids.push(button(env, t(s, 'action.saved_codes'), () => actions.acknowledgeCodes(), 'primary', { key: 'saved' }));
    return el(ui.View, { style: l.root }, ...kids);
  }

  if (view.step !== 'list') {
    if (view.enrollment) {
      kids.push(el(ui.Text, { key: 'secret-hint', style: l.muted }, t(s, 'text.secret')));
      kids.push(el(ui.Text, { key: 'secret', selectable: true, style: l.code }, view.enrollment.secret));
    }
    if (view.sentTo) kids.push(el(ui.Text, { key: 'sent', style: l.muted }, t(s, 'text.sent_to', { to: view.sentTo })));
    for (const f of view.fields) {
      kids.push(
        renderField(env, { name: f.name, kind: f.kind, autoComplete: f.autoComplete, secure: f.secure }, p.values[f.name], (next) => p.onValues({ ...p.values, [f.name]: next })),
      );
    }
    kids.push(button(env, t(s, 'action.continue'), () => void actions.submit(toSubmitValues(p.values)), 'primary', { key: 'submit' }));
    kids.push(button(env, t(s, 'action.back'), () => actions.cancel(), 'link', { key: 'back' }));
    return el(ui.View, { style: l.root }, ...kids);
  }

  if (view.items.length === 0 && !view.loading) kids.push(el(ui.Text, { key: 'empty', style: l.muted }, t(s, 'text.empty')));
  for (const item of view.items) {
    const tags = [item.current ? t(s, 'text.current') : null, item.primary ? t(s, 'text.primary') : null, item.verified ? null : t(s, 'text.unverified')].filter(Boolean).join(' · ');
    kids.push(
      el(
        ui.View,
        { key: item.id, style: l.row },
        el(ui.View, { style: { flexShrink: 1 } }, el(ui.Text, { style: l.text }, item.label ?? item.id), item.detail || tags ? el(ui.Text, { style: l.muted }, [item.detail, tags].filter(Boolean).join(' · ')) : null),
        view.actions.includes('make_primary') && item.verified && !item.primary ? button(env, t(s, 'action.make_primary'), () => void actions.makePrimary(item.id), 'link', { key: 'primary' }) : null,
        view.actions.includes('verify_phone') && !item.verified ? button(env, t(s, 'action.verify'), () => void actions.verifyPhone(item.id), 'link', { key: 'verify' }) : null,
        view.actions.includes('remove') && !item.current ? button(env, t(s, 'action.remove'), () => void actions.remove(item.id), 'link', { key: 'remove' }) : null,
      ),
    );
  }
  if (view.actions.includes('revoke_others')) kids.push(button(env, t(s, 'action.sign_out_others'), () => void actions.revokeOthers(), 'plain', { key: 'others' }));
  if (view.actions.includes('start_totp')) kids.push(button(env, t(s, 'action.authenticator'), () => void actions.startTotp(), 'plain', { key: 'totp' }));
  if (view.actions.includes('start_sms')) {
    kids.push(renderField(env, { name: 'phone', kind: 'phone', autoComplete: 'tel', secure: false }, p.values.phone, (next) => p.onValues({ ...p.values, phone: next })));
    kids.push(button(env, t(s, 'action.sms'), () => void actions.startSms(String(p.values.phone ?? '')), 'plain', { key: 'sms' }));
  }
  if (view.actions.includes('add_phone')) {
    kids.push(renderField(env, { name: 'phone', kind: 'phone', autoComplete: 'tel', secure: false }, p.values.phone, (next) => p.onValues({ ...p.values, phone: next })));
    kids.push(button(env, t(s, 'action.add_phone'), () => void actions.addPhone(String(p.values.phone ?? '')), 'plain', { key: 'add-phone' }));
  }
  if (view.kind === 'passkeys') kids.push(button(env, t(s, 'action.add_passkey'), () => void actions.addPasskey(), 'plain', { key: 'passkey' }));
  if (view.actions.includes('regenerate_codes')) kids.push(button(env, t(s, 'action.new_codes'), () => void actions.regenerateCodes(), 'plain', { key: 'codes-new' }));
  if (view.kind === 'password' && view.fields.length > 0) {
    for (const f of view.fields) {
      kids.push(renderField(env, { name: f.name, kind: f.kind, autoComplete: f.autoComplete, secure: f.secure }, p.values[f.name], (next) => p.onValues({ ...p.values, [f.name]: next })));
    }
    kids.push(button(env, t(s, 'action.continue'), () => void actions.submit(toSubmitValues(p.values)), 'primary', { key: 'submit' }));
  }
  return el(ui.View, { style: l.root }, ...kids);
}
