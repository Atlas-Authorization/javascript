import { captureMarketing, submitLead } from '@atlasauth/js';
import { createClient } from './client';
import { getScriptDefaults } from './config';
import type { MountTarget } from './mount';

export interface LeadFormOptions {
  publishableKey?: string;
  frontendApi?: string;
  /** Which form this is (default `default`); one row per email per form. */
  form?: string;
  showName?: boolean;
  /** Show the consent checkbox and require it. */
  requireConsent?: boolean;
  labels?: Partial<{ email: string; name: string; submit: string; consent: string; thanks: string; invalid: string; failed: string }>;
  locale?: string;
  fetchImpl?: typeof fetch;
  onSubmitted?: (email: string) => void;
}

const h = (tag: string, props: Record<string, string> = {}, ...kids: Array<HTMLElement | string | null>): HTMLElement => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  for (const kid of kids) if (kid !== null) node.append(kid);
  return node;
};

/**
 * Mount a lead / newsletter signup into an element. Stores the address with the
 * campaign attribution captured on the page (when the instance captures it and the
 * visitor consented) and starts that capture itself, so one script tag is enough.
 */
export function mountLeadForm(target: MountTarget, options: LeadFormOptions = {}): { destroy(): void } | null {
  const host = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : (target as HTMLElement);
  const defaults = getScriptDefaults();
  const publishableKey = options.publishableKey ?? defaults.publishableKey;
  const frontendApi = options.frontendApi ?? defaults.frontendApi;
  if (!host) return null;
  if (!publishableKey || !frontendApi) {
    host.textContent = 'Atlas: a publishable key and a frontend API origin are required.';
    return null;
  }
  const client = createClient({ publishableKey, frontendApi, locale: options.locale ?? defaults.locale, fetchImpl: options.fetchImpl });
  void captureMarketing(client).catch(() => undefined);
  const L = {
    email: 'Email address', name: 'Name', submit: 'Subscribe', consent: 'I agree to receive emails',
    thanks: 'Thanks — you are on the list.', invalid: 'Enter a valid email address.', failed: 'Could not subscribe. Try again.',
    ...options.labels,
  };

  const form = h('form', { class: 'atlas-card', 'data-atlas': 'lead-form', novalidate: 'true' });
  const field = (label: string, name: string, type: string, autocomplete: string): [HTMLElement, HTMLInputElement] => {
    const input = h('input', { class: 'atlas-input', type, name, autocomplete }) as HTMLInputElement;
    return [h('label', { class: 'atlas-field' }, h('span', { class: 'atlas-field-label' }, label), input), input];
  };
  const [nameLabel, nameInput] = field(L.name, 'name', 'text', 'name');
  const [emailLabel, emailInput] = field(L.email, 'email', 'email', 'email');
  const consent = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const honeypot = h('input', { name: 'website', 'aria-hidden': 'true', tabindex: '-1', autocomplete: 'off', style: 'position:absolute;left:-10000px;width:1px;height:1px;opacity:0' }) as HTMLInputElement;
  const error = h('p', { class: 'atlas-error', role: 'alert' });
  error.hidden = true;
  const button = h('button', { class: 'atlas-button', type: 'submit' }, L.submit) as HTMLButtonElement;
  if (options.showName) form.append(nameLabel);
  form.append(emailLabel);
  if (options.requireConsent) {
    button.disabled = true;
    consent.addEventListener('change', () => {
      button.disabled = !consent.checked;
    });
    form.append(h('label', { class: 'atlas-field' }, consent, ` ${L.consent}`));
  }
  form.append(honeypot, error, button);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      error.textContent = L.invalid;
      error.hidden = false;
      return;
    }
    button.disabled = true;
    error.hidden = true;
    const out = await submitLead(client, { email, name: nameInput.value.trim() || undefined, form: options.form, consent: consent.checked, website: honeypot.value });
    if (out.ok) {
      host.replaceChildren(h('div', { class: 'atlas-card', 'data-atlas': 'lead-form', role: 'status' }, L.thanks));
      options.onSubmitted?.(email);
    } else {
      button.disabled = options.requireConsent ? !consent.checked : false;
      error.textContent = out.error ?? L.failed;
      error.hidden = false;
    }
  });
  host.replaceChildren(form);
  return { destroy: () => host.replaceChildren() };
}
