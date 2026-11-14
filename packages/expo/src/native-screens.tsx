import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { SecuritySectionKind } from '@atlasauth/js';
import { useSecuritySection, useSignInScreen, useSignUpScreen } from './screens-hook';
import type { SecuritySectionSetup, SignInScreenSetup } from './screens';
import {
  renderAuthScreen,
  renderSecuritySection,
  type AuthActions,
  type FieldValues,
  type RenderEnv,
  type ScreenStyles,
  type ScreenTheme,
} from './native-screens-render';

/*
 * Default React Native screens for sign-in, sign-up, the second factor and account security. Thin on purpose:
 * each is one view-model from `useSignInScreen` / `useSignUpScreen` / `useSecuritySection` drawn with React
 * Native primitives. Theme them with `theme` and `styles`, translate them with `strings`, or skip them and draw
 * the same view-model yourself. Nothing is rendered in a web view.
 */

const ui = { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Switch };

/** Props every default screen takes. */
export interface NativeScreenProps {
  /** Colours and sizes merged over the defaults. */
  theme?: Partial<ScreenTheme>;
  /** Style objects by element role, merged over the themed defaults. */
  styles?: ScreenStyles;
  /** Override any string (a translation, different wording). Keys are in `DEFAULT_SCREEN_STRINGS`. */
  strings?: Record<string, string>;
  /** Open a link (a policy, a verification page). Default: `Linking.openURL`. */
  onLink?: (href: string) => void;
}

const envOf = (p: NativeScreenProps): RenderEnv => ({
  ui,
  ...(p.theme ? { theme: p.theme } : {}),
  ...(p.styles ? { styles: p.styles } : {}),
  ...(p.strings ? { strings: p.strings } : {}),
  onLink: p.onLink ?? ((href) => void Linking.openURL(href)),
});

/** Keep a journey form's answers on the server a moment after the person stops typing. */
function useDraftSaver(save: ((values: Record<string, string>) => Promise<void>) | undefined, active: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return useCallback(
    (values: Record<string, string>) => {
      if (!save || !active) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(values), 800);
    },
    [save, active],
  );
}

type AuthScreenController = { view: ReturnType<typeof useSignInScreen>['view'] } & AuthActions;

function AuthSurface(props: NativeScreenProps & { screen: AuthScreenController; onComplete?: () => void; steps?: string[] }): ReactElement | null {
  const { screen } = props;
  const [values, setValues] = useState<FieldValues>({});
  const view = screen.view;
  const saveDraft = useDraftSaver(screen.saveDraft?.bind(screen), view.requiredAction?.kind === 'journey_form');
  // Values typed on one step never leak into the next.
  const last = useRef(view.step + (view.requiredAction?.kind ?? ''));
  useEffect(() => {
    const now = view.step + (view.requiredAction?.kind ?? '');
    if (now !== last.current) {
      last.current = now;
      setValues({});
    }
  }, [view.step, view.requiredAction?.kind]);
  useEffect(() => {
    if (view.step === 'complete') props.onComplete?.();
  }, [view.step]); // eslint-disable-line react-hooks/exhaustive-deps
  if (props.steps && !props.steps.includes(view.step)) return null;
  return renderAuthScreen(envOf(props), {
    view,
    actions: screen,
    values,
    onValues: (next) => {
      setValues(next);
      saveDraft(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])));
    },
  });
}

/** The sign-in screen: identifier, password or code, second factor, and every step a journey adds. */
export function SignInScreen(props: NativeScreenProps & { setup?: SignInScreenSetup; onComplete?: () => void }): ReactElement | null {
  const screen = useSignInScreen(props.setup);
  return createElement(AuthSurface, { ...props, screen });
}

/** The create-account screen: details, then verify email, policies, second-factor setup and the journey's own steps. */
export function SignUpScreen(props: NativeScreenProps & { setup?: Pick<SignInScreenSetup, 'localization' | 'passkey'>; onComplete?: () => void }): ReactElement | null {
  const screen = useSignUpScreen(props.setup);
  return createElement(AuthSurface, { ...props, screen });
}

/**
 * Only the second-factor steps of a screen you already hold (`const screen = useSignInScreen()`): the challenge
 * (`second_factor`), setting one up (`enroll_second_factor`) and the recovery codes. Renders nothing on any other
 * step, so it sits next to your own screens for the others.
 */
export function SecondFactorScreen(props: NativeScreenProps & { screen: ReturnType<typeof useSignInScreen> | ReturnType<typeof useSignUpScreen> }): ReactElement | null {
  return createElement(AuthSurface, { ...props, screen: props.screen as unknown as AuthScreenController, steps: ['second_factor', 'enroll_second_factor', 'recovery_codes'] });
}

/** One account-security section: sessions, second factor, passkeys, phone numbers, recovery codes, connected accounts or the password. */
export function SecuritySection(props: NativeScreenProps & { kind: SecuritySectionKind; setup?: SecuritySectionSetup }): ReactElement {
  const section = useSecuritySection(props.kind, props.setup);
  const [values, setValues] = useState<FieldValues>({});
  return renderSecuritySection(envOf(props), { view: section.view, actions: section, values, onValues: setValues });
}

/** Every security section in a scrolling list; pass `kinds` to choose and order them. */
export function SecurityScreen(props: NativeScreenProps & { kinds?: SecuritySectionKind[]; setup?: SecuritySectionSetup }): ReactElement {
  const kinds = props.kinds ?? (['password', 'mfa', 'passkeys', 'recovery_codes', 'phones', 'sessions', 'connected_accounts'] as SecuritySectionKind[]);
  return createElement(
    ScrollView,
    null,
    ...kinds.map((kind) => createElement(SecuritySection, { key: kind, kind, theme: props.theme, styles: props.styles, strings: props.strings, onLink: props.onLink, setup: props.setup })),
  );
}
