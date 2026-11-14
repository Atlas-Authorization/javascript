import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScreenField, SecuritySectionView, SignInScreenView } from '@atlasauth/js';
import { renderAuthScreen, renderField, renderSecuritySection, toSubmitValues, type AuthActions, type RenderEnv, type SecurityActions } from './native-screens-render';

/** The screens are pure functions over injected primitives (plain strings here), so the element trees are read without a renderer. */
const env: RenderEnv = {
  ui: { View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', Switch: 'Switch' },
  onLink: vi.fn(),
};

type Props = Record<string, any>;
function walk(node: ReactNode, visit: (el: ReactElement<Props>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!isValidElement(node)) return;
  const e = node as ReactElement<Props>;
  visit(e);
  walk(e.props.children, visit);
}
const find = (root: ReactNode, type: string, pred: (p: Props) => boolean = () => true) => {
  const out: ReactElement<Props>[] = [];
  walk(root, (e) => {
    if (e.type === type && pred(e.props)) out.push(e);
  });
  return out;
};
const texts = (root: ReactNode) => {
  const out: string[] = [];
  walk(root, (e) => {
    if (e.type === 'Text') out.push([e.props.children].flat().filter((c) => typeof c === 'string').join(''));
  });
  return out;
};

const baseView: SignInScreenView = {
  step: 'identifier', methods: [], method: null, alternatives: [], fields: [], needsSend: false, codeSent: false, sentTo: null, busy: false, error: null, reason: null,
  attemptId: null, enrollment: null, recoveryCodes: null, policies: [], requiredAction: null, legal: null, flowStep: { type: 'needs_identifier' },
};
const noop = async () => undefined;
const actions = (over: Partial<AuthActions> = {}): AuthActions => ({
  submit: vi.fn(noop), selectMethod: vi.fn(noop), sendCode: vi.fn(noop), resend: vi.fn(noop), acknowledgeRecoveryCodes: vi.fn(noop), acceptPolicies: vi.fn(noop),
  startIdentityVerification: vi.fn(noop), checkIdentityVerification: vi.fn(noop), reset: vi.fn(), ...over,
});
const F = (over: Partial<ScreenField>): ScreenField => ({ name: 'x', kind: 'text', autoComplete: 'off', secure: false, ...over });

describe('renderField', () => {
  it('draws a text box with the right keyboard, autofill and secure entry', () => {
    const onChange = vi.fn();
    const tree = renderField(env, F({ name: 'mobile', kind: 'phone', autoComplete: 'tel', label: 'Mobile', required: true }), '+155', onChange);
    const [input] = find(tree, 'TextInput');
    expect(input!.props).toMatchObject({ value: '+155', keyboardType: 'phone-pad', autoComplete: 'tel', secureTextEntry: false });
    expect(texts(tree)).toContain('Mobile *');
    input!.props.onChangeText('+1555');
    expect(onChange).toHaveBeenCalledWith('+1555');
    expect(find(renderField(env, F({ name: 'password', kind: 'password', secure: true, autoComplete: 'new-password' }), '', vi.fn()), 'TextInput')[0]!.props.secureTextEntry).toBe(true);
  });

  it('toggles options of a multi-select and picks one of a select, with the localized labels', () => {
    const onChange = vi.fn();
    const multi = renderField(env, F({ name: 'topics', kind: 'multi_select', label: 'Topics', options: ['a', 'b'], optionLabels: { a: 'Alpha' } }), ['a'], onChange);
    expect(texts(multi)).toEqual(expect.arrayContaining(['Alpha', 'b']));
    const [pa, pb] = find(multi, 'Pressable');
    expect(pa!.props.accessibilityState.selected).toBe(true);
    pb!.props.onPress();
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    pa!.props.onPress();
    expect(onChange).toHaveBeenLastCalledWith([]);
    const single = renderField(env, F({ name: 'plan', kind: 'select', options: ['a', 'b'] }), 'a', onChange);
    find(single, 'Pressable')[1]!.props.onPress();
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  it('draws a checkbox as a switch with its link, and only offers an https link', () => {
    const onChange = vi.fn();
    const tree = renderField(env, F({ name: 'terms', kind: 'checkbox', label: 'I agree to the', link: { text: 'Terms', url: 'https://example.com/t' } }), 'false', onChange);
    find(tree, 'Switch')[0]!.props.onValueChange(true);
    expect(onChange).toHaveBeenCalledWith('true');
    find(tree, 'Pressable')[0]!.props.onPress();
    expect(env.onLink).toHaveBeenCalledWith('https://example.com/t');
    expect(find(renderField(env, F({ name: 'terms', kind: 'checkbox', label: 'x', link: { text: 'Bad', url: 'http://example.com' } }), '', vi.fn()), 'Pressable')).toHaveLength(0);
  });
});

describe('renderAuthScreen', () => {
  it('draws the create-account details, the consent switch with its links, and submits the typed values', () => {
    const a = actions();
    const view: SignInScreenView = {
      ...baseView, step: 'details',
      fields: [F({ name: 'email', kind: 'email', autoComplete: 'email' }), F({ name: 'password', kind: 'password', secure: true, autoComplete: 'new-password' })],
      legal: { termsUrl: 'https://example.com/terms', privacyUrl: null, required: true },
    };
    const tree = renderAuthScreen(env, { view, actions: a, values: { email: 'a@b.co', password: 'pw', consent: 'true' }, onValues: vi.fn() });
    expect(texts(tree)[0]).toBe('Create your account');
    expect(find(tree, 'TextInput')).toHaveLength(2);
    expect(find(tree, 'Switch')).toHaveLength(1);
    find(tree, 'Pressable', (p) => p.accessibilityRole === 'button')[0]!.props.onPress();
    expect(a.submit).toHaveBeenCalledWith({ email: 'a@b.co', password: 'pw', consent: 'true' });
  });

  it('draws a journey form with its title, intro, typed fields and a prefilled draft', () => {
    const view: SignInScreenView = {
      ...baseView, step: 'required_action',
      requiredAction: { kind: 'journey_form', title: 'Welcome', intro: 'Two questions', url: null, status: null, remaining: 0, skippable: false },
      fields: [F({ name: 'topics', kind: 'multi_select', label: 'Topics', options: ['x', 'y'], value: ['x'] })],
    };
    const tree = renderAuthScreen(env, { view, actions: actions(), values: {}, onValues: vi.fn() });
    expect(texts(tree).slice(0, 2)).toEqual(['Welcome', 'Two questions']);
    expect(find(tree, 'Pressable', (p) => p.accessibilityRole === 'checkbox')[0]!.props.accessibilityState.selected).toBe(true);
  });

  it('offers skip only when the step can be skipped, and shows an error as an alert', () => {
    const a = actions();
    const view: SignInScreenView = { ...baseView, step: 'required_action', error: 'Wrong code.', requiredAction: { kind: 'complete_profile', title: null, intro: null, url: null, status: null, remaining: 0, skippable: true } };
    const tree = renderAuthScreen(env, { view, actions: a, values: {}, onValues: vi.fn() });
    expect(find(tree, 'Text', (p) => p.accessibilityRole === 'alert')).toHaveLength(1);
    const skip = find(tree, 'Pressable', (p) => p.accessibilityRole === 'link').find((e) => texts(e).includes('Skip for now'));
    skip!.props.onPress();
    expect(a.submit).toHaveBeenCalledWith({ skip: 'true' });
  });

  it('draws the second-factor setup key and the recovery codes once', () => {
    const a = actions();
    const enroll: SignInScreenView = {
      ...baseView, step: 'enroll_second_factor', methods: ['totp', 'sms'], method: 'totp',
      enrollment: { totp: { secret: 'JBSWY3DP', uri: 'otpauth://x', qrSvg: null, qrCode: null }, totpCodes: 1, phone: null },
      fields: [F({ name: 'code', kind: 'code', autoComplete: 'one-time-code' })],
    };
    const t1 = renderAuthScreen(env, { view: enroll, actions: a, values: {}, onValues: vi.fn() });
    expect(texts(t1)).toContain('JBSWY3DP');
    find(t1, 'Pressable', (p) => p.accessibilityRole === 'radio')[1]!.props.onPress();
    expect(a.selectMethod).toHaveBeenCalledWith('sms');
    const t2 = renderAuthScreen(env, { view: { ...baseView, step: 'recovery_codes', recoveryCodes: ['aaaa-bbbb'] }, actions: a, values: {}, onValues: vi.fn() });
    expect(texts(t2)).toContain('aaaa-bbbb');
    find(t2, 'Pressable')[0]!.props.onPress();
    expect(a.acknowledgeRecoveryCodes).toHaveBeenCalled();
  });

  it('joins a multi-select as a comma list for submit', () => {
    expect(toSubmitValues({ a: 'x', topics: ['p', 'q'] })).toEqual({ a: 'x', topics: 'p,q' });
  });
});

describe('renderSecuritySection', () => {
  const sec = (over: Partial<SecuritySectionView>): SecuritySectionView => ({
    kind: 'sessions', step: 'list', loading: false, busy: false, items: [], fields: [], enrollment: null, sentTo: null, recoveryCodes: null, backupCodesRemaining: null,
    hasPassword: null, actions: [], error: null, reason: null, stepUpRequired: false, ...over,
  });
  const sa = (): SecurityActions => ({
    remove: vi.fn(noop), revokeOthers: vi.fn(noop), startTotp: vi.fn(noop), startSms: vi.fn(noop), addPhone: vi.fn(noop), verifyPhone: vi.fn(noop), makePrimary: vi.fn(noop),
    addPasskey: vi.fn(noop), regenerateCodes: vi.fn(noop), acknowledgeCodes: vi.fn(), cancel: vi.fn(), submit: vi.fn(noop),
  });

  it('lists sessions, hides remove on the current one and signs the others out', () => {
    const a = sa();
    const tree = renderSecuritySection(env, {
      view: sec({ actions: ['remove', 'revoke_others'], items: [{ id: 's1', label: 'iPhone', detail: null, current: true, primary: false, verified: true }, { id: 's2', label: 'Pixel', detail: 'Berlin', current: false, primary: false, verified: true }] }),
      actions: a, values: {}, onValues: vi.fn(),
    });
    expect(texts(tree)).toEqual(expect.arrayContaining(['Devices and sessions', 'iPhone', 'Pixel']));
    const removes = find(tree, 'Pressable', (p) => p.accessibilityRole === 'link');
    expect(removes).toHaveLength(1);
    removes[0]!.props.onPress();
    expect(a.remove).toHaveBeenCalledWith('s2');
    find(tree, 'Pressable', (p) => p.accessibilityRole === 'button')[0]!.props.onPress();
    expect(a.revokeOthers).toHaveBeenCalled();
  });

  it('says a recent sign-in is needed when the server asks for one', () => {
    const tree = renderSecuritySection(env, { view: sec({ stepUpRequired: true }), actions: sa(), values: {}, onValues: vi.fn() });
    expect(find(tree, 'Text', (p) => p.accessibilityRole === 'alert')).toHaveLength(1);
  });

  it('draws the authenticator step with its key and fields', () => {
    const tree = renderSecuritySection(env, {
      view: sec({ kind: 'mfa', step: 'totp_enroll', enrollment: { factorId: 'f', secret: 'KEY123', uri: 'otpauth://x', qrSvg: '', requiredCodes: 1 }, fields: [{ name: 'code', kind: 'code', autoComplete: 'one-time-code', secure: false }] }),
      actions: sa(), values: {}, onValues: vi.fn(),
    });
    expect(texts(tree)).toContain('KEY123');
    expect(find(tree, 'TextInput')).toHaveLength(1);
  });
});
