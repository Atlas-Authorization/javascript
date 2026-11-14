import { defineComponent, h, onMounted, ref, watch, type PropType } from 'vue';
import {
  DEVICE_AUTH_LABELS,
  REVERIFICATION_LABELS,
  formatLabel,
  formatUserCode,
  userCodeFromUrl,
  type DeviceAuthorization as DeviceAuthorizationRecord,
  type DeviceAuthorizationLabels,
  type ReverificationLabels,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { classFor, type ElementKey } from './appearance';
import { useDeviceAuthorization } from './managed-components';

/**
 * `<DeviceAuthorization/>` — device sign-in (RFC 8628) on your own page: the signed-in user enters the code their
 * TV, console or terminal shows, sees which app asks for what, and allows or denies it. Reads `?user_code=` from
 * the page URL, so it works as the verification URI too. Emits `approved` and `denied`.
 */
export const DeviceAuthorization = defineComponent({
  name: 'DeviceAuthorization',
  props: {
    userCode: { type: String, default: undefined },
    labels: { type: Object as PropType<DeviceAuthorizationLabels & { reverification?: ReverificationLabels }>, default: () => ({}) },
  },
  emits: { approved: (_a: DeviceAuthorizationRecord) => true, denied: (_a: DeviceAuthorizationRecord) => true },
  setup(props, { emit }) {
    const atlas = useAtlas();
    const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
    const { state, controller } = useDeviceAuthorization();
    const code = ref(props.userCode ?? '');
    const password = ref('');
    const reauthError = ref<string | null>(null);

    // A code passed in, or on the verification URL the device showed, is looked up straight away.
    onMounted(() => {
      const initial = props.userCode ?? (typeof window !== 'undefined' ? userCodeFromUrl(window.location.href) : null);
      if (initial) {
        code.value = formatUserCode(initial);
        void controller.lookup(initial);
      }
    });
    watch(
      () => state.value.status,
      (status) => {
        const a = state.value.authorization;
        if (status === 'approved' && a) emit('approved', a);
        if (status === 'denied' && a) emit('denied', a);
      },
    );

    const confirmIdentity = async () => {
      reauthError.value = null;
      try {
        await controller.completeReverification(password.value);
        password.value = '';
      } catch (e) {
        reauthError.value = e instanceof Error ? e.message : 'Re-authentication failed.';
      }
    };
    const button = (label: string, onClick: () => void, primary = false, disabled = false) =>
      h('button', { type: 'button', class: primary ? cls('formButtonPrimary', 'atlas-button') : cls('formButtonSecondary', 'atlas-button-secondary'), disabled, onClick }, label);

    return () => {
      const s = state.value;
      const l = { ...DEVICE_AUTH_LABELS, ...props.labels };
      const r = { ...REVERIFICATION_LABELS, ...props.labels.reverification };
      const a = s.authorization;
      const busy = s.status === 'busy';
      let body;
      if (s.status === 'approved') body = h('p', { class: cls('text', 'atlas-text'), role: 'status', 'data-atlas': 'device-authorization-approved' }, l.approved);
      else if (s.status === 'denied') body = h('p', { class: cls('text', 'atlas-text'), role: 'status', 'data-atlas': 'device-authorization-denied' }, l.denied);
      else if (a && (s.status === 'review' || busy))
        body = h('div', { 'data-atlas': 'device-authorization-review' }, [
          h('p', { class: cls('text', 'atlas-text') }, formatLabel(l.request, { app: a.client.name })),
          a.scopes.length
            ? [h('p', { class: cls('text', 'atlas-text') }, l.scopesTitle), h('ul', { class: cls('list', 'atlas-list'), 'data-atlas': 'device-authorization-scopes' }, a.scopes.map((sc) => h('li', { key: sc.scope, class: cls('listItem', 'atlas-list-item') }, sc.description)))]
            : null,
          h('p', { class: cls('text', 'atlas-text'), 'data-atlas': 'device-authorization-code' }, formatLabel(l.checkCode, { code: a.userCode })),
          s.needsReverification
            ? h('div', { 'data-atlas': 'device-authorization-reverification', role: 'dialog', 'aria-label': r.title }, [
                h('p', h('strong', r.title)),
                h('p', r.subtitle),
                h('label', { class: cls('formField', 'atlas-field') }, [
                  h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, r.passwordLabel),
                  h('input', { class: cls('formFieldInput', 'atlas-account-input'), type: 'password', autocomplete: 'current-password', value: password.value, onInput: (e: Event) => (password.value = (e.target as HTMLInputElement).value) }),
                ]),
                reauthError.value ? h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert' }, reauthError.value) : null,
                button(r.submit, () => void confirmIdentity(), true),
                button(r.cancel, () => controller.cancelReverification()),
              ])
            : h('div', [button(l.approve, () => void controller.approve(), true, busy), button(l.deny, () => void controller.deny(), false, busy)]),
        ]);
      else
        body = h(
          'form',
          {
            'data-atlas': 'device-authorization-entry',
            onSubmit: (e: Event) => {
              e.preventDefault();
              void controller.lookup(code.value);
            },
          },
          [
            h('p', { class: cls('text', 'atlas-text') }, l.subtitle),
            h('label', { class: cls('formField', 'atlas-field') }, [
              h('span', { class: cls('formFieldLabel', 'atlas-field-label') }, l.codeLabel),
              h('input', { class: cls('formFieldInput', 'atlas-account-input'), value: code.value, autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: false, placeholder: 'XXXX-XXXX', onInput: (e: Event) => (code.value = (e.target as HTMLInputElement).value) }),
            ]),
            s.error ? h('p', { class: cls('formFieldError', 'atlas-error'), role: 'alert' }, s.invalidCode ? l.invalidCode : s.error) : null,
            h('button', { type: 'submit', class: cls('formButtonPrimary', 'atlas-button'), disabled: busy || !code.value.trim() }, l.continue),
          ],
        );
      return h('section', { class: cls('card', 'atlas-card'), 'data-atlas': 'device-authorization' }, [
        h('h2', { class: 'atlas-section-title' }, l.title),
        body,
        s.status === 'approved' || s.status === 'denied' || s.status === 'error'
          ? button(l.another, () => {
              code.value = '';
              controller.reset();
            })
          : null,
      ]);
    };
  },
});
