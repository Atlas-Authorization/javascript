import { component$, noSerialize, useSignal, useVisibleTask$, type NoSerialize } from '@builder.io/qwik';
import { FapiClient } from '@atlasauth/js';
import { useAtlas } from './context';
import { CibaController, cibaVisible, type CibaSnapshot } from './ciba';

/**
 * `<ManageCiba>` — sign-in requests apps start on the user's behalf (CIBA), with approve and deny, and the
 * optional CIBA PIN apps must send as the user code. Renders nothing when there is no request, no PIN and no
 * app that could ask. The controller is a live object, so it is held `noSerialize`d and created client-side.
 */
export const ManageCiba = component$(() => {
  const store = useAtlas();
  const controller = useSignal<NoSerialize<CibaController>>();
  const snap = useSignal<CibaSnapshot>({ requests: [], pin: null, message: null });
  const newPin = useSignal('');
  const password = useSignal('');

  // eslint-disable-next-line qwik/no-use-visible-task -- the controller is a live object the optimizer must not resume.
  useVisibleTask$(({ cleanup }) => {
    const c = new CibaController(new FapiClient({ publishableKey: store.publishableKey, baseUrl: store.frontendApi }));
    controller.value = noSerialize(c);
    cleanup(c.subscribe((s) => (snap.value = s)));
    void c.load();
  });

  const { requests, pin, message } = snap.value;
  if (!cibaVisible(snap.value) && !message) return <>{null}</>;
  return (
    <section class="atlas-card" data-atlas="manage-ciba">
      {requests.length ? (
        <>
          <h2>Sign-in requests from apps</h2>
          <ul>
            {requests.map((r) => (
              <li key={r.id}>
                <strong>{r.client_name}</strong>
                {r.binding_message ? <div>{r.binding_message}</div> : null}
                <small>{r.scope.join(', ')}</small>
                <button class="atlas-button-secondary" type="button" onClick$={() => void controller.value?.decide(r.id, 'approve')}>
                  Approve
                </button>
                <button class="atlas-button-secondary" type="button" onClick$={() => void controller.value?.decide(r.id, 'deny')}>
                  Deny
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pin && (pin.set || pin.available) ? (
        <form
          preventdefault:submit
          onSubmit$={async () => {
            if (await controller.value?.savePin(newPin.value, password.value)) {
              newPin.value = '';
              password.value = '';
            }
          }}
        >
          <h2>CIBA PIN</h2>
          <p>{pin.set ? 'You have a CIBA PIN.' : 'You have not set a CIBA PIN.'} Apps that start a sign-in request for you must send it.</p>
          <input type="password" autocomplete="current-password" placeholder="Current password" aria-label="Current password" bind:value={password} />
          <input type="password" inputMode="numeric" autocomplete="off" placeholder="6 to 12 digits" aria-label="New CIBA PIN" bind:value={newPin} />
          <button class="atlas-button-secondary" type="submit">{pin.set ? 'Change PIN' : 'Set PIN'}</button>
          {pin.set ? (
            <button
              class="atlas-button-secondary"
              type="button"
              onClick$={async () => {
                if (await controller.value?.removePin(password.value)) password.value = '';
              }}
            >
              Remove PIN
            </button>
          ) : null}
        </form>
      ) : null}
      {message ? <small role="status">{message}</small> : null}
    </section>
  );
});
