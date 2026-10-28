import { createSignal, onMount, type JSX } from 'solid-js';
import {
  FapiClient,
  clearCibaPin,
  decideCibaRequest,
  getCibaPin,
  listCibaRequests,
  setCibaPin,
  type CibaPinStatus,
  type CibaRequest,
} from '@atlasauth/js';
import { h } from './h';
import { useAtlas } from './context';
import { ATLAS_SOLID_SDK } from './version';

/**
 * `<ManageCiba/>` — sign-in requests apps start on the user's behalf (CIBA), with approve and deny, and the
 * optional CIBA PIN apps must send as the user code. Renders nothing when there is no request, no PIN and no
 * app that could ask.
 */
export function ManageCiba(): JSX.Element {
  const atlas = useAtlas();
  const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_SOLID_SDK });
  const [requests, setRequests] = createSignal<CibaRequest[]>([]);
  const [pin, setPin] = createSignal<CibaPinStatus | null>(null);
  const [newPin, setNewPin] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [message, setMessage] = createSignal<string | null>(null);

  const load = async () => {
    const [r, p] = await Promise.all([listCibaRequests(client).catch(() => []), getCibaPin(client).catch(() => null)]);
    setRequests(r);
    setPin(p);
  };
  onMount(() => void load());

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setMessage(null);
    try {
      await fn();
      setNewPin('');
      setPassword('');
      await load();
    } catch (e) {
      setMessage(e instanceof Error && e.message ? e.message : fallback);
    }
  };

  const button = 'atlas-button-secondary';
  return (() => {
    const p = pin();
    if (!requests().length && !(p && (p.set || p.available))) return null;
    return h('section', { class: 'atlas-card', 'data-atlas': 'manage-ciba' }, [
      requests().length
        ? [
            h('h2', 'Sign-in requests from apps'),
            h('ul', requests().map((r) =>
              h('li', [
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
        ? h('form', { onSubmit: (e: Event) => { e.preventDefault(); void run(() => setCibaPin(client, { pin: newPin(), currentPassword: password() }), 'Could not save the PIN.'); } }, [
            h('h2', 'CIBA PIN'),
            h('p', `${p.set ? 'You have a CIBA PIN.' : 'You have not set a CIBA PIN.'} Apps that start a sign-in request for you must send it.`),
            h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password', value: password(), onInput: (e: Event) => setPassword((e.target as HTMLInputElement).value) }),
            h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '6 to 12 digits', 'aria-label': 'New CIBA PIN', value: newPin(), onInput: (e: Event) => setNewPin((e.target as HTMLInputElement).value) }),
            h('button', { class: button, type: 'submit' }, p.set ? 'Change PIN' : 'Set PIN'),
            p.set ? h('button', { class: button, type: 'button', onClick: () => void run(() => clearCibaPin(client, { currentPassword: password() }), 'Could not remove the PIN.') }, 'Remove PIN') : null,
            message() ? h('small', { role: 'status' }, message()) : null,
          ])
        : message()
          ? h('small', { role: 'status' }, message())
          : null,
    ]);
  }) as unknown as JSX.Element;
}
