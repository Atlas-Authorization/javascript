import { defineComponent, h, onMounted, onUnmounted, reactive, ref, shallowRef, watch, type PropType, type VNode } from 'vue';
import {
  describeAuditAction,
  planPriceView,
  submitLead,
  OrganizationProfileController,
  reauthenticate,
  type OrganizationProfileState,
  type OrganizationRequestError,
  awaitingPasskey,
  awaitingSignUpLink,
  localizedErrorMessage,
  nextStep,
  passkeysSupported,
  offeredFirstFactors,
  planFirstFactor,
  lastUsedMethodLabel,
  enrollmentSubmitKey,
  groupSetupKey,
  canDownloadRecoveryCodes,
  copyRecoveryCodes,
  downloadRecoveryCodes,
  pendingRecoveryCodes,
  signUp as hostedSignUp,
  type AttemptView,
  PolicyAcceptanceController,
  confirmPolicies,
  policyTranslator,
  type CaptchaController,
  type EmailDelivery,
  type FieldError,
  type InstanceSettings,
  type MfaEnrollmentController,
  type MfaEnrollmentState,
  type PublicSignUpField,
  type Step,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { FapiClient } from './fapi';
import { ATLAS_VUE_SDK } from './version';
import { useAuth, useImpersonation, useOrganization, useOrganizationAuditLog, usePricingPlans, useUser } from './composables';
import { useFlow } from './flow';
import { ManageCiba } from './manage-ciba';
import { classFor, type ElementKey } from './appearance';
import { translate } from './i18n';
import { evaluate } from './protect';
import { PolicyAcceptStep, PolicyClickwrap, PolicyConsent, usePolicyState } from './policies';

/**
 * §10.2 components — the Vue peer of React's `components.tsx`.
 *
 * `<SignIn/>` and `<SignUp/>` are full multi-step flows driven entirely by the
 * server-side attempt status. That phrase is the design: this file contains no
 * decision about what comes next. It renders whatever `status` the server
 * returned, via the exhaustive mapping in `@atlasauth/js` — so adding a step to the
 * flow is a server change, and a client that has not shipped yet degrades to a
 * visible "needs an update" rather than a blank screen.
 *
 * Components are authored as render functions (not `.vue` SFCs) so the package
 * builds with plain `tsc`, exactly like `@atlasauth/react` — no SFC compiler in the
 * toolchain, and components render in the host DOM so Tailwind/CSS just works.
 */

/** Resolve an element's class with the customer's appearance override appended. */
function useClass() {
  const { appearance } = useAtlas();
  return (key: ElementKey, base: string) => classFor(key, appearance, base);
}

/** Look up a catalog string and interpolate `{placeholders}`. */
function useText() {
  const { catalog } = useAtlas();
  return (key: string, vars?: Record<string, string>) => translate(catalog, key, vars);
}

/** The text for a server error: `error.<reason>`, else the server's message, else `error.generic`. */
function useErrorText() {
  const { catalog, errorCatalog } = useAtlas();
  return (error: FieldError) => localizedErrorMessage(error, errorCatalog ?? catalog, catalog);
}

export const SignedIn = defineComponent({
  name: 'SignedIn',
  setup(_props, { slots }) {
    const { isLoaded, isSignedIn } = useUser();
    // Renders nothing while loading rather than flashing the signed-out branch.
    return () => (isLoaded.value && isSignedIn.value ? slots.default?.() : null);
  },
});

export const SignedOut = defineComponent({
  name: 'SignedOut',
  setup(_props, { slots }) {
    const { isLoaded, isSignedIn } = useUser();
    return () => (isLoaded.value && !isSignedIn.value ? slots.default?.() : null);
  },
});

/** §10.2: render children only while the SDK is still loading. */
export const AtlasLoading = defineComponent({
  name: 'AtlasLoading',
  setup(_props, { slots }) {
    const { isLoaded } = useUser();
    return () => (isLoaded.value ? null : slots.default?.());
  },
});

/**
 * §10.2: render children only once the SDK has finished loading — the symmetric
 * partner of {@link AtlasLoading}, so a consumer can show a spinner and its
 * resolved content without hand-rolling the inverse condition.
 */
export const AtlasLoaded = defineComponent({
  name: 'AtlasLoaded',
  setup(_props, { slots }) {
    const { isLoaded } = useUser();
    return () => (isLoaded.value ? slots.default?.() : null);
  },
});

/**
 * §10.2 `<Protect permission="…">`.
 *
 * A rendering helper, never an authorization boundary — anyone can flip the
 * condition in devtools. The server checking the same permission is what
 * actually stops them, and this component's job is only to avoid showing a
 * button that would fail. Renders the `#fallback` slot when the condition is not
 * met, mirroring React's `fallback` prop.
 */
export const Protect = defineComponent({
  name: 'Protect',
  props: {
    permission: { type: String, default: undefined },
    role: { type: String, default: undefined },
    anyPermission: { type: Array as PropType<readonly string[]>, default: undefined },
    allPermissions: { type: Array as PropType<readonly string[]>, default: undefined },
  },
  setup(props, { slots }) {
    const { claims, status } = useAtlas();
    return () => {
      if (status.value === 'loading') return null;
      const allowed = evaluate(claims.value, {
        permission: props.permission,
        role: props.role,
        anyPermission: props.anyPermission,
        allPermissions: props.allPermissions,
      }).allowed;
      return allowed ? slots.default?.() : (slots.fallback?.() ?? null);
    };
  },
});

/**
 * The element a flow's captcha widget draws into (see `createCaptchaController`
 * in `@atlasauth/js`). Renders nothing when the flow needs no captcha.
 */
function captchaSlot(controller: CaptchaController | null | undefined): VNode | null {
  if (!controller?.needed) return null;
  return h('div', {
    key: 'captcha',
    class: 'atlas-captcha',
    'data-atlas-captcha': '',
    ref: slotRef(controller),
  });
}

/**
 * One stable ref callback per controller: Vue re-invokes a CHANGED function
 * ref with null and then the element, which would tear down and redraw the
 * widget on every render (losing a solved token).
 */
const slotRefs = new WeakMap<CaptchaController, (el: unknown) => void>();
function slotRef(controller: CaptchaController): (el: unknown) => void {
  let ref = slotRefs.get(controller);
  if (!ref) {
    ref = (el: unknown) => controller.attach((el as HTMLElement | null) ?? null);
    slotRefs.set(controller, ref);
  }
  return ref;
}

/**
 * The server-driven flow shell.
 *
 * Every branch comes from `nextStep`, which is exhaustive — including the
 * `unknown` case, which renders an honest message instead of nothing.
 */
/** The recovery codes in two columns, monospaced. */
const RECOVERY_LIST_STYLE = {
  listStyle: 'none',
  padding: '0',
  margin: '8px 0 12px',
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '6px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  textAlign: 'center',
} as const;

const AttemptFlow = defineComponent({
  name: 'AttemptFlow',
  props: {
    attempt: { type: Object as PropType<AttemptView | null>, default: null },
    busy: { type: Boolean, default: false },
    errors: { type: Array as PropType<FieldError[]>, default: () => [] },
    titleKey: { type: String, required: true },
    /** `FlowState.sessionKept`: whether this browser kept the session the sign-in created. */
    // Untyped on purpose: Vue casts an absent Boolean prop to false, and absent means "unknown" here.
    sessionKept: { type: null as unknown as PropType<boolean | undefined>, default: undefined },
    onSubmit: { type: Function as PropType<(values: Record<string, string>) => void>, required: true },
    /**
     * The sign-in captcha, drawn above the submit button on the identifier step
     * (an always-on sign-in captcha) and on the challenge step the server
     * demands with `needs_captcha`.
     */
    captcha: { type: Object as PropType<CaptchaController | null>, default: null },
    /**
     * The instance's `emailDelivery` (from its settings). While the app cannot
     * deliver email, the first-factor step offers no emailed code or link.
     */
    emailDelivery: { type: Object as PropType<EmailDelivery | null>, default: null },
    /**
     * Email a sign-in code or link (sign-in only). Without it the first-factor
     * step offers the password alone.
     */
    onPrepare: {
      type: Function as PropType<(strategy: 'email_code' | 'email_link') => Promise<boolean>>,
      default: undefined,
    },
    /**
     * "Email me a code instead" at the second factor (the instance's
     * `account.emailSecondFactor`). Without it the step asks for the code only.
     */
    onEmailSecondFactor: {
      type: Function as PropType<() => Promise<{ sentTo?: string; error?: string }>>,
      default: undefined,
    },
    /**
     * "Text me a code instead" at the second factor (where the app offers
     * texted codes). Without it the step offers no texted code.
     */
    onSmsSecondFactor: {
      type: Function as PropType<() => Promise<{ sentTo?: string; error?: string }>>,
      default: undefined,
    },
    /**
     * The MFA enrolment step (`useFlow().enrollment` and its state): the
     * authenticator app's QR code and setup key, or a texted code. Without it
     * the step asks for two authenticator codes only.
     */
    enrollment: { type: Object as PropType<MfaEnrollmentController | null>, default: null },
    enrollmentState: { type: Object as PropType<MfaEnrollmentState | null>, default: null },
    /**
     * The instance's `account.emailVerification`. On `link` a sign-up's
     * verification step has nothing to type: it says to open the emailed link
     * while the flow polls, and offers a resend ({@link onResend}).
     */
    emailVerification: { type: String, default: 'code' },
    onResend: { type: Function as PropType<() => Promise<boolean>>, default: undefined },
    /**
     * The recovery codes an MFA enrolment just completed the sign-in with
     * (`pendingRecoveryCodes(state)`): drawn once instead of the form, and
     * "I've saved my codes" calls {@link onRecoveryCodesSaved} to finish.
     */
    recoveryCodes: { type: Array as PropType<string[] | null>, default: null },
    onRecoveryCodesSaved: { type: Function as PropType<() => void>, default: undefined },
    /** The user declined a policy the sign-in was waiting on (`needs_policy_acceptance`): cancel the attempt. */
    onPolicyDecline: { type: Function as PropType<(title: string) => void>, default: undefined },
  },
  setup(props) {
    const t = useText();
    const errorText = useErrorText();
    const cls = useClass();
    const values = reactive<Record<string, string>>({});
    // The first factor the user picked: the password field by default, or the
    // code field / "check your email" once an emailed code / link was sent.
    const factor = ref<'password' | 'email_code' | 'email_link'>('password');
    // "Email me a code instead" at the second factor: where it went, or why not.
    const emailed = ref<{ busy?: boolean; sentTo?: string; error?: string }>({});
    // "Text me a code instead": the same, for the texted code.
    const texted = ref<{ busy?: boolean; sentTo?: string; error?: string }>({});
    watch(
      () => props.attempt?.id,
      () => {
        factor.value = 'password';
        emailed.value = {};
        texted.value = {};
      },
    );

    // The first factors on offer for the current step, and the plan for them:
    // a password field only when the server offers `password` (planFirstFactor).
    const firstFactorPlan = () => {
      const step = props.attempt ? nextStep(props.attempt) : null;
      if (step?.kind !== 'collect_first_factor' || !props.onPrepare) return null;
      return planFirstFactor(offeredFirstFactors(step.strategies, props.emailDelivery));
    };
    const send = (strategy: 'email_code' | 'email_link') =>
      props.onPrepare?.(strategy).then((sent) => {
        if (sent) factor.value = strategy;
      });

    // With no password on offer, email the code (or link) as soon as the step
    // appears — once per attempt, so a failed send waits for the user's retry.
    let autoSentFor: string | null = null;
    watch(
      () => [props.attempt?.id, props.attempt?.status, props.emailDelivery] as const,
      () => {
        const plan = firstFactorPlan();
        const id = props.attempt?.id ?? null;
        if (!plan?.autoSend || !id || autoSentFor === id) return;
        autoSentFor = id;
        void send(plan.autoSend);
      },
      { immediate: true },
    );

    const emailChoice = (strategy: 'email_code' | 'email_link', labelKey: string): VNode =>
      h(
        'button',
        {
          key: strategy,
          class: cls('formButtonSecondary', 'atlas-button-secondary'),
          type: 'button',
          'data-strategy': strategy,
          disabled: props.busy,
          onClick: () => {
            delete values.password;
            delete values.code;
            void send(strategy);
          },
        },
        t(labelKey),
      );

    const field = (name: string, labelKey: string, type = 'text', autocomplete?: string): VNode =>
      h('label', { class: 'atlas-field', key: name }, [
        h('span', t(labelKey)),
        h('input', {
          class: cls('formFieldInput', 'atlas-input'),
          type,
          name,
          ...(autocomplete ? { autocomplete } : {}),
          value: values[name] ?? '',
          onInput: (event: Event) => {
            values[name] = (event.target as HTMLInputElement).value;
          },
        }),
        ...props.errors
          .filter((error) => error.param === name)
          .map((error) =>
            h('span', { class: cls('formFieldError', 'atlas-error'), key: error.code }, errorText(error)),
          ),
      ]);

    /**
     * The enrolment step: the method choice, the authenticator's QR code and
     * setup key with its code field(s), or the phone number then the texted code.
     */
    const enrollmentFields = (enrol: MfaEnrollmentController, s: MfaEnrollmentState): VNode[] => {
      const out: VNode[] = [];
      const methodButton = (m: 'totp' | 'phone_code', key: string) =>
        h(
          'button',
          {
            key,
            class: cls('formButtonSecondary', 'atlas-button-secondary'),
            type: 'button',
            'data-atlas-mfa-method': m,
            disabled: props.busy || s.busy,
            onClick: () => {
              for (const k of Object.keys(values)) delete values[k];
              void enrol.choose(m);
            },
          },
          t(m === 'totp' ? 'mfa.enrollTotpOption' : 'mfa.enrollSmsOption'),
        );
      if (s.method === null) {
        out.push(h('p', { key: 'choose', class: 'atlas-text' }, t('mfa.enrollChoose')));
        for (const m of s.options) out.push(methodButton(m, `method-${m}`));
      } else if (s.method === 'totp') {
        const e = s.enrollment;
        if (!e) {
          out.push(h('p', { key: 'preparing', class: 'atlas-text', 'aria-live': 'polite' }, s.busy ? t('mfa.enrollPreparing') : ''));
        } else {
          out.push(h('p', { key: 'scan', class: 'atlas-text' }, t('mfa.enrollScan')));
          if (e.qrCode) {
            out.push(h('img', { key: 'qr', class: 'atlas-mfa-qr', 'data-atlas': 'mfa-qr', src: e.qrCode, alt: t('mfa.enrollQrAlt'), width: 180, height: 180 }));
          }
          if (e.secret) {
            out.push(
              h('p', { key: 'secret', class: 'atlas-text', 'data-atlas': 'mfa-setup-key' }, [`${t('mfa.enrollSetupKey')}: `, h('code', groupSetupKey(e.secret))]),
            );
          }
          out.push(field('code', 'mfa.enrollFirstCodeLabel', 'text', 'one-time-code'));
          if (s.totpCodes >= 2) out.push(field('secondCode', 'mfa.enrollSecondCodeLabel', 'text', 'one-time-code'));
        }
      } else if (!s.enrollment) {
        out.push(field('phone', 'mfa.phoneLabel', 'tel', 'tel'), h('p', { key: 'phone-hint', class: 'atlas-text' }, t('mfa.phoneHint')));
      } else {
        out.push(
          h('p', { key: 'texted', class: 'atlas-text', 'data-atlas': 'mfa-code-texted', 'aria-live': 'polite' }, t('mfa.codeTextedTo', { phone: s.enrollment.phone ?? '' })),
          field('code', 'mfa.codeLabel', 'text', 'one-time-code'),
          h(
            'button',
            {
              key: 'resend',
              class: cls('formButtonSecondary', 'atlas-button-secondary'),
              type: 'button',
              'data-atlas-resend': '',
              disabled: props.busy || s.busy,
              onClick: () => void enrol.resend(),
            },
            t('signIn.resendCode'),
          ),
        );
      }
      for (const error of s.errors) {
        out.push(h('p', { key: `enrol-error-${error.code}-${error.param ?? ''}`, class: cls('formFieldError', 'atlas-error'), role: 'alert' }, error.message));
      }
      if (s.method !== null && s.options.length > 1) {
        const other = s.options.find((m) => m !== s.method)!;
        out.push(methodButton(other, 'switch'));
      }
      return out;
    };

    const fields = (step: Step): VNode[] => {
      switch (step.kind) {
        case 'collect_identifier':
          return [field('identifier', 'signIn.identifierLabel', 'email')];
        case 'collect_first_factor': {
          const identifier = props.attempt?.identifier ?? '';
          const plan = firstFactorPlan();
          const usePassword =
            plan?.password && props.onPrepare
              ? h(
                  'button',
                  {
                    key: 'use-password',
                    class: cls('formButtonSecondary', 'atlas-button-secondary'),
                    type: 'button',
                    'data-strategy': 'password',
                    disabled: props.busy,
                    onClick: () => {
                      delete values.code;
                      factor.value = 'password';
                    },
                  },
                  t('signIn.passwordOption'),
                )
              : null;
          if (factor.value === 'email_code' || factor.value === 'email_link') {
            const sent = factor.value;
            return [
              sent === 'email_code'
                ? h('p', { key: 'code-sent', class: 'atlas-text', 'data-atlas-code-sent': '' }, t('signIn.codeSentTo', { email: identifier }))
                : h('p', { key: 'link-sent', class: 'atlas-text', 'data-atlas-link-sent': '' }, t('signIn.linkSentTo', { email: identifier })),
              sent === 'email_code' ? field('code', 'signIn.emailCodeLabel') : null,
              h(
                'button',
                {
                  key: 'resend',
                  class: cls('formButtonSecondary', 'atlas-button-secondary'),
                  type: 'button',
                  'data-atlas-resend': '',
                  disabled: props.busy,
                  onClick: () => void props.onPrepare?.(sent),
                },
                t(sent === 'email_code' ? 'signIn.resendCode' : 'signIn.resendLink'),
              ),
              usePassword,
            ].filter((node): node is VNode => node !== null);
          }
          // The server's list, minus email code / link while the app cannot
          // deliver email (a capability of the app, never of the user).
          const offered = plan ? plan.email : [];
          if (plan && !plan.password && offered.length > 0) {
            // Sending on its own; if that failed, these are the retry.
            return [
              h('p', { key: 'sending', class: 'atlas-text', 'aria-live': 'polite' }, t('signIn.sending')),
              ...(props.busy ? [] : offered.map((s) => emailChoice(s, s === 'email_code' ? 'signIn.useEmailCode' : 'signIn.useEmailLink'))),
            ];
          }
          return [
            field('password', 'signIn.passwordLabel', 'password'),
            offered.includes('email_code') ? emailChoice('email_code', 'signIn.useEmailCode') : null,
            offered.includes('email_link') ? emailChoice('email_link', 'signIn.useEmailLink') : null,
          ].filter((node): node is VNode => node !== null);
        }
        case 'collect_second_factor': {
          const out: VNode[] = [field('code', 'mfa.codeLabel')];
          if (props.onSmsSecondFactor) {
            const state = texted.value;
            if (state.sentTo !== undefined) {
              out.push(
                h('p', { key: 'sms-2fa-sent', class: 'atlas-text', 'data-atlas': 'sms-second-factor-sent', 'aria-live': 'polite' }, t('mfa.codeTextedTo', { phone: state.sentTo })),
              );
            } else {
              out.push(
                h(
                  'button',
                  {
                    key: 'sms-2fa',
                    class: cls('formButtonSecondary', 'atlas-button-secondary'),
                    type: 'button',
                    'data-atlas': 'sms-second-factor',
                    disabled: props.busy || state.busy,
                    onClick: () => {
                      texted.value = { busy: true };
                      void props.onSmsSecondFactor!().then((r) => {
                        texted.value = r.error ? { error: r.error } : { sentTo: r.sentTo ?? '' };
                      });
                    },
                  },
                  state.busy ? t('signIn.sending') : t('mfa.smsCodeOption'),
                ),
              );
              if (state.error) out.push(h('p', { key: 'sms-2fa-error', class: cls('formFieldError', 'atlas-error'), role: 'alert' }, state.error));
            }
          }
          if (props.onEmailSecondFactor) {
            const state = emailed.value;
            if (state.sentTo !== undefined) {
              out.push(
                h('p', { key: 'email-2fa-sent', class: 'atlas-text', 'data-atlas': 'email-second-factor-sent', 'aria-live': 'polite' }, t('signIn.codeSentTo', { email: state.sentTo })),
              );
            } else {
              out.push(
                h(
                  'button',
                  {
                    key: 'email-2fa',
                    class: cls('formButtonSecondary', 'atlas-button-secondary'),
                    type: 'button',
                    'data-atlas': 'email-second-factor',
                    disabled: props.busy || state.busy,
                    onClick: () => {
                      emailed.value = { busy: true };
                      void props.onEmailSecondFactor!().then((r) => {
                        emailed.value = r.error ? { error: r.error } : { sentTo: r.sentTo ?? '' };
                      });
                    },
                  },
                  state.busy ? t('signIn.sending') : t('signIn.emailCodeOption'),
                ),
              );
              if (state.error) out.push(h('p', { key: 'email-2fa-error', class: cls('formFieldError', 'atlas-error'), role: 'alert' }, state.error));
            }
          }
          return out;
        }
        case 'enroll_second_factor':
          if (props.enrollment && props.enrollmentState) return enrollmentFields(props.enrollment, props.enrollmentState);
          // Two codes, not one. §5.6 wants consecutive codes so a phone with a
          // fast clock fails here rather than on every sign-in afterwards.
          return [
            field('code', 'mfa.enrollFirstCodeLabel'),
            field('secondCode', 'mfa.enrollSecondCodeLabel'),
          ];
        case 'collect_email_code':
          if (awaitingSignUpLink(props.attempt, props.emailVerification)) {
            // Nothing to type: the flow polls until the emailed link is opened (anywhere).
            return [
              h('p', { key: 'link-sent', class: 'atlas-text', 'data-atlas-link-sent': '', 'aria-live': 'polite' }, t('signUp.linkSentTo', { email: props.attempt?.identifier ?? '' })),
              props.onResend
                ? h(
                    'button',
                    {
                      key: 'resend',
                      class: cls('formButtonSecondary', 'atlas-button-secondary'),
                      type: 'button',
                      'data-atlas-resend': '',
                      disabled: props.busy,
                      onClick: () => void props.onResend!(),
                    },
                    t('signIn.resendLink'),
                  )
                : null,
            ].filter((node): node is VNode => node !== null);
          }
          return [field('code', 'signIn.emailCodeLabel')];
        case 'collect_new_password':
          return [field('password', 'reset.newPasswordLabel', 'password')];
        case 'accept_policies':
          // A required policy changed: scroll-mode ones in their dialog, the rest as checkboxes.
          return [
            h(PolicyAcceptStep, {
              key: 'policies',
              attempt: props.attempt,
              busy: props.busy,
              onSubmit: props.onSubmit,
              onDecline: (policy: { title: string }) => props.onPolicyDecline?.(policy.title),
            }),
          ];
        case 'collect_captcha':
          // §5 the server withheld the attempt until a captcha clears. Solving
          // the widget resubmits the identifier on its own; the button retries.
          return [h('p', { key: 'captcha-prompt', class: 'atlas-text' }, t('captcha.prompt'))];
        case 'await_oauth':
          return [h('p', { key: 'oauth' }, t('signIn.magicLinkSent'))];
        case 'done':
          // Signed in only when this browser holds the session; a blocked cookie is said
          // plainly. "Check the other tab" is for a sign-in completed on another device.
          if (props.sessionKept === true) return [h('p', { key: 'done', class: 'atlas-text' }, t('signIn.signedIn'))];
          if (props.sessionKept === false) {
            return [h('p', { key: 'done', class: cls('formFieldError', 'atlas-error'), role: 'alert' }, t('signIn.sessionNotKept'))];
          }
          return [h('p', { key: 'done' }, t('signIn.checkOtherTab'))];
        case 'restart':
          return [h('p', { key: 'restart' }, t('error.generic'))];
        default:
          // A status this SDK version does not know. Saying so beats rendering
          // nothing, which is a blank login box the user cannot act on.
          return [
            h('p', { key: 'unknown', class: cls('formFieldError', 'atlas-error') }, t('error.generic')),
          ];
      }
    };

    // The recovery codes: copied once ("Copied."), reset for a new set.
    const codesCopied = ref(false);
    watch(
      () => props.recoveryCodes,
      () => {
        codesCopied.value = false;
      },
    );
    const recoveryCodesCard = (codes: string[], onSaved: () => void): VNode => {
      const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
      const secondary = cls('formButtonSecondary', 'atlas-button-secondary');
      return h('div', { class: cls('card', 'atlas-card'), 'data-atlas': 'recovery-codes' }, [
        h('h1', { class: cls('headerTitle', 'atlas-title') }, t('mfa.recoveryCodesTitle')),
        h('p', { class: 'atlas-text' }, t('mfa.recoveryCodesHelp')),
        h(
          'ul',
          {
            class: 'atlas-recovery-codes',
            'data-atlas': 'recovery-codes-list',
            style: RECOVERY_LIST_STYLE,
          },
          codes.map((code) => h('li', { key: code }, [h('code', null, code)])),
        ),
        h('div', { class: 'atlas-alternatives' }, [
          canCopy
            ? h(
                'button',
                {
                  class: secondary,
                  type: 'button',
                  'data-atlas': 'recovery-codes-copy',
                  onClick: () =>
                    void copyRecoveryCodes(codes).then((ok) => {
                      codesCopied.value = ok;
                    }),
                },
                t('mfa.recoveryCodesCopy'),
              )
            : null,
          canDownloadRecoveryCodes()
            ? h(
                'button',
                { class: secondary, type: 'button', 'data-atlas': 'recovery-codes-download', onClick: () => downloadRecoveryCodes(codes) },
                t('mfa.recoveryCodesDownload'),
              )
            : null,
        ]),
        codesCopied.value
          ? h('p', { class: 'atlas-text', 'aria-live': 'polite', 'data-atlas': 'recovery-codes-copied' }, t('mfa.recoveryCodesCopied'))
          : null,
        h(
          'button',
          {
            class: cls('formButtonPrimary', 'atlas-button'),
            type: 'button',
            'data-atlas': 'recovery-codes-saved',
            disabled: props.busy,
            onClick: onSaved,
          },
          t('mfa.recoveryCodesSaved'),
        ),
      ]);
    };

    return () => {
      if (props.recoveryCodes?.length && props.onRecoveryCodesSaved) {
        return recoveryCodesCard(props.recoveryCodes, props.onRecoveryCodesSaved);
      }
      const step = props.attempt
        ? nextStep(props.attempt)
        : { kind: 'collect_identifier' as const };

      return h('div', { class: cls('card', 'atlas-card') }, [
        h('h1', { class: cls('headerTitle', 'atlas-title') }, t(props.titleKey)),

        ...props.errors
          .filter((error) => !error.param)
          .map((error) =>
            h(
              'p',
              { class: cls('formFieldError', 'atlas-error'), role: 'alert', key: error.code },
              errorText(error),
            ),
          ),

        h(
          'form',
          {
            onSubmit: (event: Event) => {
              event.preventDefault();
              // The first-factor step sends only what is on screen, so a stale
              // value from the other method never picks the strategy.
              const current = props.attempt ? nextStep(props.attempt) : null;
              if (current?.kind === 'collect_first_factor') {
                props.onSubmit(factor.value === 'email_code' ? { code: values.code ?? '' } : { password: values.password ?? '' });
                return;
              }
              // Enrolment: text the code to the typed number, or confirm the factor.
              if (current?.kind === 'enroll_second_factor' && props.enrollment) {
                void props.enrollment.submit({ ...values }).then((next) => {
                  if (next) props.onSubmit(next);
                });
                return;
              }
              props.onSubmit({ ...values });
            },
          },
          [
            ...fields(step),
            step.kind === 'collect_identifier' || step.kind === 'collect_captcha'
              ? captchaSlot(props.captcha)
              : null,
            step.kind !== 'done' &&
            step.kind !== 'await_oauth' &&
            step.kind !== 'accept_policies' &&
            !awaitingSignUpLink(props.attempt, props.emailVerification) &&
            !(step.kind === 'collect_first_factor' && factor.value === 'email_link') &&
            !(step.kind === 'collect_first_factor' && factor.value === 'password' && firstFactorPlan()?.password === false && (firstFactorPlan()?.email.length ?? 0) > 0) &&
            !(step.kind === 'enroll_second_factor' && props.enrollmentState && !enrollmentSubmitKey(props.enrollmentState))
              ? h(
                  'button',
                  {
                    class: cls('formButtonPrimary', 'atlas-button'),
                    disabled: props.busy || (step.kind === 'enroll_second_factor' && !!props.enrollmentState?.busy),
                    type: 'submit',
                  },
                  t(
                    step.kind === 'enroll_second_factor' && props.enrollmentState
                      ? (enrollmentSubmitKey(props.enrollmentState) ?? 'signIn.submit')
                      : 'signIn.submit',
                  ),
                )
              : null,
          ],
        ),
      ]);
    };
  },
});

export const SignIn = defineComponent({
  name: 'SignIn',
  props: {
    /** Where to send the user once the flow completes. */
    afterUrl: { type: String, default: undefined },
    /**
     * Where "No account? Sign up" goes. Default: the instance's hosted sign-up
     * page (carrying the visitor's referral). `null` hides it. Always shown, never
     * only after a failed sign-in, so it says nothing about whether an email has an account.
     */
    signUpUrl: { type: null as unknown as PropType<string | null | undefined>, default: undefined },
  },
  setup(props) {
    const { state, submit, prepare, captcha, settings, lastMethod, sendEmailSecondFactor, sendSmsSecondFactor, mfaChoices, enrollment, enrollmentState, saveRecoveryCodes, declinePolicy } =
      useFlow();
    const atlas = useAtlas();
    const t = useText();
    const cls = useClass();
    const signUpHref = (): string | null => {
      if (props.signUpUrl === null) return null;
      if (props.signUpUrl) return props.signUpUrl;
      try {
        return hostedSignUp({
          frontendApi: atlas.frontendApi,
          redirectUrl: props.afterUrl ?? (typeof window !== 'undefined' ? window.location.href : undefined),
          navigate: false,
        });
      } catch {
        return null;
      }
    };
    return () => {
      // Read the settings so the form re-renders (drawing the captcha slot)
      // once the instance's captcha config has loaded; the controller is passed
      // only while it draws, so the child sees a changed prop.
      void settings.value;
      const href = state.value.attempt?.status !== 'complete' ? signUpHref() : null;
      const flow = h(AttemptFlow, {
        attempt: state.value.attempt,
        busy: state.value.busy,
        errors: state.value.errors,
        sessionKept: state.value.sessionKept,
        titleKey: 'signIn.title',
        onSubmit: submit,
        captcha: captcha.needed ? captcha : null,
        emailDelivery: settings.value?.emailDelivery ?? null,
        onPrepare: prepare,
        onEmailSecondFactor: settings.value?.account.emailSecondFactor ? sendEmailSecondFactor : undefined,
        onSmsSecondFactor: mfaChoices().sms ? sendSmsSecondFactor : undefined,
        enrollment,
        enrollmentState: enrollmentState.value,
        recoveryCodes: pendingRecoveryCodes(state.value),
        onRecoveryCodesSaved: saveRecoveryCodes,
        onPolicyDecline: declinePolicy,
      });
      const lastLabel = !state.value.attempt ? lastUsedMethodLabel(lastMethod.value, t) : null;
      const hint = lastLabel
        ? h(
            'p',
            { key: 'last-used', class: cls('badge', 'atlas-text atlas-last-used-hint'), 'data-atlas': 'last-used', 'data-atlas-method': lastMethod.value },
            `${t('signIn.lastUsed')}: ${lastLabel}`,
          )
        : null;
      if (!href && !hint) return flow;
      if (!href) return [hint, flow];
      return [
        ...(hint ? [hint] : []),
        flow,
        h('p', { key: 'sign-up-prompt', class: cls('footerAction', 'atlas-footer'), 'data-atlas-sign-up-prompt': '' }, [
          `${t('signIn.noAccount')} `,
          h('a', { class: 'atlas-link', href }, t('signIn.signUpLink')),
        ]),
      ];
    };
  },
});

/**
 * The create-account step: the instance's configured extra fields, email +
 * password, the legal-consent row and — when the instance requires one on
 * sign-up — the captcha widget. Values live in local state so a refused submit
 * never clears them.
 */
const SignUpForm = defineComponent({
  name: 'SignUpForm',
  props: {
    settings: { type: Object as PropType<InstanceSettings | null>, default: null },
    busy: { type: Boolean, default: false },
    errors: { type: Array as PropType<FieldError[]>, default: () => [] },
    captcha: { type: Object as PropType<CaptchaController | null>, default: null },
    onSubmit: {
      type: Function as PropType<(values: Record<string, string>, consent: boolean) => void>,
      required: true,
    },
    /** Passkey-only sign-up: no password field; the email per the instance's mode. */
    passkey: { type: Object as PropType<{ email: 'off' | 'optional' | 'required' } | null>, default: null },
    /** Toggle between the password and passkey forms (only when both are offered). */
    onSwitchMode: { type: Function as PropType<() => void>, default: undefined },
    /** The instance's policies (terms, privacy, …); they replace the legacy consent row. */
    policies: { type: Object as PropType<PolicyAcceptanceController | null>, default: null },
  },
  setup(props) {
    const t = useText();
    const errorText = useErrorText();
    const cls = useClass();
    const values = reactive<Record<string, string>>({});
    const agreed = ref(false);
    const policyTick = props.policies ? usePolicyState(props.policies) : ref(0);
    const declined = ref<string | null>(null);
    const policyT = policyTranslator((key, vars) => t(key, vars));

    const fieldErrors = (name: string) =>
      props.errors
        .filter((error) => error.param === name)
        .map((error) =>
          h('span', { class: cls('formFieldError', 'atlas-error'), key: error.code }, errorText(error)),
        );

    const label = (f: PublicSignUpField) =>
      f.required ? f.label : t('signUp.optionalField', { label: f.label });

    const control = (f: PublicSignUpField): VNode => {
      const value = values[f.key] ?? '';
      const set = (v: string) => {
        values[f.key] = v;
      };
      switch (f.type) {
        case 'checkbox':
          return h('input', {
            type: 'checkbox',
            name: f.key,
            checked: value === 'true',
            onChange: (e: Event) => set((e.target as HTMLInputElement).checked ? 'true' : ''),
          });
        case 'select':
          return h(
            'select',
            {
              class: cls('formFieldInput', 'atlas-input'),
              name: f.key,
              value,
              required: f.required,
              onChange: (e: Event) => set((e.target as HTMLSelectElement).value),
            },
            [
              h('option', { value: '' }, f.placeholder ?? t('signUp.selectPlaceholder')),
              ...f.options.map((o) => h('option', { key: o, value: o }, o)),
            ],
          );
        case 'textarea':
          return h('textarea', {
            class: cls('formFieldInput', 'atlas-input'),
            name: f.key,
            rows: 3,
            value,
            required: f.required,
            placeholder: f.placeholder ?? undefined,
            onInput: (e: Event) => set((e.target as HTMLTextAreaElement).value),
          });
        case 'radio':
        case 'multiselect': {
          // Same encoding as React, the embed widget and the hosted page: one
          // value, or a comma-joined list for multiselect.
          const picked = value ? value.split(', ') : [];
          return h(
            'span',
            { class: 'atlas-choices' },
            f.options.map((o) =>
              h('label', { key: o, class: 'atlas-choice' }, [
                h('input', {
                  type: f.type === 'radio' ? 'radio' : 'checkbox',
                  name: f.key,
                  value: o,
                  checked: picked.includes(o),
                  onChange: (e: Event) => {
                    if (f.type === 'radio') set(o);
                    else {
                      const on = (e.target as HTMLInputElement).checked;
                      set((on ? [...picked, o] : picked.filter((p) => p !== o)).join(', '));
                    }
                  },
                }),
                o,
              ]),
            ),
          );
        }
        default: {
          const type = ['email', 'tel', 'url', 'number', 'date'].includes(f.type) ? f.type : 'text';
          return h('input', {
            class: cls('formFieldInput', 'atlas-input'),
            type,
            name: f.key,
            value,
            required: f.required,
            placeholder: f.placeholder ?? undefined,
            onInput: (e: Event) => set((e.target as HTMLInputElement).value),
          });
        }
      }
    };

    const textField = (name: string, labelKey: string, type: string, autocomplete: string, required = true) =>
      h('label', { key: name, class: cls('formField', 'atlas-field') }, [
        h(
          'span',
          { class: cls('formFieldLabel', 'atlas-field-label') },
          required ? t(labelKey) : t('signUp.optionalField', { label: t(labelKey) }),
        ),
        h('input', {
          class: cls('formFieldInput', 'atlas-input'),
          type,
          name,
          autocomplete,
          required,
          value: values[name] ?? '',
          onInput: (e: Event) => {
            values[name] = (e.target as HTMLInputElement).value;
          },
        }),
        ...fieldErrors(name),
      ]);

    return () => {
      void policyTick.value;
      const hasPolicies = !!props.policies && props.policies.policies.length > 0;
      // Instance policies replace the legacy single "I agree to the Terms" row.
      const legal = hasPolicies ? undefined : props.settings?.legal;
      const showLegal = !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
      const consentOk = (!legal?.required || agreed.value) && (!hasPolicies || props.policies!.canSubmit());
      const links = showLegal
        ? [
            legal!.termsUrl
              ? h('a', { key: 'terms', class: 'atlas-link', href: legal!.termsUrl, target: '_blank', rel: 'noopener noreferrer' }, t('signUp.terms'))
              : null,
            legal!.privacyUrl
              ? h('a', { key: 'privacy', class: 'atlas-link', href: legal!.privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('signUp.privacy'))
              : null,
          ].filter((x): x is VNode => x !== null)
        : [];

      // The app can't deliver the verification email, so an email + password
      // sign-up could never complete: say so up front instead of a form that
      // fails on submit.
      const passkey = props.passkey;
      if (props.settings?.emailDelivery?.passwordSignUp === false && !(passkey && passkey.email !== 'required')) {
        return h('div', { class: cls('card', 'atlas-card') }, [
          h('h1', { class: cls('headerTitle', 'atlas-title') }, t('signUp.title')),
          h(
            'p',
            { class: cls('formFieldError', 'atlas-error'), role: 'alert', 'data-atlas-email-unavailable': '' },
            t('signUp.emailUnavailable'),
          ),
        ]);
      }

      return h('div', { class: cls('card', 'atlas-card') }, [
        h('h1', { class: cls('headerTitle', 'atlas-title') }, t('signUp.title')),
        ...props.errors
          .filter((error) => !error.param)
          .map((error) =>
            h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert', key: error.code }, errorText(error)),
          ),
        h(
          'form',
          {
            onSubmit: (event: Event) => {
              event.preventDefault();
              if (!consentOk) return;
              declined.value = null;
              if (hasPolicies) {
                // Scroll-mode policies are read in their unskippable dialog first.
                void confirmPolicies(props.policies!, { t: policyT }).then((res) => {
                  if (res.ok) props.onSubmit({ ...values }, true);
                  else declined.value = res.declined;
                });
                return;
              }
              props.onSubmit({ ...values }, legal?.required ? agreed.value : true);
            },
          },
          [
            ...(props.settings?.signUpFields ?? []).map((f) =>
              h(
                // A choice group holds several inputs, so it can't sit inside one <label>.
                f.type === 'radio' || f.type === 'multiselect' ? 'div' : 'label',
                { key: f.key, class: cls('formField', 'atlas-field') },
                [
                  h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, label(f)),
                  control(f),
                  ...fieldErrors(f.key),
                ],
              ),
            ),
            passkey
              ? passkey.email === 'off'
                ? null
                : textField('email', 'signUp.emailLabel', 'email', 'email', passkey.email === 'required')
              : textField('email', 'signUp.emailLabel', 'email', 'email'),
            passkey ? null : textField('password', 'signUp.passwordLabel', 'password', 'new-password'),
            passkey ? h('p', { key: 'passkey-intro', class: 'atlas-text' }, t('signUp.passkeyIntro')) : null,
            showLegal
              ? h('label', { key: 'consent', class: cls('formField', 'atlas-consent') }, [
                  legal!.required
                    ? h('input', {
                        type: 'checkbox',
                        name: 'consent',
                        checked: agreed.value,
                        onChange: (e: Event) => {
                          agreed.value = (e.target as HTMLInputElement).checked;
                        },
                      })
                    : null,
                  h('span', { class: 'atlas-text' }, [
                    t(legal!.required ? 'signUp.consentAgree' : 'signUp.consentNotice'),
                    ' ',
                    ...links.flatMap((link, i) => (i > 0 ? [` ${t('signUp.and')} `, link] : [link])),
                    '.',
                  ]),
                  ...fieldErrors('consent'),
                ])
              : null,
            hasPolicies ? h(PolicyConsent, { key: 'policies', controller: props.policies! }) : null,
            declined.value
              ? h('span', { key: 'declined', class: cls('formFieldError', 'atlas-error'), role: 'alert', 'data-atlas-policy-declined': '' }, t('policy.declined', { policy: declined.value }))
              : null,
            captchaSlot(props.captcha),
            h(
              'button',
              {
                class: cls('formButtonPrimary', 'atlas-button'),
                disabled: props.busy || !consentOk,
                type: 'submit',
              },
              t('signUp.submit'),
            ),
            hasPolicies ? h(PolicyClickwrap, { key: 'clickwrap', controller: props.policies! }) : null,
            props.onSwitchMode
              ? h('div', { key: 'alternatives', class: 'atlas-alternatives' }, [
                  h(
                    'button',
                    {
                      type: 'button',
                      class: cls('formButtonSecondary', 'atlas-button-secondary'),
                      'data-atlas-sign-up-mode': passkey ? 'password' : 'passkey',
                      disabled: props.busy,
                      onClick: () => props.onSwitchMode?.(),
                    },
                    t(passkey ? 'signUp.passwordOption' : 'signUp.passkeyOption'),
                  ),
                ])
              : null,
          ],
        ),
      ]);
    };
  },
});

/** The passkey-only sign-up's last step: create the passkey (which creates the account). */
const PasskeySignUpStep = defineComponent({
  name: 'PasskeySignUpStep',
  props: {
    busy: { type: Boolean, default: false },
    errors: { type: Array as PropType<FieldError[]>, default: () => [] },
    onCreate: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    const t = useText();
    const errorText = useErrorText();
    const cls = useClass();
    return () =>
      h('div', { class: cls('card', 'atlas-card'), 'data-atlas-passkey-sign-up': '' }, [
        h('h1', { class: cls('headerTitle', 'atlas-title') }, t('signUp.title')),
        ...props.errors.map((error) =>
          h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert', key: error.code }, errorText(error)),
        ),
        h('p', { class: 'atlas-text' }, t('signUp.passkeyPrompt')),
        h(
          'button',
          { class: cls('formButtonPrimary', 'atlas-button'), type: 'button', disabled: props.busy, onClick: () => props.onCreate() },
          t('signUp.passkeyCreate'),
        ),
      ]);
  },
});

/**
 * §10.2 `<SignUp/>` — creates an account. The first step is the create-account
 * form, which POSTs `/v1/client/sign_ups`; from there the flow is server-driven
 * exactly like `<SignIn>` (the emailed-code step, then the ticket exchange).
 * Fields, consent and captcha come from the instance's settings, so turning
 * them on in the dashboard needs no code change.
 */
export const SignUp = defineComponent({
  name: 'SignUp',
  props: {
    afterUrl: { type: String, default: undefined },
  },
  setup() {
    const { state, submit, create, createWithPasskey, createPasskey, resendSignUp, settings, signUpCaptcha, policies, loadPolicies } = useFlow();
    const mode = ref<'password' | 'passkey'>('password');
    onMounted(() => {
      void loadPolicies();
    });
    return () => {
      const offer = settings.value?.account.passkeySignUp ?? null;
      const canPasskey = !!offer && passkeysSupported();
      const usingPasskey = mode.value === 'passkey' && canPasskey;
      if (state.value.attempt && awaitingPasskey(state.value.attempt)) {
        return h(PasskeySignUpStep, { busy: state.value.busy, errors: state.value.errors, onCreate: createPasskey });
      }
      return state.value.attempt
        ? h(AttemptFlow, {
            attempt: state.value.attempt,
            busy: state.value.busy,
            errors: state.value.errors,
            sessionKept: state.value.sessionKept,
            titleKey: 'signUp.title',
            onSubmit: submit,
            emailVerification: settings.value?.account.emailVerification ?? 'code',
            onResend: resendSignUp,
          })
        : h(SignUpForm, {
            settings: settings.value,
            busy: state.value.busy,
            errors: state.value.errors,
            captcha: signUpCaptcha.needed ? signUpCaptcha : null,
            policies,
            onSubmit: usingPasskey ? createWithPasskey : create,
            passkey: usingPasskey ? { email: offer!.email } : null,
            onSwitchMode: canPasskey
              ? () => {
                  state.value = { ...state.value, errors: [] };
                  mode.value = usingPasskey ? 'password' : 'passkey';
                }
              : undefined,
          });
    };
  },
});

export const UserButton = defineComponent({
  name: 'UserButton',
  setup() {
    const { user } = useUser();
    const { signOut } = useAuth();
    const t = useText();
    const cls = useClass();
    const open = ref(false);

    return () => {
      const u = user.value;
      if (!u) return null;

      const label =
        [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';

      return h('div', { class: 'atlas-user-button' }, [
        h(
          'button',
          {
            class: cls('avatar', 'atlas-avatar'),
            'aria-expanded': open.value,
            onClick: () => {
              open.value = !open.value;
            },
          },
          u.image_url
            ? h('img', { alt: '', src: u.image_url })
            : h('span', label.slice(0, 1)),
        ),
        open.value
          ? h('div', { class: cls('menu', 'atlas-menu'), role: 'menu' }, [
              h('span', { class: cls('menuItem', 'atlas-menu-item') }, label),
              h(
                'button',
                { class: cls('menuItem', 'atlas-menu-item'), onClick: () => void signOut() },
                t('userButton.signOut'),
              ),
            ])
          : null,
      ]);
    };
  },
});

/**
 * A banner shown only while the active session is an impersonation, naming the
 * user acted as, with "Return to admin" (or "End impersonation" when there is no
 * session of the impersonator's to resume). Emits `ended` with the outcome.
 */
export const ImpersonationBanner = defineComponent({
  name: 'ImpersonationBanner',
  emits: ['ended'],
  setup(_props, { emit }) {
    const { user } = useAtlas();
    const { isImpersonating, canReturnToAdmin, endImpersonation } = useImpersonation();
    const t = useText();
    const cls = useClass();
    const busy = ref(false);

    const end = async () => {
      busy.value = true;
      try {
        emit('ended', await endImpersonation());
      } finally {
        busy.value = false;
      }
    };

    return () => {
      if (!isImpersonating.value) return null;
      const u = user.value;
      const name =
        [u?.first_name, u?.last_name].filter(Boolean).join(' ') ||
        u?.username ||
        u?.email_addresses?.find((e) => e.primary)?.email_address ||
        u?.id ||
        '';
      return h('div', { class: cls('card', 'atlas-alert atlas-impersonation-banner'), role: 'status' }, [
        h('span', { class: cls('headerSubtitle', 'atlas-text') }, t('impersonation.banner', { name })),
        ' ',
        h(
          'button',
          { type: 'button', class: cls('formButtonPrimary', 'atlas-button'), disabled: busy.value, onClick: () => void end() },
          canReturnToAdmin.value ? t('impersonation.returnToAdmin') : t('impersonation.end'),
        ),
      ]);
    };
  },
});

export const OrganizationSwitcher = defineComponent({
  name: 'OrganizationSwitcher',
  setup() {
    const { memberships, organization, setActive } = useOrganization();
    const t = useText();
    const cls = useClass();

    return () =>
      h('div', { class: cls('menu', 'atlas-menu') }, [
        h(
          'button',
          { class: cls('menuItem', 'atlas-menu-item'), onClick: () => void setActive(null) },
          t('organization.personal'),
        ),
        ...memberships.value.map((membership) =>
          h(
            'button',
            {
              key: membership.organization.id,
              class: cls('menuItem', 'atlas-menu-item'),
              disabled: membership.organization.id === organization.value?.id,
              onClick: () => void setActive(membership.organization.id),
            },
            membership.organization.name,
          ),
        ),
      ]);
  },
});

export const UserProfile = defineComponent({
  name: 'UserProfile',
  setup() {
    const { user } = useUser();
    const atlas = useAtlas();
    const t = useText();
    const cls = useClass();
    // An unverified address (added and never confirmed, or the sign-up address
    // on an app that did not require verification) can be proven here: send a
    // code, then enter it.
    const verifying = ref<string | null>(null);
    const code = ref('');
    const busy = ref(false);
    const verifyError = ref<string | null>(null);
    const client = new FapiClient({
      publishableKey: atlas.publishableKey,
      baseUrl: atlas.frontendApi,
      locale: atlas.locale,
      sdk: ATLAS_VUE_SDK,
    });

    const sendCode = async (id: string) => {
      verifyError.value = null;
      busy.value = true;
      const res = await client.post(`/v1/client/me/email_addresses/${id}/prepare_verification`);
      busy.value = false;
      if (!res.ok) {
        verifyError.value = t('userProfile.verifySendFailed');
        return;
      }
      code.value = '';
      verifying.value = id;
    };
    const confirmCode = async () => {
      if (!verifying.value) return;
      verifyError.value = null;
      busy.value = true;
      const res = await client.post(
        `/v1/client/me/email_addresses/${verifying.value}/attempt_verification`,
        { code: code.value },
      );
      busy.value = false;
      if (!res.ok) {
        verifyError.value = t('userProfile.verifyCodeRejected');
        return;
      }
      verifying.value = null;
      await atlas.reload();
    };

    return () => {
      const u = user.value;
      if (!u) return null;

      return h('div', { class: cls('card', 'atlas-card') }, [
        h('h1', t('userProfile.title')),
        h('section', [
          h('h2', t('userProfile.emailsSection')),
          h(
            'ul',
            (u.email_addresses ?? []).map((email) =>
              h('li', { key: email.id }, [
                email.email_address,
                email.verified ? null : h('em', ` — ${t('userProfile.unverified')}`),
                email.verified
                  ? null
                  : verifying.value === email.id
                    ? h('span', { 'data-atlas': 'email-verify' }, [
                        h('input', {
                          class: cls('formFieldInput', 'atlas-account-input'),
                          inputmode: 'numeric',
                          autocomplete: 'one-time-code',
                          placeholder: t('userProfile.verifyCodePlaceholder'),
                          value: code.value,
                          onInput: (e: Event) => {
                            code.value = (e.target as HTMLInputElement).value;
                          },
                        }),
                        h(
                          'button',
                          {
                            class: cls('formButtonSecondary', 'atlas-button-secondary'),
                            type: 'button',
                            disabled: busy.value,
                            onClick: () => void confirmCode(),
                          },
                          t('userProfile.verifyConfirm'),
                        ),
                      ])
                    : h(
                        'button',
                        {
                          class: cls('formButtonSecondary', 'atlas-button-secondary'),
                          type: 'button',
                          disabled: busy.value,
                          onClick: () => void sendCode(email.id),
                        },
                        t('userProfile.verify'),
                      ),
              ]),
            ),
          ),
          verifyError.value ? h('p', { role: 'alert' }, verifyError.value) : null,
        ]),
        h('section', [
          h('h2', t('userProfile.securitySection')),
          h('p', u.mfa_enabled ? '2FA on' : '2FA off'),
        ]),
        h(ManageCiba),
      ]);
    };
  },
});

export const OrganizationProfile = defineComponent({
  name: 'OrganizationProfile',
  emits: ['exit'],
  setup(_props, { emit }) {
    const atlas = useAtlas();
    const { organization, membership } = useOrganization();
    const { userId, has } = useAuth();
    const t = useText();
    const cls = useClass();
    const client = new FapiClient({
      publishableKey: atlas.publishableKey,
      baseUrl: atlas.frontendApi,
      locale: atlas.locale,
      sdk: ATLAS_VUE_SDK,
    });
    const errorText = (err: unknown) =>
      localizedErrorMessage(err as Error, atlas.errorCatalog ?? atlas.catalog, atlas.catalog);

    const state = shallowRef<OrganizationProfileState | null>(null);
    const tab = ref<'members' | 'invitations' | 'roles' | 'settings'>('members');
    // The custom-role editor: null = creating, else the id of the role being edited.
    const editingRole = ref<string | null>(null);
    const roleKey = ref('');
    const roleName = ref('');
    const rolePerms = ref<string[]>([]);
    const resetRoleForm = () => {
      editingRole.value = null;
      roleKey.value = '';
      roleName.value = '';
      rolePerms.value = [];
    };
    const email = ref('');
    const inviteRole = ref('org:member');
    const confirm = ref<'leave' | 'delete' | null>(null);
    const needsPassword = ref(false);
    const password = ref('');
    let controller: OrganizationProfileController | null = null;
    let unsubscribe: (() => void) | null = null;

    watch(
      () => organization.value?.id ?? null,
      (id) => {
        unsubscribe?.();
        controller = null;
        state.value = null;
        if (!id) return;
        controller = new OrganizationProfileController(client, id, {
          canManage: has({ permission: 'org:sys_memberships:manage' }),
          onChange: async () => {
            await atlas.reload();
          },
        });
        unsubscribe = controller.subscribe((next) => {
          state.value = next;
        });
        state.value = controller.getState();
        void controller.load();
      },
      { immediate: true },
    );
    onUnmounted(() => unsubscribe?.());

    const leave = async () => {
      if (controller && (await controller.leave())) emit('exit', 'left');
      confirm.value = null;
    };
    const remove = async () => {
      if (!controller) return;
      if (needsPassword.value) {
        try {
          await reauthenticate(
            { strategy: 'password', password: password.value },
            { api: atlas.frontendApi, publishableKey: atlas.publishableKey, locale: atlas.locale },
          );
        } catch {
          return;
        }
        password.value = '';
        needsPassword.value = false;
      }
      if (await controller.deleteOrganization()) {
        emit('exit', 'deleted');
        confirm.value = null;
        return;
      }
      const err = controller.getState().error;
      if (err && (err as OrganizationRequestError).needsReverification) needsPassword.value = true;
    };

    return () => {
      const org = organization.value;
      const st = state.value;
      if (!org || !controller || !st) return null;
      const ctl = controller;
      const canManage = has({ permission: 'org:sys_memberships:manage' });
      const isAdmin = membership.value?.role === 'org:admin';
      const roles = st.roles.length > 0 ? st.roles : [{ key: 'org:member', name: 'org:member' }];
      const roleOptions = (selected: string) =>
        roles.map((r) => h('option', { value: r.key, selected: r.key === selected }, r.name));
      const tabs = ['members', ...(canManage ? ['invitations', 'roles'] : []), 'settings'] as const;
      const customRoles = st.roles.filter((r) => Boolean(r.organization_id));
      const secondary = cls('formButtonSecondary', 'atlas-button-secondary');

      const rolesPanel = h('div', { 'data-atlas': 'organization-roles' }, [
        customRoles.length === 0
          ? h('p', { class: 'atlas-text' }, t('organization.noCustomRoles'))
          : h(
              'ul',
              { class: 'atlas-list' },
              customRoles.map((role) =>
                h('li', { key: role.id ?? role.key, 'data-atlas': 'organization-role' }, [
                  h('span', `${role.name} · ${role.key}`),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: secondary,
                      onClick: () => {
                        editingRole.value = role.id ?? null;
                        roleKey.value = role.key;
                        roleName.value = role.name;
                        rolePerms.value = [...(role.permissions ?? [])];
                      },
                    },
                    t('organization.editRole'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: secondary,
                      disabled: !role.id || st.busy === `role:delete:${role.id}`,
                      onClick: () => role.id && void ctl.deleteRole(role.id),
                    },
                    t('organization.deleteRole'),
                  ),
                ]),
              ),
            ),
        h(
          'form',
          {
            'data-atlas': 'organization-role-form',
            onSubmit: async (e: Event) => {
              e.preventDefault();
              const out = editingRole.value
                ? await ctl.updateRole(editingRole.value, { name: roleName.value.trim(), permissions: rolePerms.value })
                : await ctl.createRole({ key: roleKey.value.trim(), name: roleName.value.trim(), permissions: rolePerms.value });
              if (out) resetRoleForm();
            },
          },
          [
            editingRole.value
              ? null
              : h('label', { class: cls('formField', 'atlas-field') }, [
                  h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, t('organization.roleKey')),
                  h('input', {
                    name: 'role_key',
                    class: cls('formFieldInput', 'atlas-input'),
                    value: roleKey.value,
                    onInput: (e: Event) => (roleKey.value = (e.target as HTMLInputElement).value),
                  }),
                ]),
            h('label', { class: cls('formField', 'atlas-field') }, [
              h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, t('organization.roleName')),
              h('input', {
                name: 'role_name',
                class: cls('formFieldInput', 'atlas-input'),
                value: roleName.value,
                onInput: (e: Event) => (roleName.value = (e.target as HTMLInputElement).value),
              }),
            ]),
            h('fieldset', { class: cls('formField', 'atlas-field') }, [
              h('legend', { class: cls('formFieldLabel', 'atlas-field-label') }, t('organization.rolePermissions')),
              ...st.permissions.map((p) =>
                h('label', { key: p.key, 'data-atlas': 'organization-role-permission' }, [
                  h('input', {
                    type: 'checkbox',
                    value: p.key,
                    checked: rolePerms.value.includes(p.key),
                    onChange: (e: Event) => {
                      const on = (e.target as HTMLInputElement).checked;
                      rolePerms.value = on
                        ? [...rolePerms.value, p.key]
                        : rolePerms.value.filter((k) => k !== p.key);
                    },
                  }),
                  ` ${p.name}`,
                ]),
              ),
            ]),
            h(
              'button',
              {
                type: 'submit',
                class: cls('formButtonPrimary', 'atlas-button'),
                disabled: !roleName.value.trim() || (!editingRole.value && !roleKey.value.trim()) || Boolean(st.busy?.startsWith('role:')),
              },
              editingRole.value ? t('organization.saveRole') : t('organization.createRole'),
            ),
            editingRole.value
              ? h('button', { type: 'button', class: secondary, onClick: resetRoleForm }, t('organization.cancel'))
              : null,
          ],
        ),
      ]);

      const members = h(
        'ul',
        { class: 'atlas-list', 'data-atlas': 'organization-members' },
        st.members.map((m) => {
          const id = m.user?.id ?? m.id;
          const self = m.user?.id === userId.value;
          const name = [m.user?.first_name, m.user?.last_name].filter(Boolean).join(' ') || t('organization.unnamedMember');
          return h('li', { key: m.id, 'data-atlas': 'organization-member' }, [
            h('span', self ? `${name} ${t('organization.you')}` : name),
            canManage && !self && m.user
              ? [
                  h(
                    'select',
                    {
                      'aria-label': t('organization.roleLabel'),
                      class: cls('formFieldInput', 'atlas-input'),
                      disabled: st.busy === `role:${id}`,
                      onChange: (e: Event) => void ctl.changeRole(id, (e.target as HTMLSelectElement).value),
                    },
                    roleOptions(m.role),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: cls('formButtonSecondary', 'atlas-button-secondary'),
                      disabled: st.busy === `remove:${id}`,
                      onClick: () => void ctl.removeMember(id),
                    },
                    t('organization.remove'),
                  ),
                ]
              : h('span', ` · ${m.role}`),
          ]);
        }),
      );

      const invitations = h('div', { 'data-atlas': 'organization-invitations' }, [
        h(
          'form',
          {
            onSubmit: async (e: Event) => {
              e.preventDefault();
              const address = email.value.trim();
              if (address && (await ctl.invite(address, inviteRole.value))) email.value = '';
            },
          },
          [
            h('label', { class: cls('formField', 'atlas-field') }, [
              h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, t('organization.emailLabel')),
              h('input', {
                type: 'email',
                class: cls('formFieldInput', 'atlas-input'),
                value: email.value,
                onInput: (e: Event) => (email.value = (e.target as HTMLInputElement).value),
              }),
            ]),
            h('label', { class: cls('formField', 'atlas-field') }, [
              h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, t('organization.roleLabel')),
              h(
                'select',
                {
                  class: cls('formFieldInput', 'atlas-input'),
                  onChange: (e: Event) => (inviteRole.value = (e.target as HTMLSelectElement).value),
                },
                roleOptions(inviteRole.value),
              ),
            ]),
            h(
              'button',
              { type: 'submit', class: cls('formButtonPrimary', 'atlas-button'), disabled: st.busy === 'invite' || !email.value.trim() },
              t('organization.sendInvite'),
            ),
          ],
        ),
        st.invitations.length === 0
          ? h('p', { class: 'atlas-text' }, t('organization.noInvitations'))
          : h(
              'ul',
              { class: 'atlas-list' },
              st.invitations.map((inv) =>
                h('li', { key: inv.id, 'data-atlas': 'organization-invitation' }, [
                  h('span', `${inv.email_address} · ${inv.role ?? ''}`),
                  h(
                    'button',
                    { type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), onClick: () => void ctl.resendInvitation(inv.id) },
                    t('organization.resend'),
                  ),
                  h(
                    'button',
                    { type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), onClick: () => void ctl.revokeInvitation(inv.id) },
                    t('organization.revoke'),
                  ),
                ]),
              ),
            ),
      ]);

      const settings = h(
        'div',
        { 'data-atlas': 'organization-settings' },
        confirm.value
          ? [
              h(
                'p',
                { class: 'atlas-text' },
                translate(atlas.catalog, confirm.value === 'leave' ? 'organization.leaveConfirm' : 'organization.deleteConfirm', { name: org.name }),
              ),
              needsPassword.value
                ? h('label', { class: cls('formField', 'atlas-field') }, [
                    h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, t('organization.passwordPrompt')),
                    h('input', {
                      type: 'password',
                      autocomplete: 'current-password',
                      class: cls('formFieldInput', 'atlas-input'),
                      value: password.value,
                      onInput: (e: Event) => (password.value = (e.target as HTMLInputElement).value),
                    }),
                  ])
                : null,
              h(
                'button',
                {
                  type: 'button',
                  class: cls('formButtonPrimary', 'atlas-button'),
                  disabled: st.busy === 'leave' || st.busy === 'delete',
                  onClick: () => void (confirm.value === 'leave' ? leave() : remove()),
                },
                t('organization.confirm'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: cls('formButtonSecondary', 'atlas-button-secondary'),
                  onClick: () => {
                    confirm.value = null;
                    needsPassword.value = false;
                    password.value = '';
                  },
                },
                t('organization.cancel'),
              ),
            ]
          : [
              h(
                'button',
                { type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), onClick: () => (confirm.value = 'leave') },
                t('organization.leave'),
              ),
              isAdmin
                ? h(
                    'button',
                    { type: 'button', class: cls('formButtonSecondary', 'atlas-button-secondary'), onClick: () => (confirm.value = 'delete') },
                    t('organization.delete'),
                  )
                : null,
            ],
      );

      return h('div', { class: cls('card', 'atlas-card'), 'data-atlas': 'organization-profile' }, [
        h('h1', org.name),
        h('p', `${t('organization.roleLabel')}: ${membership.value?.role ?? ''}`),
        h(
          'div',
          { class: cls('menu', 'atlas-menu'), role: 'tablist' },
          tabs.map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                'aria-selected': tab.value === key,
                class: cls('menuItem', 'atlas-menu-item'),
                'data-atlas': `organization-tab-${key}`,
                onClick: () => (tab.value = key as 'members' | 'invitations' | 'roles' | 'settings'),
              },
              t(`organization.${key}`),
            ),
          ),
        ),
        st.error && !(st.error as OrganizationRequestError).needsReverification
          ? h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert' }, errorText(st.error))
          : null,
        tab.value === 'members' ? members : null,
        tab.value === 'invitations' && canManage ? invitations : null,
        tab.value === 'roles' && canManage ? rolesPanel : null,
        tab.value === 'settings' ? settings : null,
      ]);
    };
  },
});

/** The labels `<OrganizationAuditLog/>` renders; every one is optional. */
export interface OrganizationAuditLogLabels {
  title?: string;
  empty?: string;
  loadMore?: string;
  actor?: string;
}

/**
 * `<OrganizationAuditLog/>` — the active organization's audit trail for its
 * admins, next to `<OrganizationProfile/>`. Renders nothing for a member who may
 * not read it (the server is the authority; the component just follows it).
 * Labels are props so an app can localise them.
 */
export const OrganizationAuditLog = defineComponent({
  name: 'OrganizationAuditLog',
  props: {
    pageSize: { type: Number, default: undefined },
    action: { type: String, default: undefined },
    labels: { type: Object as PropType<OrganizationAuditLogLabels>, default: () => ({}) },
    formatDate: {
      type: Function as PropType<(ms: number) => string>,
      default: (ms: number) => new Date(ms).toLocaleString(),
    },
  },
  setup(props) {
    const { organization } = useOrganization();
    const log = useOrganizationAuditLog({ pageSize: props.pageSize, action: props.action });
    const cls = useClass();

    return () => {
      const state = log.state.value;
      if (!organization.value || state.forbidden) return null;
      const labels = props.labels;

      return h('div', { class: cls('card', 'atlas-card'), 'data-atlas': 'organization-audit-log' }, [
        h('h2', { class: cls('headerTitle', 'atlas-title') }, labels.title ?? 'Audit log'),
        state.entries.length === 0 && !state.loading
          ? h('p', { class: cls('headerSubtitle', 'atlas-subtitle') }, labels.empty ?? 'No activity recorded yet.')
          : h(
              'ul',
              { class: cls('list', 'atlas-audit-list') },
              state.entries.map((entry) =>
                h('li', { key: entry.id, class: cls('listItem', 'atlas-audit-item'), 'data-action': entry.action }, [
                  h('strong', describeAuditAction(entry.action)),
                  h(
                    'span',
                    { class: 'atlas-audit-meta' },
                    ` · ${props.formatDate(entry.created_at)}` +
                      (entry.actor.id ? ` · ${labels.actor ?? 'by'} ${entry.actor.type} ${entry.actor.id}` : ''),
                  ),
                ]),
              ),
            ),
        state.hasMore
          ? h(
              'button',
              {
                type: 'button',
                class: cls('formButtonSecondary', 'atlas-button-secondary'),
                disabled: state.loading,
                onClick: () => void log.loadMore(),
              },
              labels.loadMore ?? 'Load more',
            )
          : null,
      ]);
    };
  },
});

/** The English text `<PricingTable/>` renders; every one is optional. */
export interface PricingTableLabels {
  monthly?: string;
  yearly?: string;
  perMonth?: string;
  perYear?: string;
  free?: string;
  subscribe?: string;
  trial?: (days: number) => string;
  useCode?: (code: string) => string;
}

/**
 * `<PricingTable/>` — the instance's plans as cards: a locale-formatted price,
 * features, a free-trial badge, a monthly/yearly switch when a plan has an annual
 * price, and a plan's promotion (label, struck-through price, the code to enter at
 * checkout). The subscribe button starts the provider's hosted Checkout and needs
 * a signed-in session. `audience` shows only `user` or `org` plans.
 */
export const PricingTable = defineComponent({
  name: 'PricingTable',
  props: {
    audience: { type: String as PropType<'user' | 'org'>, default: undefined },
    orgId: { type: String, default: undefined },
    locale: { type: String, default: undefined },
    labels: { type: Object as PropType<PricingTableLabels>, default: () => ({}) },
  },
  setup(props) {
    const { status } = useAuth();
    const { plans, isLoaded, checkout } = usePricingPlans({ audience: props.audience });
    const cls = useClass();
    const interval = shallowRef<'month' | 'year'>('month');
    const busy = shallowRef<string | null>(null);

    return () => {
      if (!isLoaded.value) return h('div', { 'data-atlas': 'pricing-table', 'aria-busy': 'true' });
      const L = {
        monthly: 'Monthly', yearly: 'Yearly', perMonth: 'month', perYear: 'year', free: 'Free', subscribe: 'Subscribe',
        trial: (d: number) => `${d}-day free trial`, useCode: (c: string) => `Use code ${c} at checkout`,
        ...props.labels,
      };
      const locale = props.locale ?? (typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined);
      const hasAnnual = plans.value.some((p) => p.annual_available);
      return h('div', { class: cls('pricingTable', 'atlas-pricing-table'), 'data-atlas': 'pricing-table' }, [
        hasAnnual
          ? h(
              'div',
              { role: 'group', 'aria-label': 'Billing interval', 'data-atlas': 'pricing-interval' },
              (['month', 'year'] as const).map((i) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: cls('formButtonSecondary', 'atlas-button-secondary'),
                    'aria-pressed': interval.value === i,
                    onClick: () => {
                      interval.value = i;
                    },
                  },
                  i === 'month' ? L.monthly : L.yearly,
                ),
              ),
            )
          : null,
        ...plans.value.map((plan) => {
          const view = planPriceView(plan, { interval: interval.value, locale });
          return h('div', { key: plan.id, class: cls('card', 'atlas-card'), 'data-atlas': 'pricing-plan' }, [
            h('h3', { class: cls('planName', 'atlas-plan-name') }, plan.name),
            view.promotionLabel ? h('p', { 'data-atlas': 'pricing-promotion', class: cls('badge', 'atlas-badge') }, view.promotionLabel) : null,
            h('p', { class: cls('price', 'atlas-price') }, [
              view.originalPrice ? h('s', { 'data-atlas': 'pricing-original' }, view.originalPrice) : null,
              ' ',
              view.free ? L.free : view.price,
              view.free ? null : h('span', { class: cls('priceInterval', 'atlas-interval') }, ` / ${view.interval === 'year' ? L.perYear : L.perMonth}`),
            ]),
            view.trialDays ? h('p', { 'data-atlas': 'pricing-trial', class: cls('badge', 'atlas-badge') }, L.trial(view.trialDays)) : null,
            view.promotionCode ? h('p', { 'data-atlas': 'pricing-code', class: cls('text', 'atlas-text') }, L.useCode(view.promotionCode)) : null,
            plan.features.length
              ? h('ul', { class: cls('list', 'atlas-list') }, plan.features.map((f) => h('li', { key: f, class: cls('listItem', 'atlas-list-item') }, f)))
              : null,
            h(
              'button',
              {
                type: 'button',
                class: cls('formButtonPrimary', 'atlas-button'),
                disabled: status.value !== 'signed_in' || busy.value === plan.id,
                onClick: async () => {
                  busy.value = plan.id;
                  try {
                    await checkout({ planId: plan.id, orgId: props.orgId, ...(plan.annual_available ? { interval: interval.value } : {}) });
                  } finally {
                    busy.value = null;
                  }
                },
              },
              L.subscribe,
            ),
          ]);
        }),
      ]);
    };
  },
});

/** The English text `<LeadForm/>` renders; every one is optional. */
export interface LeadFormLabels {
  email?: string;
  name?: string;
  submit?: string;
  consent?: string;
  thanks?: string;
  invalid?: string;
  failed?: string;
}

/**
 * `<LeadForm/>` — a lead / newsletter signup stored with the campaign attribution
 * the SDK captured (see the React `<LeadForm/>`). Emits `submitted` with the address.
 */
export const LeadForm = defineComponent({
  name: 'LeadForm',
  props: {
    form: { type: String, default: 'default' },
    showName: { type: Boolean, default: false },
    requireConsent: { type: Boolean, default: false },
    labels: { type: Object as PropType<LeadFormLabels>, default: () => ({}) },
  },
  emits: ['submitted'],
  setup(props, { emit }) {
    const atlas = useAtlas();
    const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_VUE_SDK });
    const cls = useClass();
    const email = shallowRef('');
    const name = shallowRef('');
    const consent = shallowRef(false);
    const website = shallowRef('');
    const state = shallowRef<'idle' | 'busy' | 'done'>('idle');
    const error = shallowRef<string | null>(null);

    return () => {
      const L = {
        email: 'Email address', name: 'Name', submit: 'Subscribe', consent: 'I agree to receive emails',
        thanks: 'Thanks — you are on the list.', invalid: 'Enter a valid email address.', failed: 'Could not subscribe. Try again.',
        ...props.labels,
      };
      if (state.value === 'done') return h('div', { class: cls('card', 'atlas-card'), 'data-atlas': 'lead-form', role: 'status' }, L.thanks);
      const submit = async (event: Event) => {
        event.preventDefault();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
          error.value = L.invalid;
          return;
        }
        state.value = 'busy';
        error.value = null;
        const out = await submitLead(client, { email: email.value.trim(), name: name.value.trim() || undefined, form: props.form, consent: consent.value, website: website.value });
        if (out.ok) {
          state.value = 'done';
          emit('submitted', email.value.trim());
        } else {
          state.value = 'idle';
          error.value = out.error ?? L.failed;
        }
      };
      const field = (label: string, model: typeof email, type = 'text', autocomplete?: string) =>
        h('label', { class: cls('formField', 'atlas-field') }, [
          h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, label),
          h('input', { class: cls('formFieldInput', 'atlas-input'), type, autocomplete, value: model.value, onInput: (e: Event) => { model.value = (e.target as HTMLInputElement).value; } }),
        ]);
      return h('form', { class: cls('card', 'atlas-card'), 'data-atlas': 'lead-form', novalidate: true, onSubmit: submit }, [
        props.showName ? field(L.name, name, 'text', 'name') : null,
        field(L.email, email, 'email', 'email'),
        props.requireConsent
          ? h('label', { class: cls('formField', 'atlas-field') }, [
              h('input', { type: 'checkbox', checked: consent.value, onChange: (e: Event) => { consent.value = (e.target as HTMLInputElement).checked; } }),
              ` ${L.consent}`,
            ])
          : null,
        h('input', {
          'aria-hidden': 'true', tabindex: -1, autocomplete: 'off', name: 'website', value: website.value,
          style: 'position:absolute;left:-10000px;width:1px;height:1px;opacity:0',
          onInput: (e: Event) => { website.value = (e.target as HTMLInputElement).value; },
        }),
        error.value ? h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert' }, error.value) : null,
        h('button', { class: cls('formButtonPrimary', 'atlas-button'), type: 'submit', disabled: state.value === 'busy' || (props.requireConsent && !consent.value) }, L.submit),
      ]);
    };
  },
});
