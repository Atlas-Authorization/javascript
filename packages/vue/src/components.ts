import { defineComponent, h, reactive, ref, watch, type PropType, type VNode } from 'vue';
import {
  localizedErrorMessage,
  nextStep,
  offeredFirstFactors,
  planFirstFactor,
  type AttemptView,
  type CaptchaController,
  type EmailDelivery,
  type FieldError,
  type InstanceSettings,
  type PublicSignUpField,
  type Step,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { useAuth, useOrganization, useUser } from './composables';
import { useFlow } from './flow';
import { classFor, type ElementKey } from './appearance';
import { translate } from './i18n';
import { evaluate } from './protect';

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
const AttemptFlow = defineComponent({
  name: 'AttemptFlow',
  props: {
    attempt: { type: Object as PropType<AttemptView | null>, default: null },
    busy: { type: Boolean, default: false },
    errors: { type: Array as PropType<FieldError[]>, default: () => [] },
    titleKey: { type: String, required: true },
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
  },
  setup(props) {
    const t = useText();
    const errorText = useErrorText();
    const cls = useClass();
    const values = reactive<Record<string, string>>({});
    // The first factor the user picked: the password field by default, or the
    // code field / "check your email" once an emailed code / link was sent.
    const factor = ref<'password' | 'email_code' | 'email_link'>('password');
    watch(
      () => props.attempt?.id,
      () => {
        factor.value = 'password';
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

    const field = (name: string, labelKey: string, type = 'text'): VNode =>
      h('label', { class: 'atlas-field', key: name }, [
        h('span', t(labelKey)),
        h('input', {
          class: cls('formFieldInput', 'atlas-input'),
          type,
          name,
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
        case 'collect_second_factor':
          return [field('code', 'mfa.codeLabel')];
        case 'enroll_second_factor':
          // Two codes, not one. §5.6 wants consecutive codes so a phone with a
          // fast clock fails here rather than on every sign-in afterwards.
          return [
            field('code', 'mfa.enrollFirstCodeLabel'),
            field('secondCode', 'mfa.enrollSecondCodeLabel'),
          ];
        case 'collect_email_code':
          return [field('code', 'signIn.emailCodeLabel')];
        case 'collect_new_password':
          return [field('password', 'reset.newPasswordLabel', 'password')];
        case 'collect_captcha':
          // §5 the server withheld the attempt until a captcha clears. Solving
          // the widget resubmits the identifier on its own; the button retries.
          return [h('p', { key: 'captcha-prompt', class: 'atlas-text' }, t('captcha.prompt'))];
        case 'await_oauth':
          return [h('p', { key: 'oauth' }, t('signIn.magicLinkSent'))];
        case 'done':
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

    return () => {
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
            !(step.kind === 'collect_first_factor' && factor.value === 'email_link') &&
            !(step.kind === 'collect_first_factor' && factor.value === 'password' && firstFactorPlan()?.password === false && (firstFactorPlan()?.email.length ?? 0) > 0)
              ? h(
                  'button',
                  {
                    class: cls('formButtonPrimary', 'atlas-button'),
                    disabled: props.busy,
                    type: 'submit',
                  },
                  t('signIn.submit'),
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
  },
  setup() {
    const { state, submit, prepare, captcha, settings } = useFlow();
    return () => {
      // Read the settings so the form re-renders (drawing the captcha slot)
      // once the instance's captcha config has loaded; the controller is passed
      // only while it draws, so the child sees a changed prop.
      void settings.value;
      return h(AttemptFlow, {
        attempt: state.value.attempt,
        busy: state.value.busy,
        errors: state.value.errors,
        titleKey: 'signIn.title',
        onSubmit: submit,
        captcha: captcha.needed ? captcha : null,
        emailDelivery: settings.value?.emailDelivery ?? null,
        onPrepare: prepare,
      });
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
  },
  setup(props) {
    const t = useText();
    const errorText = useErrorText();
    const cls = useClass();
    const values = reactive<Record<string, string>>({});
    const agreed = ref(false);

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

    const textField = (name: string, labelKey: string, type: string, autocomplete: string) =>
      h('label', { key: name, class: cls('formField', 'atlas-field') }, [
        h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, t(labelKey)),
        h('input', {
          class: cls('formFieldInput', 'atlas-input'),
          type,
          name,
          autocomplete,
          required: true,
          value: values[name] ?? '',
          onInput: (e: Event) => {
            values[name] = (e.target as HTMLInputElement).value;
          },
        }),
        ...fieldErrors(name),
      ]);

    return () => {
      const legal = props.settings?.legal;
      const showLegal = !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
      const consentOk = !legal?.required || agreed.value;
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
      if (props.settings?.emailDelivery?.passwordSignUp === false) {
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
            textField('email', 'signUp.emailLabel', 'email', 'email'),
            textField('password', 'signUp.passwordLabel', 'password', 'new-password'),
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
          ],
        ),
      ]);
    };
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
    const { state, submit, create, settings, signUpCaptcha } = useFlow();
    return () =>
      state.value.attempt
        ? h(AttemptFlow, {
            attempt: state.value.attempt,
            busy: state.value.busy,
            errors: state.value.errors,
            titleKey: 'signUp.title',
            onSubmit: submit,
          })
        : h(SignUpForm, {
            settings: settings.value,
            busy: state.value.busy,
            errors: state.value.errors,
            captcha: signUpCaptcha.needed ? signUpCaptcha : null,
            onSubmit: create,
          });
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
    const t = useText();
    const cls = useClass();

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
              ]),
            ),
          ),
        ]),
        h('section', [
          h('h2', t('userProfile.securitySection')),
          h('p', u.mfa_enabled ? '2FA on' : '2FA off'),
        ]),
      ]);
    };
  },
});

export const OrganizationProfile = defineComponent({
  name: 'OrganizationProfile',
  setup() {
    const { organization, membership } = useOrganization();
    const t = useText();
    const cls = useClass();

    return () => {
      const org = organization.value;
      if (!org) return null;

      return h('div', { class: cls('card', 'atlas-card') }, [
        h('h1', org.name),
        h('p', `${t('organization.roleLabel')}: ${membership.value?.role ?? ''}`),
        // Management controls are gated on the ACTIVE org role, matching the
        // server's §9.2 rule rather than duplicating a looser one.
        h(Protect, { permission: 'org:sys_memberships:manage' }, () =>
          h('button', t('organization.invite')),
        ),
      ]);
    };
  },
});
