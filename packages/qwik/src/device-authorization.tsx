import { component$, noSerialize, useSignal, useStore, useVisibleTask$, type NoSerialize, type PropFunction } from '@builder.io/qwik';
import {
  DEVICE_AUTH_LABELS,
  DeviceAuthorizationController,
  REVERIFICATION_LABELS,
  formatLabel,
  formatUserCode,
  userCodeFromUrl,
  type DeviceAuthorization as DeviceAuthorizationRecord,
  type DeviceAuthorizationLabels,
  type DeviceAuthorizationState,
  type ReverificationLabels,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { meClients } from './managed';

export interface DeviceAuthorizationProps {
  /** Start with this code (otherwise `?user_code=` on the page URL, if present). */
  userCode?: string;
  labels?: DeviceAuthorizationLabels & { reverification?: ReverificationLabels };
  onApproved$?: PropFunction<(authorization: DeviceAuthorizationRecord) => void>;
  onDenied$?: PropFunction<(authorization: DeviceAuthorizationRecord) => void>;
}

const INITIAL: DeviceAuthorizationState = { status: 'idle', authorization: null, error: null, invalidCode: false, needsReverification: false };

/**
 * `<DeviceAuthorization>` — device sign-in (RFC 8628) on your own page: the signed-in user enters the code their
 * TV, console or terminal shows, sees which app asks for what, and allows or denies it. Reads `?user_code=` from
 * the page URL, so it works as the verification URI too.
 */
export const DeviceAuthorization = component$<DeviceAuthorizationProps>((props) => {
  const store = useAtlas();
  const controller = useSignal<NoSerialize<DeviceAuthorizationController>>();
  const snap = useSignal<DeviceAuthorizationState>(INITIAL);
  const ui = useStore({ code: props.userCode ?? '', password: '', reauthError: '' });

  // eslint-disable-next-line qwik/no-use-visible-task -- the controller is a live object the optimizer must not resume.
  useVisibleTask$(({ cleanup }) => {
    const { client, reauth } = meClients(store);
    const c = new DeviceAuthorizationController(client, reauth);
    controller.value = noSerialize(c);
    let last = c.getState().status;
    cleanup(
      c.subscribe((s) => {
        snap.value = s;
        if (s.status !== last) {
          last = s.status;
          if (s.status === 'approved' && s.authorization) void props.onApproved$?.(s.authorization);
          if (s.status === 'denied' && s.authorization) void props.onDenied$?.(s.authorization);
        }
      }),
    );
    const initial = props.userCode ?? userCodeFromUrl(window.location.href);
    if (initial) {
      ui.code = formatUserCode(initial);
      void c.lookup(initial);
    }
  });

  const s = snap.value;
  const l = { ...DEVICE_AUTH_LABELS, ...props.labels };
  const r = { ...REVERIFICATION_LABELS, ...props.labels?.reverification };
  const a = s.authorization;
  const busy = s.status === 'busy';

  return (
    <section class="atlas-card" data-atlas="device-authorization">
      <h2 class="atlas-section-title">{l.title}</h2>
      {s.status === 'approved' ? (
        <p class="atlas-text" role="status" data-atlas="device-authorization-approved">{l.approved}</p>
      ) : s.status === 'denied' ? (
        <p class="atlas-text" role="status" data-atlas="device-authorization-denied">{l.denied}</p>
      ) : a && (s.status === 'review' || busy) ? (
        <div data-atlas="device-authorization-review">
          <p class="atlas-text">{formatLabel(l.request, { app: a.client.name })}</p>
          {a.scopes.length ? (
            <>
              <p class="atlas-text">{l.scopesTitle}</p>
              <ul class="atlas-list" data-atlas="device-authorization-scopes">
                {a.scopes.map((sc) => <li class="atlas-list-item" key={sc.scope}>{sc.description}</li>)}
              </ul>
            </>
          ) : null}
          <p class="atlas-text" data-atlas="device-authorization-code">{formatLabel(l.checkCode, { code: a.userCode })}</p>
          {s.needsReverification ? (
            <div data-atlas="device-authorization-reverification" role="dialog" aria-label={r.title}>
              <p><strong>{r.title}</strong></p>
              <p>{r.subtitle}</p>
              <label class="atlas-field">
                <span class="atlas-field-label">{r.passwordLabel}</span>
                <input class="atlas-account-input" type="password" autocomplete="current-password" value={ui.password} onInput$={(_, el) => (ui.password = el.value)} />
              </label>
              {ui.reauthError ? <p class="atlas-error" role="alert">{ui.reauthError}</p> : null}
              <button
                class="atlas-button"
                type="button"
                onClick$={async () => {
                  ui.reauthError = '';
                  try {
                    await controller.value?.completeReverification(ui.password);
                    ui.password = '';
                  } catch (e) {
                    ui.reauthError = e instanceof Error ? e.message : 'Re-authentication failed.';
                  }
                }}
              >
                {r.submit}
              </button>
              <button class="atlas-button-secondary" type="button" onClick$={() => controller.value?.cancelReverification()}>{r.cancel}</button>
            </div>
          ) : (
            <div>
              <button class="atlas-button" type="button" disabled={busy} onClick$={() => void controller.value?.approve()}>{l.approve}</button>
              <button class="atlas-button-secondary" type="button" disabled={busy} onClick$={() => void controller.value?.deny()}>{l.deny}</button>
            </div>
          )}
        </div>
      ) : (
        <form data-atlas="device-authorization-entry" preventdefault:submit onSubmit$={() => void controller.value?.lookup(ui.code)}>
          <p class="atlas-text">{l.subtitle}</p>
          <label class="atlas-field">
            <span class="atlas-field-label">{l.codeLabel}</span>
            <input class="atlas-account-input" value={ui.code} onInput$={(_, el) => (ui.code = el.value)} autoComplete="one-time-code" autoCapitalize="characters" spellcheck={false} placeholder="XXXX-XXXX" />
          </label>
          {s.error ? <p class="atlas-error" role="alert">{s.invalidCode ? l.invalidCode : s.error}</p> : null}
          <button class="atlas-button" type="submit" disabled={busy || !ui.code.trim()}>{l.continue}</button>
        </form>
      )}
      {s.status === 'approved' || s.status === 'denied' || s.status === 'error' ? (
        <button class="atlas-button-secondary" type="button" onClick$={() => { ui.code = ''; controller.value?.reset(); }}>{l.another}</button>
      ) : null}
    </section>
  );
});
