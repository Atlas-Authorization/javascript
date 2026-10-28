import { defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, watch, type PropType } from 'vue';
import {
  PolicyAcceptanceController,
  PolicyGateController,
  controllerForPending,
  formatPolicyDate,
  loadPolicies,
  injectPolicyStyles,
  joinTitles,
  mountPolicyAcceptStep,
  mountPolicyClickwrap,
  mountPolicyConsent,
  policyTranslator,
  type MountedPolicyUi,
  type Policy,
  type PolicyAcceptancePayload,
  type PolicyClasses,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { FapiClient } from './fapi';
import { classFor } from './appearance';
import { translate } from './i18n';
import { ATLAS_VUE_SDK } from './version';

/**
 * Policy acceptance (terms of service, privacy, any policy) — the Vue half.
 * `<SignUp>` and `<SignIn>` use these themselves; they are exported for custom
 * forms and for in-app re-acceptance (`<PolicyGate/>`). The state machine and the
 * DOM pieces come from `@atlasauth/js`, shared with every framework SDK.
 */

function usePolicyText() {
  const { catalog } = useAtlas();
  return policyTranslator((key, vars) => translate(catalog, key, vars));
}

function useClient(): FapiClient {
  const atlas = useAtlas();
  return new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_VUE_SDK });
}

function useClasses(): PolicyClasses {
  const { appearance } = useAtlas();
  return {
    link: 'atlas-link',
    text: 'atlas-text',
    primaryButton: classFor('formButtonPrimary', appearance, 'atlas-button'),
    error: classFor('formFieldError', appearance, 'atlas-error'),
  };
}

/**
 * A reactive counter that bumps whenever the controller changes: read it in a
 * render function to re-render on a tick, a new version or an open document.
 */
export function usePolicyState(controller: PolicyAcceptanceController) {
  const version = ref(0);
  const off = controller.subscribe(() => {
    version.value += 1;
  });
  onBeforeUnmount(off);
  return version;
}

/**
 * Load the instance's policies into a controller (`GET /v1/client/policies`);
 * resolves to an empty list when it has none.
 */
export function usePolicies(options: { combined?: boolean; signIn?: boolean } = {}) {
  const client = useClient();
  const { locale } = useAtlas();
  const controller = new PolicyAcceptanceController([], { combined: options.combined });
  const loading = ref(true);
  const refresh = async () => {
    controller.setPolicies(await loadPolicies(client, { locale: locale ?? undefined, signIn: options.signIn }));
    loading.value = false;
  };
  onMounted(() => {
    void refresh();
  });
  return { controller, loading, refresh, build: (): PolicyAcceptancePayload[] => controller.build() };
}

function hostComponent(
  name: string,
  mount: (host: HTMLElement, controller: PolicyAcceptanceController, t: ReturnType<typeof usePolicyText>, classes: PolicyClasses) => MountedPolicyUi,
  tag: 'div' | 'p',
) {
  return defineComponent({
    name,
    props: { controller: { type: Object as PropType<PolicyAcceptanceController>, required: true } },
    setup(props) {
      const t = usePolicyText();
      const classes = useClasses();
      const host = ref<HTMLElement | null>(null);
      let mounted: MountedPolicyUi | null = null;
      onMounted(() => {
        injectPolicyStyles(document);
        if (host.value) mounted = mount(host.value, props.controller, t, classes);
      });
      onBeforeUnmount(() => mounted?.destroy());
      return () => h(tag, { ref: host });
    },
  });
}

/** The checkbox-mode policies (combined or one each) with the in-page viewer. */
export const PolicyConsent = hostComponent('PolicyConsent', (host, controller, t, classes) => mountPolicyConsent(host, controller, { t, classes }), 'div');

/** The clickwrap sentence for `link`-mode policies, drawn under the submit button. */
export const PolicyClickwrap = hostComponent('PolicyClickwrap', (host, controller, t, classes) => mountPolicyClickwrap(host, controller, { t, classes }), 'p');

/**
 * The sign-in step for a `needs_policy_acceptance` attempt: scroll-mode policies
 * in their unskippable dialog, the rest as checkboxes, then "Accept and
 * continue". Emits `submit` with the `policy_acceptances` JSON for the flow.
 */
export const PolicyAcceptStep = defineComponent({
  name: 'PolicyAcceptStep',
  props: {
    attempt: { type: Object as PropType<{ id: string | null; pending_policies?: unknown } | null>, default: null },
    busy: { type: Boolean, default: false },
    onSubmit: { type: Function as PropType<(values: Record<string, string>) => void>, required: true },
    onDecline: { type: Function as PropType<(policy: Policy) => void>, default: undefined },
  },
  setup(props) {
    const t = usePolicyText();
    const classes = useClasses();
    const client = useClient();
    const { locale } = useAtlas();
    const host = ref<HTMLElement | null>(null);
    const controller = shallowRef<PolicyAcceptanceController | null>(null);
    let step: ReturnType<typeof mountPolicyAcceptStep> | null = null;
    const draw = () => {
      step?.destroy();
      step = null;
      if (!host.value || !controller.value) return;
      injectPolicyStyles(document);
      step = mountPolicyAcceptStep(host.value, controller.value, {
        t,
        classes,
        onSubmit: (acceptances) => props.onSubmit({ policy_acceptances: JSON.stringify(acceptances) }),
        onDecline: (policy) => props.onDecline?.(policy),
      });
      step.setBusy(props.busy);
    };
    onMounted(() => {
      void controllerForPending(client, props.attempt, { locale: locale ?? undefined }).then((c) => {
        controller.value = c;
        draw();
      });
    });
    watch(
      () => props.busy,
      (busy) => step?.setBusy(busy),
    );
    onBeforeUnmount(() => step?.destroy());
    return () => h('div', { 'data-atlas-policy-step-host': '' }, [controller.value ? null : h('p', { class: 'atlas-text' }, t('policy.loading')), h('div', { ref: host })]);
  },
});

/**
 * In-app re-acceptance: for a signed-in user, a banner when a policy needs
 * re-acceptance; "Review and accept" opens the unskippable dialog / checkboxes
 * and posts `/v1/client/me/policies/accept`. Renders its slot always.
 */
export const PolicyGate = defineComponent({
  name: 'PolicyGate',
  props: {
    onAccepted: { type: Function as PropType<() => void>, default: undefined },
  },
  setup(props, { slots }) {
    const atlas = useAtlas();
    const t = usePolicyText();
    const classes = useClasses();
    const client = useClient();
    const gate = new PolicyGateController(client, atlas.locale ?? undefined);
    const tick = ref(0);
    const open = ref(false);
    const error = ref('');
    const host = ref<HTMLElement | null>(null);
    let step: ReturnType<typeof mountPolicyAcceptStep> | null = null;
    const off = gate.subscribe(() => {
      tick.value += 1;
    });
    watch(
      () => atlas.status.value,
      (status) => {
        if (status === 'signed_in') void gate.load();
      },
      { immediate: true },
    );
    const begin = async () => {
      const controller = await gate.begin();
      open.value = true;
      await Promise.resolve();
      if (!host.value) return;
      injectPolicyStyles(document);
      step = mountPolicyAcceptStep(host.value, controller, {
        t,
        classes,
        onSubmit: async () => {
          step?.setBusy(true);
          const res = await gate.accept(controller);
          step?.setBusy(false);
          if (!res.ok) {
            error.value = res.errors[0]?.message ?? t('policy.requiredGeneric');
            return;
          }
          step?.destroy();
          step = null;
          open.value = false;
          props.onAccepted?.();
        },
        onDecline: () => {
          step?.destroy();
          step = null;
          open.value = false;
        },
      });
    };
    onBeforeUnmount(() => {
      off();
      step?.destroy();
    });
    return () => {
      void tick.value;
      const titles = gate.pending.map((p) => p.title);
      const banner =
        gate.pending.length > 0 && !open.value
          ? h('div', { class: 'atlas-policy-banner', role: 'status', 'data-atlas-policy-banner': '' }, [
              h('span', [
                h('strong', `${t('policy.bannerTitle')}. `),
                t('policy.bannerBody', { policies: joinTitles(titles, t('policy.and')) }),
                gate.graceEndsAt ? ` ${t('policy.bannerGrace', { date: formatPolicyDate(gate.graceEndsAt) })}` : '',
              ]),
              h('button', { type: 'button', class: classes.link, onClick: () => void begin() }, t('policy.bannerReview')),
            ])
          : null;
      return [
        banner,
        open.value ? h('div', { class: classFor('card', atlas.appearance, 'atlas-card'), 'data-atlas-policy-gate': '' }, [h('div', { ref: host }), error.value ? h('p', { class: classes.error, role: 'alert' }, error.value) : null]) : null,
        slots.default?.(),
      ];
    };
  },
});
