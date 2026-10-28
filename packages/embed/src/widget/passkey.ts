import {
  beginPasskeySignIn,
  conditionalUiAvailable,
  getPasskeyAssertion,
  passkeysSupported,
  type AttemptView,
  type PasskeyExtensionOptions,
  type PasskeyExtensionResults,
} from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { render, renderErrors } from './render';
import { captchaToken, complete } from './flow';
import { flowNeedsCaptcha } from './captcha';

/**
 * §5.5 usernameless passkey sign-in: begin (discoverable-credential options) →
 * navigator.credentials.get via the SDK helper → finish. The finish endpoint
 * mints the session and sets the cookie itself, so there is NO ticket exchange —
 * on `complete` we go straight to complete(). A cancelled ceremony quietly
 * returns to the form; a server error surfaces on the panel.
 */
/**
 * A passkey that only proved presence (no PIN / biometric) on an account that
 * owes MFA: the finish answers with a sign-in attempt at its second-factor (or
 * enrolment) step instead of a session. Continue there like any sign-in.
 */
function continuePending(w: AtlasWidget, data: { status?: string; id?: string } | null | undefined): boolean {
  if (!data || !data.id || !data.status || data.status === 'complete') return false;
  w.state = { ...w.state, attempt: data as AttemptView, errors: [] };
  render(w);
  return true;
}

/** The `atlas:passkey-prf` event's detail: the ceremony's PRF results, for the host page only. */
export interface PasskeyPrfEventDetail {
  /** The credential used (base64url). */
  credentialId: string;
  /** Whether the authenticator evaluated PRF (false when it does not support it). */
  enabled: boolean;
  /** The PRF outputs, when evaluated. */
  results?: { first: Uint8Array; second?: Uint8Array };
}

/**
 * When the page opted in (`passkeyPrf`), request PRF in the ceremony and hand
 * the results to the page as an `atlas:passkey-prf` CustomEvent on the widget's
 * element. They are never part of the request to Atlas.
 */
function prfOptions(w: AtlasWidget): PasskeyExtensionOptions {
  const prf = w.options.passkeyPrf;
  if (!prf) return {};
  return {
    prf,
    onExtensionResults: (r: PasskeyExtensionResults) => {
      const detail: PasskeyPrfEventDetail = {
        credentialId: r.credentialId,
        enabled: Boolean(r.prf?.results) || r.prf?.enabled === true,
        ...(r.prf?.results ? { results: r.prf.results } : {}),
      };
      const view = w.root.ownerDocument?.defaultView;
      const Ctor = (view as unknown as { CustomEvent?: typeof CustomEvent } | null)?.CustomEvent ?? CustomEvent;
      w.root.dispatchEvent(new Ctor('atlas:passkey-prf', { detail, bubbles: false }));
    },
  };
}

export async function passkeySignIn(w: AtlasWidget): Promise<void> {
  if (w.busy) return;
  w.conditionalAbort?.abort(); // the explicit button supersedes autofill
  w.busy = true;
  render(w);

  // A sign-in the instance always challenges takes the captcha at the ceremony
  // start: the always-on sign-in captcha's token rides in the begin body, and a
  // refusal (a force-challenge switch, or a spent / rejected token) draws the
  // challenge once more and retries with the fresh token.
  const begin = await beginPasskeySignIn(w.client, {
    captcha: ({ retry }) => captchaToken(w, 'signIn', retry),
  });
  if (!begin.ok || !begin.data) {
    w.busy = false;
    renderErrors(w, begin.errors);
    return;
  }

  let finishBody;
  try {
    finishBody = await getPasskeyAssertion(begin.data, prfOptions(w));
  } catch {
    // User cancelled the OS prompt, or no credential — return to the form.
    w.busy = false;
    render(w);
    return;
  }

  const res = await w.client.post<{ status?: string; id?: string; created_session_id?: string }>(
    '/v1/client/sign_ins/passkey/finish',
    finishBody,
  );
  w.busy = false;
  if (res.ok && res.data?.status === 'complete') {
    // The cookie is already set by /finish — no exchange, just finish up.
    await complete(w, res.data.created_session_id ?? null);
    return;
  }
  if (res.ok && continuePending(w, res.data)) return;
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

  // An always-on sign-in captcha needs the user to act, which a background
  // autofill request cannot do: the button takes the captcha instead.
  if (flowNeedsCaptcha(w.captchaFlows.signIn)) return;

  w.conditionalAbort?.abort();
  const controller = new AbortController();
  w.conditionalAbort = controller;
  try {
    // No captcha here: a refusal (a force-challenge switch) leaves the autofill
    // off, quietly — the button and the email step still take the challenge.
    const begin = await beginPasskeySignIn(w.client);
    if (!begin.ok || !begin.data || controller.signal.aborted) return;
    const finishBody = await getPasskeyAssertion(begin.data, {
      mediation: 'conditional',
      signal: controller.signal,
      ...prfOptions(w),
    });
    if (controller.signal.aborted) return;
    const res = await w.client.post<{ status?: string; id?: string; created_session_id?: string }>(
      '/v1/client/sign_ins/passkey/finish',
      finishBody,
    );
    if (res.ok && res.data?.status === 'complete') {
      await complete(w, res.data.created_session_id ?? null);
    } else if (res.ok) {
      continuePending(w, res.data);
    }
  } catch {
    // Aborted (the user typed/submitted instead) or no passkey selected — silent.
  }
}
