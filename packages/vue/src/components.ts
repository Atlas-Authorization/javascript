import { defineComponent, h, reactive, ref, type PropType, type VNode } from 'vue';
import { nextStep, type AttemptView, type FieldError } from '@atlasauth/js';
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
  },
  setup(props) {
    const t = useText();
    const cls = useClass();
    const values = reactive<Record<string, string>>({});

    const field = (name: string, labelKey: string, type = 'text'): VNode =>
      h('label', { class: 'atlas-field', key: name }, [
        h('span', t(labelKey)),
        h('input', {
          class: cls('formFieldInput', 'atlas-input'),
          type,
          value: values[name] ?? '',
          onInput: (event: Event) => {
            values[name] = (event.target as HTMLInputElement).value;
          },
        }),
        ...props.errors
          .filter((error) => error.param === name)
          .map((error) =>
            h('span', { class: cls('formFieldError', 'atlas-error'), key: error.code }, error.message),
          ),
      ]);

    const fields = (kind: string): VNode[] => {
      switch (kind) {
        case 'collect_identifier':
          return [field('identifier', 'signIn.identifierLabel', 'email')];
        case 'collect_first_factor':
          return [field('password', 'signIn.passwordLabel', 'password')];
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
              error.message,
            ),
          ),

        h(
          'form',
          {
            onSubmit: (event: Event) => {
              event.preventDefault();
              props.onSubmit({ ...values });
            },
          },
          [
            ...fields(step.kind),
            step.kind !== 'done' && step.kind !== 'await_oauth'
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
    const { state, submit } = useFlow();
    return () =>
      h(AttemptFlow, {
        attempt: state.value.attempt,
        busy: state.value.busy,
        errors: state.value.errors,
        titleKey: 'signIn.title',
        onSubmit: submit,
      });
  },
});

export const SignUp = defineComponent({
  name: 'SignUp',
  props: {
    afterUrl: { type: String, default: undefined },
  },
  setup() {
    const { state, submit } = useFlow();
    return () =>
      h(AttemptFlow, {
        attempt: state.value.attempt,
        busy: state.value.busy,
        errors: state.value.errors,
        titleKey: 'signUp.title',
        onSubmit: submit,
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
