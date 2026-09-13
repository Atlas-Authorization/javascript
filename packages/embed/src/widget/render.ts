import { initialFlow, nextStep, passkeysSupported, resetStep, type FieldError } from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { COPY } from './constants';
import { cls, doc, el } from './dom';
import { renderForm, renderReset, renderSignUpForm } from './forms';
import { renderHandlePrompt, renderPasskeyButton, renderSocial, socialProviders } from './social';

// ---- rendering -----------------------------------------------------------

export function renderNote(w: AtlasWidget, text: string): void {
  w.root.textContent = '';
  const card = el(w, 'div', cls(w, 'card', 'atlas-embed-card'));
  card.appendChild(el(w, 'p', 'atlas-embed-note', text));
  w.root.appendChild(card);
}

/**
 * A proper loading state — shown while /v1/appearance resolves, while an
 * OAuth/hosted ticket is exchanged on redirect-back, and (via `busy`) while a
 * form submits. Replaces the old bare "Loading…" text so the widget never
 * flashes blank. The indicator style is the tenant's `interaction.loading`
 * (spinner | skeleton | dots | bar); `role="status"` announces it to AT.
 */
export function renderLoading(w: AtlasWidget): void {
  w.root.textContent = '';
  const card = el(w, 'div', cls(w, 'card', 'atlas-embed-card'));
  const style = w.interaction.loading;
  const box = el(w, 'div', 'atlas-embed-loading');
  box.setAttribute('data-loading', style);
  box.setAttribute('role', 'status');
  box.setAttribute('aria-label', 'Loading');
  if (style === 'skeleton') {
    for (const kind of ['title', 'sub', 'input', 'input', 'button']) {
      box.appendChild(el(w, 'div', `atlas-embed-skel atlas-embed-skel-${kind}`));
    }
  } else if (style === 'dots') {
    for (let i = 0; i < 3; i += 1) box.appendChild(el(w, 'span', 'atlas-embed-dot'));
  } else if (style === 'bar') {
    box.appendChild(el(w, 'span', 'atlas-embed-loadbar'));
  } else {
    box.appendChild(el(w, 'span', 'atlas-embed-spinner'));
  }
  // A visually-hidden label so a screen reader announces progress for every style.
  const sr = el(w, 'span', 'atlas-embed-sr', 'Loading…');
  box.appendChild(sr);
  card.appendChild(box);
  w.root.appendChild(card);
}

export function renderErrors(w: AtlasWidget, errors: readonly FieldError[]): void {
  // Re-render then surface the errors on the current step.
  w.state = { ...w.state, errors: [...errors] };
  render(w);
}

export function render(w: AtlasWidget): void {
  w.root.textContent = '';
  const card = el(w, 'div', cls(w, 'card', 'atlas-embed-card'));

  const logoUrl = w.appearance?.logoUrl ?? null;
  if (logoUrl) {
    const img = doc(w).createElement('img');
    img.className = 'atlas-embed-logo';
    img.src = logoUrl;
    img.alt = w.appearance?.applicationName ?? '';
    card.appendChild(img);
  }

  // §5.4 the "forgot password" sub-flow takes over the whole panel until it
  // completes or the user goes back to sign in.
  if (w.resetFlow) {
    const rk = `reset_${resetStep(w.resetFlow)}`;
    card.setAttribute('data-step', rk);
    if (rk !== w.lastStepKind) card.setAttribute('data-enter', '');
    w.lastStepKind = rk;
    card.appendChild(renderReset(w));
    if (w.appearance?.footer) {
      card.appendChild(el(w, 'p', cls(w, 'footer', 'atlas-embed-footer'), w.appearance.footer));
    }
    w.root.appendChild(card);
    if (card.hasAttribute('data-enter')) {
      const focusTarget = card.querySelector('[data-atlas-autofocus]');
      if (focusTarget instanceof HTMLElement) focusTarget.focus();
    }
    return;
  }

  const step = w.state.attempt
    ? nextStep(w.state.attempt)
    : ({ kind: 'collect_identifier' } as const);

  // Sign-up mode with no attempt yet: the create-account form — the tenant's
  // configured fields + email + password — posted to /v1/client/sign_ups.
  const isSignUpStart = w.mode === 'sign-up' && !w.state.attempt;
  const atStart = isSignUpStart || step.kind === 'collect_identifier';

  // Mark the card with the step so it can be styled + animate ONLY when the
  // step actually changes (not on every error/busy re-render), so a code step
  // spawns in once rather than flickering on each keystroke.
  const stepKind = w.handlePrompt ? 'handle' : step.kind;
  card.setAttribute('data-step', stepKind);
  if (stepKind !== w.lastStepKind) card.setAttribute('data-enter', '');
  w.lastStepKind = stepKind;

  const title = w.appearance?.headline ?? COPY[w.mode].title;
  card.appendChild(el(w, 'h1', cls(w, 'title', 'atlas-embed-title'), title));

  // At the start, the tenant's own subheadline. On a later step, a context line
  // that ties it back to the email panel ("Enter the code we sent to …") plus a
  // way back — so the code/password step reads as a continuation of the same
  // panel, not a brand-new screen.
  const context = atStart ? null : renderStepContext(w, step.kind);
  if (context) {
    card.appendChild(context);
  } else if (w.appearance?.subheadline) {
    card.appendChild(
      el(w, 'p', cls(w, 'subtitle', 'atlas-embed-subtitle'), w.appearance.subheadline),
    );
  }

  // A one-time confirmation banner (e.g. after a force-login password reset).
  if (w.flash) card.appendChild(el(w, 'div', 'atlas-embed-flash', w.flash));

  // Handle-first provider (Bluesky): a dedicated sub-screen collecting the
  // handle, in place of the normal identifier form + social buttons.
  if (w.handlePrompt) {
    card.appendChild(renderHandlePrompt(w, w.handlePrompt));
    if (w.appearance?.footer) {
      card.appendChild(el(w, 'p', cls(w, 'footer', 'atlas-embed-footer'), w.appearance.footer));
    }
    w.root.appendChild(card);
    return;
  }

  // Social buttons (and "Sign in with Atlas") only make sense at the very start.
  if (atStart && (socialProviders(w).length > 0 || w.signInWithAtlas.enabled)) {
    card.appendChild(renderSocial(w));
    card.appendChild(el(w, 'div', cls(w, 'divider', 'atlas-embed-divider'), 'or'));
  }

  card.appendChild(isSignUpStart ? renderSignUpForm(w) : renderForm(w, step.kind));

  // §5.5 passkey sign-in: a usernameless/discoverable-credential button at the
  // start of a sign-in, shown only when the instance offers passkeys and the
  // browser supports WebAuthn. The server-side finish sets the session cookie
  // directly (no ticket exchange).
  if (atStart && w.mode === 'sign-in' && w.passkeyEnabled && passkeysSupported()) {
    card.appendChild(renderPasskeyButton(w));
  }

  if (w.appearance?.footer) {
    card.appendChild(el(w, 'p', cls(w, 'footer', 'atlas-embed-footer'), w.appearance.footer));
  }

  w.root.appendChild(card);

  // Focus the first code box (or single field) once it is in the DOM, so a code
  // step is ready to type into — but only when the step just changed, never on a
  // busy/error re-render (which would steal focus mid-typing).
  if (card.hasAttribute('data-enter')) {
    const focusTarget = card.querySelector('[data-atlas-autofocus]');
    if (focusTarget instanceof HTMLElement) focusTarget.focus();
  }
}

/**
 * The continuation line under the title on a non-start step: what to do, where
 * the code went, and (where it makes sense) a way back to the email panel — so
 * the step reads as the SAME panel spawning the next field, not a new screen.
 */
export function renderStepContext(w: AtlasWidget, stepKind: string): HTMLElement | null {
  const email = w.enteredIdentifier;
  let text: string | null = null;
  let back = false;
  switch (stepKind) {
    case 'collect_email_code':
      text = email ? `Enter the code we sent to ${email}` : 'Enter the code we sent to your email';
      back = true;
      break;
    case 'collect_first_factor':
      text = email ? `Enter the password for ${email}` : 'Enter your password';
      back = true;
      break;
    case 'collect_second_factor':
      text = w.backupCodeMode
        ? 'Enter one of your backup codes'
        : 'Enter the code from your authenticator app';
      break;
    case 'collect_new_password':
      text = 'Choose a new password';
      break;
    case 'enroll_second_factor':
      text = 'Enter two codes from your authenticator app to finish setup';
      break;
    default:
      return null;
  }

  const wrap = el(w, 'div', 'atlas-embed-step-context');
  wrap.appendChild(el(w, 'p', cls(w, 'subtitle', 'atlas-embed-subtitle'), text));
  if (back) {
    const button = el(w, 'button', 'atlas-embed-step-back', 'Use a different email');
    (button as HTMLButtonElement).type = 'button';
    button.addEventListener('click', () => restart(w));
    wrap.appendChild(button);
  }
  return wrap;
}

/** Back to the start — a fresh identifier panel (the "use a different email" action). */
export function restart(w: AtlasWidget): void {
  w.state = initialFlow;
  w.backupCodeMode = false;
  w.handlePrompt = null;
  w.enteredIdentifier = null;
  render(w);
}
