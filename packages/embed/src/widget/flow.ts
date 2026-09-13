import {
  advance,
  flowFromPending,
  initialFlow,
  initialResetFlow,
  nativeSignInBody,
  nextStep,
  parseNativeSignInResponse,
  readRedirectResult,
  resetStep,
  sendTelemetry,
  startSignUp,
  startPasswordReset,
  advancePasswordReset,
  stripRedirectParams,
} from '@atlasauth/js';
import { validateRedirect } from '../redirect';
import type { AtlasWidget } from '../widget';
import type { CaptchaFlowKey } from '../appearance';
import { flowNeedsCaptcha, getCaptchaToken, isRenderable } from './captcha';
import { render, renderNote, renderErrors } from './render';

/**
 * §5 obtain a captcha token for a flow, mounting the challenge OUTSIDE `w.root`
 * (render() wipes root on every paint, so a host inside it would vanish). The
 * host is removed as soon as the token resolves. Returns null when no token is
 * needed or the provider isn't one the widget renders — the server still fails
 * closed if it required one, surfacing the normal CAPTCHA_REQUIRED error.
 *
 * `always` renders even when the flow's always-on flag is off — used for a
 * risk-triggered sign-in challenge, where the server demands a token mid-flow
 * regardless of the per-flow toggle.
 */
async function captchaToken(
  w: AtlasWidget,
  key: CaptchaFlowKey,
  always = false,
): Promise<string | null> {
  const flow = w.captchaFlows[key];
  const wanted = always ? !!flow && isRenderable(flow.provider) : flowNeedsCaptcha(flow);
  if (!wanted || !flow) return null;
  const doc = w.root.ownerDocument ?? document;
  const host = doc.createElement('div');
  host.className = 'atlas-embed-captcha';
  (w.root.parentElement ?? doc.body ?? doc.documentElement).appendChild(host);
  try {
    return await getCaptchaToken(flow, host);
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

// ---- redirect landing (OAuth / hosted completion) ------------------------

export async function handleRedirectLanding(w: AtlasWidget): Promise<boolean> {
  const win = w.root.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  if (!win) return false;

  const result = readRedirectResult(win.location.search);
  if (!result) return false;

  if (result.ticket) {
    await exchange(w, result.attemptId, result.ticket);
    scrubUrl(w, win);
    await complete(w, result.attemptId);
    return true;
  }

  // A redirect that carries a status but no ticket owes a second factor:
  // resume the flow AT that step, bound to the same attempt.
  if (result.status) {
    w.state = flowFromPending({ id: result.attemptId, status: result.status });
    scrubUrl(w, win);
  }
  return false;
}

function scrubUrl(w: AtlasWidget, win: Window): void {
  try {
    win.history.replaceState({}, win.document.title, stripRedirectParams(win.location.href));
  } catch {
    // A sandboxed history is not fatal — the flow still works.
  }
}

// ---- completion ----------------------------------------------------------

export async function exchange(w: AtlasWidget, attemptId: string, ticket: string): Promise<void> {
  // Preview: the flow ran end-to-end, but we deliberately do NOT redeem the
  // ticket — no session cookie is set, so the host page's session is untouched.
  if (w.options.preview) return;
  // §7.5 carry the Remember-me choice so the server can make the refresh cookie
  // persistent (default) or a session cookie (unticked).
  await w.client.post('/v1/client/tickets/exchange', {
    attempt_id: attemptId,
    ticket,
    remember: w.remember,
  });
}

/**
 * Finish: navigate to a VALIDATED redirect, or — when none is supplied or it
 * is rejected — emit `atlas:complete` so the embedding page decides. The event
 * bubbles and is cancelable-free; its detail carries the attempt id.
 */
export async function complete(w: AtlasWidget, attemptId: string | null): Promise<void> {
  const win = w.root.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const target = validateRedirect(
    w.options.redirect,
    win ? win.location.origin : undefined,
  );

  w.root.dispatchEvent(
    new CustomEvent('atlas:complete', {
      bubbles: true,
      detail: { attemptId, redirected: Boolean(target) },
    }),
  );

  // Preview never navigates and never claims a session — it confirms the flow.
  if (w.options.preview) {
    renderNote(w, 'Sign-in works — this is a preview, so no session was created.');
    return;
  }
  if (target && win) {
    win.location.assign(target);
    return;
  }
  renderNote(w, 'You are signed in.');
}

// ---- flow submit ---------------------------------------------------------

/**
 * §bot — fire the anti-bot signal beacon for this interaction. Fully
 * best-effort and fire-and-forget: it never blocks or fails a sign-in.
 */
export function beacon(w: AtlasWidget, attemptId?: string | null): void {
  void sendTelemetry({
    api: w.options.frontendApi,
    publishableKey: w.options.publishableKey,
    attemptId: attemptId ?? undefined,
    kind: w.mode === 'sign-up' ? 'sign_up' : 'sign_in',
    recorder: w.recorder,
    fetchImpl: w.options.fetchImpl,
  });
}

export async function submit(w: AtlasWidget, values: Record<string, string>): Promise<void> {
  if (w.busy) return;
  // The user is signing in by other means — stand down the background passkey
  // autofill ceremony so it cannot resolve underneath them.
  w.conditionalAbort?.abort();
  w.flash = null; // the confirmation banner clears once the user acts

  // Remember the identifier so the code/password steps can show it as context.
  if (typeof values.identifier === 'string' && values.identifier.trim()) {
    w.enteredIdentifier = values.identifier.trim();
  }
  w.busy = true;
  // Beacon at the moment of submit — behaviour is richest here.
  beacon(w, (w.state.attempt as { id?: string } | undefined)?.id);
  render(w);

  w.state = await advance(w.client, w.state, values);

  // §5 the server withheld the attempt pending a captcha (an always-on sign-in
  // gate, or a risk-triggered challenge): render the provider's widget and
  // resubmit the identifier with the token. `always` so a risk challenge renders
  // even when the sign-in flow's always-on toggle is off.
  if (w.state.attempt && nextStep(w.state.attempt).kind === 'collect_captcha') {
    const token = await captchaToken(w, 'signIn', true);
    if (token) {
      w.state = await advance(w.client, w.state, {
        identifier: w.enteredIdentifier ?? values.identifier ?? '',
        captcha_token: token,
      });
    }
  }

  // Single-screen sign-in: the identifier POST just landed on the first-factor
  // step and the user already typed their password on the same form — send it
  // now so it's one click, not two screens. Only when the server actually
  // asked for the first factor and the identifier step raised no error.
  const step = w.state.attempt ? nextStep(w.state.attempt) : null;
  if (step?.kind === 'collect_first_factor' && values.password && w.state.errors.length === 0) {
    w.state = await advance(w.client, w.state, { password: values.password });
  }
  w.busy = false;

  // §single-screen: a sign-in box that shows email + password TOGETHER must not
  // collapse to a password-only screen after a wrong password — that reads as
  // "the email field just vanished". Return to the combined box (email prefilled
  // from what they typed) carrying any error, so a wrong credential reads as "try
  // again" in the same box. The next submit starts a fresh attempt — cheaper than
  // stranding the user on a field-less screen.
  const endStep = w.state.attempt ? nextStep(w.state.attempt) : null;
  if (w.mode === 'sign-in' && w.passwordEnabled && endStep?.kind === 'collect_first_factor') {
    w.state = { ...initialFlow, errors: w.state.errors };
  }

  const attempt = w.state.attempt;
  if (attempt?.status === 'complete') {
    const attemptId = (attempt as { id?: string }).id ?? null;
    if (w.state.ticket && attemptId) await exchange(w, attemptId, w.state.ticket);
    await complete(w, attemptId);
    return;
  }
  render(w);
}

export async function startOAuth(w: AtlasWidget, provider: string, identifier?: string): Promise<void> {
  // §bot — beacon before we navigate away to the provider.
  beacon(w);
  const win = w.root.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  // The OAuth callback must return to a page that runs the widget so it can
  // exchange the ticket — this page. The server additionally requires this
  // URL to be one of the instance's allowedOrigins.
  const redirectUrl = win ? stripRedirectParams(win.location.href) : w.options.frontendApi;

  const response = await w.client.post<{ authorization_url?: string }>(
    '/v1/client/sign_ins/oauth',
    // Bluesky (AT-Proto) resolves the user's PDS from their handle, so it is
    // sent up front; every other provider ignores `identifier`.
    { provider, redirect_url: redirectUrl, ...(identifier ? { identifier } : {}) },
  );
  const url = response.data?.authorization_url;
  if (url && win) win.location.assign(url);
  else {
    w.handlePrompt = null;
    renderErrors(w, response.errors);
  }
}

/**
 * Start a "Sign in with Atlas" (or any SSO connection) sign-in: POST the
 * connection id, then navigate to the authorize URL the server returns. The OIDC
 * callback returns to this page (an allowed origin) to exchange the ticket — the
 * same completion path startOAuth uses.
 *
 * `opts.popup` runs the flow in a GSI-style popup window instead of a full-page
 * redirect; the callback hands the ticket back via postMessage and this page
 * exchanges it in place. A blocked popup falls back to the redirect flow.
 */
export async function startSso(
  w: AtlasWidget,
  connectionId: string,
  opts: { popup?: boolean } = {},
): Promise<void> {
  beacon(w);
  const win = w.root.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const baseRedirect = win ? stripRedirectParams(win.location.href) : w.options.frontendApi;

  if (opts.popup && win) {
    await startSsoPopup(w, connectionId, win, baseRedirect);
    return;
  }

  const response = await w.client.post<{ authorization_url?: string }>(
    '/v1/client/sign_ins/sso',
    { connection_id: connectionId, redirect_url: baseRedirect },
  );
  const url = response.data?.authorization_url;
  if (url && win) win.location.assign(url);
  else renderErrors(w, response.errors);
}

/** The origin the popup handoff posts from — the widget's own FAPI origin. */
function fapiOrigin(w: AtlasWidget): string {
  const fa = w.options.frontendApi;
  try {
    return new URL(/^https?:\/\//.test(fa) ? fa : `https://${fa}`).origin;
  } catch {
    return fa;
  }
}

/**
 * The GSI-style popup variant. The popup is opened SYNCHRONOUSLY (before the
 * async POST) so the browser treats it as user-initiated and does not block it;
 * a blocked popup falls back to the full-page redirect. The callback lands in
 * the popup, posts the ticket to this window (origin-checked), and we finish the
 * sign-in here — the same exchange→complete path the redirect landing uses.
 */
async function startSsoPopup(
  w: AtlasWidget,
  connectionId: string,
  win: Window,
  baseRedirect: string,
): Promise<void> {
  const popup = win.open(
    'about:blank',
    'atlas-sso',
    'width=480,height=640,menubar=no,toolbar=no,location=no,status=no',
  );
  if (!popup) {
    // Popup blocked — fall back to the reliable redirect flow.
    await startSso(w, connectionId);
    return;
  }

  const sep = baseRedirect.includes('?') ? '&' : '?';
  const redirectUrl = `${baseRedirect}${sep}__atlas_display=popup`;
  const expectedOrigin = fapiOrigin(w);

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== expectedOrigin) return;
    const data = event.data as
      | { type?: string; ticket?: string; attempt_id?: string; status?: string; error?: string }
      | null;
    if (!data || data.type !== 'atlas-sso') return;
    win.removeEventListener('message', onMessage);
    try {
      popup.close();
    } catch {
      /* a cross-origin popup may already be gone */
    }
    if (data.error) {
      renderErrors(w, [{ code: 'sso_popup_cancelled', message: 'Sign-in was cancelled.' }]);
      return;
    }
    if (data.status === 'complete' && data.ticket && data.attempt_id) {
      const attemptId = data.attempt_id;
      const ticket = data.ticket;
      void (async () => {
        await exchange(w, attemptId, ticket);
        await complete(w, attemptId);
      })();
      return;
    }
    // Owes a second factor — resume the flow in THIS window at that step.
    if (data.attempt_id && data.status) {
      w.state = flowFromPending({ id: data.attempt_id, status: data.status });
      render(w);
    }
  };
  win.addEventListener('message', onMessage);

  const response = await w.client.post<{ authorization_url?: string }>(
    '/v1/client/sign_ins/sso',
    { connection_id: connectionId, redirect_url: redirectUrl },
  );
  const url = response.data?.authorization_url;
  if (url) {
    try {
      popup.location.assign(url);
    } catch {
      // Some browsers disallow scripting a popup we just navigated cross-origin;
      // fall back to navigating this window instead.
      try {
        popup.close();
      } catch {
        /* ignore */
      }
      win.removeEventListener('message', onMessage);
      win.location.assign(url);
    }
  } else {
    win.removeEventListener('message', onMessage);
    try {
      popup.close();
    } catch {
      /* ignore */
    }
    renderErrors(w, response.errors);
  }
}

/**
 * Complete a native / One-Tap sign-in: POST the provider id_token, then either
 * exchange the returned ticket for cookies (complete) or resume at the second
 * factor the attempt still owes — the SAME completion paths the redirect flow
 * uses, so GSI and the redirect flow finish identically.
 */
export async function completeIdToken(w: AtlasWidget, provider: string, idToken: string): Promise<void> {
  const res = await w.client.post<{ id?: string; status?: string; ticket?: string }>(
    '/v1/client/sign_ins/id_token',
    nativeSignInBody({ provider, idToken }),
  );
  const parsed = parseNativeSignInResponse(res.data);
  if (!parsed) {
    renderErrors(w, res.errors);
    return;
  }
  if (parsed.status === 'complete' && parsed.ticket) {
    await exchange(w, parsed.attemptId, parsed.ticket);
    await complete(w, parsed.attemptId);
    return;
  }
  // Owes a second factor — resume at that step, bound to the same attempt.
  w.state = flowFromPending({ id: parsed.attemptId, status: parsed.status });
  render(w);
}

/** §5.4 enter the "forgot password" sub-flow. */
export function startReset(w: AtlasWidget): void {
  w.resetFlow = { ...initialResetFlow };
  render(w);
}

/** Drive the reset one step: start it, or advance it, then complete on success. */
export async function submitReset(w: AtlasWidget, values: Record<string, string>): Promise<void> {
  if (w.busy || !w.resetFlow) return;
  w.busy = true;
  beacon(w);
  render(w);

  if (resetStep(w.resetFlow) === 'request') {
    if (typeof values.email === 'string' && values.email.trim()) {
      w.enteredIdentifier = values.email.trim();
    }
    const token = await captchaToken(w, 'passwordReset');
    w.resetFlow = await startPasswordReset(w.client, values.email ?? '', token ?? undefined);
  } else {
    w.resetFlow = await advancePasswordReset(w.client, w.resetFlow, {
      code: values.code,
      password: values.password,
    });
  }
  w.busy = false;

  const done = w.resetFlow;
  if (done?.attempt?.status === 'complete') {
    const attemptId = done.attempt.id;
    w.resetFlow = null;
    if (done.ticket) {
      // Auto sign-in: exchange the ticket for a session, exactly like a normal
      // sign-in completion.
      await exchange(w, attemptId, done.ticket);
      await complete(w, attemptId);
    } else {
      // Force-login: no session was issued. Return to the sign-in box (email
      // already prefilled) with a confirmation, so the user signs in with the
      // new password.
      w.flash = 'Password updated. Sign in with your new password.';
      w.state = initialFlow;
      render(w);
    }
    return;
  }
  render(w);
}

export async function submitSignUp(w: AtlasWidget, values: Record<string, string>, consent = true): Promise<void> {
  if (w.busy) return;
  w.busy = true;
  beacon(w);
  render(w);

  const { identifier, password, ...rest } = values;
  // Drop blank optional fields so we never send empty strings to the server.
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) if (value) fields[key] = value;

  const token = await captchaToken(w, 'signUp');
  w.state = await startSignUp(w.client, {
    email: identifier ?? '',
    password: password ?? '',
    fields,
    consent,
    captchaToken: token ?? undefined,
  });
  w.busy = false;

  const attempt = w.state.attempt;
  if (attempt?.status === 'complete') {
    const attemptId = (attempt as { id?: string }).id ?? null;
    if (w.state.ticket && attemptId) await exchange(w, attemptId, w.state.ticket);
    await complete(w, attemptId);
    return;
  }
  render(w);
}
