import { conditionalUiAvailable, getPasskeyAssertion, passkeysSupported } from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { render, renderErrors } from './render';
import { complete } from './flow';

/**
 * §5.5 usernameless passkey sign-in: begin (discoverable-credential options) →
 * navigator.credentials.get via the SDK helper → finish. The finish endpoint
 * mints the session and sets the cookie itself, so there is NO ticket exchange —
 * on `complete` we go straight to complete(). A cancelled ceremony quietly
 * returns to the form; a server error surfaces on the panel.
 */
export async function passkeySignIn(w: AtlasWidget): Promise<void> {
  if (w.busy) return;
  w.conditionalAbort?.abort(); // the explicit button supersedes autofill
  w.busy = true;
  render(w);

  const begin = await w.client.post<Record<string, unknown>>(
    '/v1/client/sign_ins/passkey/begin',
    {},
  );
  if (!begin.ok || !begin.data) {
    w.busy = false;
    renderErrors(w, begin.errors);
    return;
  }

  let finishBody;
  try {
    finishBody = await getPasskeyAssertion(begin.data);
  } catch {
    // User cancelled the OS prompt, or no credential — return to the form.
    w.busy = false;
    render(w);
    return;
  }

  const res = await w.client.post<{ status?: string; created_session_id?: string }>(
    '/v1/client/sign_ins/passkey/finish',
    finishBody,
  );
  w.busy = false;
  if (res.ok && res.data?.status === 'complete') {
    // The cookie is already set by /finish — no exchange, just finish up.
    await complete(w, res.data.created_session_id ?? null);
    return;
  }
  renderErrors(w, res.errors);
}

/**
 * §5.5 conditional-UI passkey autofill. Armed once after the sign-in form
 * mounts (when the instance offers passkeys and the browser supports the
 * conditional mediation), it runs a discoverable-credential `get` in the
 * background so saved passkeys appear in the email field's autofill. It NEVER
 * shows UI of its own and is aborted the moment the user does anything else
 * (submits / clicks the passkey button), so it can't fight the normal flow.
 */
export async function startConditionalPasskey(w: AtlasWidget): Promise<void> {
  if (w.mode !== 'sign-in' || !w.passkeyEnabled || !passkeysSupported()) return;
  let available = false;
  try {
    available = await conditionalUiAvailable();
  } catch {
    available = false;
  }
  if (!available) return;

  w.conditionalAbort?.abort();
  const controller = new AbortController();
  w.conditionalAbort = controller;
  try {
    const begin = await w.client.post<Record<string, unknown>>(
      '/v1/client/sign_ins/passkey/begin',
      {},
    );
    if (!begin.ok || !begin.data || controller.signal.aborted) return;
    const finishBody = await getPasskeyAssertion(begin.data, {
      mediation: 'conditional',
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const res = await w.client.post<{ status?: string; created_session_id?: string }>(
      '/v1/client/sign_ins/passkey/finish',
      finishBody,
    );
    if (res.ok && res.data?.status === 'complete') {
      await complete(w, res.data.created_session_id ?? null);
    }
  } catch {
    // Aborted (the user typed/submitted instead) or no passkey selected — silent.
  }
}
