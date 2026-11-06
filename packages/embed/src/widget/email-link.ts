import { createEmailLinkConfirmation, emailLinkFromUrl, type EmailLinkConfirmation } from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { cls, el, submitButton } from './dom';
import { say } from './mfa';
import { render } from './render';

/** The link page's controller when the widget was opened from a mailed link, else null. */
export function emailLinkPageFor(w: AtlasWidget): EmailLinkConfirmation | null {
  if (w.emailLinkPage === undefined) {
    const link = emailLinkFromUrl(undefined, w.mode === 'sign-up' ? 'sign_up' : 'sign_in');
    w.emailLinkPage = link ? createEmailLinkConfirmation(w.client, link) : null;
    if (w.emailLinkPage) {
      w.emailLinkPage.subscribe(() => queueMicrotask(() => render(w)));
      void w.emailLinkPage.start();
    }
  }
  return w.emailLinkPage;
}

/**
 * The panel a mailed link opens: tries this browser's stored secret, then asks
 * for the code the starting tab shows. A success signs nobody in here: the
 * starting tab continues on its own.
 */
export function renderEmailLinkPage(w: AtlasWidget, page: EmailLinkConfirmation): HTMLElement {
  const { status, busy, errors, resetUrl } = page.state;
  const box = el(w, 'div', 'atlas-embed-email-link');
  box.setAttribute('data-atlas', 'email-link');
  box.setAttribute('data-atlas-status', status);
  box.appendChild(el(w, 'h1', cls(w, 'title', 'atlas-embed-title'), say(w, 'link.title')));
  if (status !== 'needs_code') {
    const note = el(w, 'p', 'atlas-embed-note', say(w, status === 'confirmed' ? 'link.confirmed' : status === 'invalid' ? 'link.invalid' : 'link.checking'));
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    box.appendChild(note);
    if (resetUrl) {
      const reset = el(w, 'a', 'atlas-embed-step-back', say(w, 'signIn.forgotPassword')) as HTMLAnchorElement;
      reset.setAttribute('data-atlas-reset-link', '');
      reset.href = resetUrl;
      box.appendChild(reset);
    }
    return box;
  }
  const form = el(w, 'form', 'atlas-embed-form') as HTMLFormElement;
  form.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'link.enterCodeHelp')));
  const field = el(w, 'label', cls(w, 'field', 'atlas-embed-field'));
  field.appendChild(el(w, 'span', cls(w, 'label', 'atlas-embed-label'), say(w, 'link.codeLabel')));
  const input = el(w, 'input', cls(w, 'input', 'atlas-embed-input')) as HTMLInputElement;
  input.type = 'text';
  input.name = 'match_code';
  input.autocomplete = 'off';
  input.inputMode = 'numeric';
  input.required = true;
  field.appendChild(input);
  form.appendChild(field);
  for (const error of errors) {
    const p = el(w, 'p', 'atlas-embed-error', w.errorText(error));
    p.setAttribute('role', 'alert');
    form.appendChild(p);
  }
  const button = submitButton(w, say(w, 'link.confirm'));
  button.disabled = busy;
  form.appendChild(button);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void page.submitCode(input.value);
  });
  box.appendChild(form);
  return box;
}
