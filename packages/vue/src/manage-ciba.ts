import { defineComponent, h, onMounted, ref } from 'vue';
import {
  clearCibaPin,
  decideCibaRequest,
  getCibaPin,
  listCibaRequests,
  setCibaPin,
  type CibaPinStatus,
  type CibaRequest,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { FapiClient } from './fapi';
import { ATLAS_VUE_SDK } from './version';
import { classFor, type ElementKey } from './appearance';

/**
 * Sign-in requests apps start on the user's behalf (CIBA), with approve and deny, and the optional CIBA PIN apps
 * must send as the user code. Renders nothing when there is no request, no PIN and no app that could ask.
 */
export const ManageCiba = defineComponent({
  name: 'ManageCiba',
  setup() {
    const atlas = useAtlas();
    const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_VUE_SDK });
    const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
    const requests = ref<CibaRequest[]>([]);
    const pin = ref<CibaPinStatus | null>(null);
    const newPin = ref('');
    const password = ref('');
    const message = ref<string | null>(null);

    const load = async () => {
      const [r, p] = await Promise.all([listCibaRequests(client).catch(() => []), getCibaPin(client).catch(() => null)]);
      requests.value = r;
      pin.value = p;
    };
    onMounted(load);

    const run = async (fn: () => Promise<unknown>, fallback: string) => {
      message.value = null;
      try {
        await fn();
        newPin.value = '';
        password.value = '';
        await load();
      } catch (e) {
        message.value = e instanceof Error && e.message ? e.message : fallback;
      }
    };

    return () => {
      const p = pin.value;
      if (!requests.value.length && !(p && (p.set || p.available))) return null;
      const button = cls('formButtonSecondary', 'atlas-button-secondary');
      return h('section', { class: cls('card', 'atlas-card'), 'data-atlas': 'manage-ciba' }, [
        requests.value.length
          ? [
              h('h2', 'Sign-in requests from apps'),
              h('ul', requests.value.map((r) =>
                h('li', { key: r.id }, [
                  h('strong', r.client_name),
                  r.binding_message ? h('div', r.binding_message) : null,
                  h('small', r.scope.join(', ')),
                  h('button', { class: button, type: 'button', onClick: () => void run(() => decideCibaRequest(client, r.id, 'approve'), 'Could not approve.') }, 'Approve'),
                  h('button', { class: button, type: 'button', onClick: () => void run(() => decideCibaRequest(client, r.id, 'deny'), 'Could not deny.') }, 'Deny'),
                ]),
              )),
            ]
          : null,
        p && (p.set || p.available)
          ? h('form', { onSubmit: (e: Event) => { e.preventDefault(); void run(() => setCibaPin(client, { pin: newPin.value, currentPassword: password.value }), 'Could not save the PIN.'); } }, [
              h('h2', 'CIBA PIN'),
              h('p', `${p.set ? 'You have a CIBA PIN.' : 'You have not set a CIBA PIN.'} Apps that start a sign-in request for you must send it.`),
              h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password', value: password.value, onInput: (e: Event) => { password.value = (e.target as HTMLInputElement).value; } }),
              h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '6 to 12 digits', 'aria-label': 'New CIBA PIN', value: newPin.value, onInput: (e: Event) => { newPin.value = (e.target as HTMLInputElement).value; } }),
              h('button', { class: button, type: 'submit' }, p.set ? 'Change PIN' : 'Set PIN'),
              p.set ? h('button', { class: button, type: 'button', onClick: () => void run(() => clearCibaPin(client, { currentPassword: password.value }), 'Could not remove the PIN.') }, 'Remove PIN') : null,
              message.value ? h('small', { role: 'status' }, message.value) : null,
            ])
          : message.value
            ? h('small', { role: 'status' }, message.value)
            : null,
      ]);
    };
  },
});
