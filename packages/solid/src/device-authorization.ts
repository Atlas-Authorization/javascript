import { createEffect, createSignal, on, onMount, type JSX } from 'solid-js';
import {
  DEVICE_AUTH_LABELS,
  REVERIFICATION_LABELS,
  formatLabel,
  formatUserCode,
  userCodeFromUrl,
  type DeviceAuthorization as DeviceAuthorizationRecord,
  type DeviceAuthorizationLabels,
  type ReverificationLabels,
} from '@atlasauth/js';
import { h } from './h';
import { createDeviceAuthorization } from './managed';

export interface DeviceAuthorizationProps {
  /** Start with this code (otherwise `?user_code=` on the page URL, if present). */
  userCode?: string;
  labels?: DeviceAuthorizationLabels & { reverification?: ReverificationLabels };
  onApproved?: (authorization: DeviceAuthorizationRecord) => void;
  onDenied?: (authorization: DeviceAuthorizationRecord) => void;
}

/**
 * `<DeviceAuthorization/>` — device sign-in (RFC 8628) on your own page: the signed-in user enters the code their
 * TV, console or terminal shows, sees which app asks for what, and allows or denies it. Reads `?user_code=` from
 * the page URL, so it works as the verification URI too.
 */
export function DeviceAuthorization(props: DeviceAuthorizationProps = {}): JSX.Element {
  const { state, controller } = createDeviceAuthorization();
  const [code, setCode] = createSignal(props.userCode ?? '');
  const [password, setPassword] = createSignal('');
  const [reauthError, setReauthError] = createSignal<string | null>(null);

  onMount(() => {
    const initial = props.userCode ?? (typeof window !== 'undefined' ? userCodeFromUrl(window.location.href) : null);
    if (initial) {
      setCode(formatUserCode(initial));
      void controller.lookup(initial);
    }
  });
  createEffect(
    on(
      () => state().status,
      (status) => {
        const a = state().authorization;
        if (status === 'approved' && a) props.onApproved?.(a);
        if (status === 'denied' && a) props.onDenied?.(a);
      },
      { defer: true },
    ),
  );

  const confirmIdentity = async () => {
    setReauthError(null);
    try {
      await controller.completeReverification(password());
      setPassword('');
    } catch (e) {
      setReauthError(e instanceof Error ? e.message : 'Re-authentication failed.');
    }
  };
  const button = (label: string, onClick: () => void, primary = false, disabled = false) =>
    h('button', { type: 'button', class: primary ? 'atlas-button' : 'atlas-button-secondary', disabled, onClick }, label);

  return (() => {
    const s = state();
    const l = { ...DEVICE_AUTH_LABELS, ...props.labels };
    const r = { ...REVERIFICATION_LABELS, ...props.labels?.reverification };
    const a = s.authorization;
    const busy = s.status === 'busy';
    let body: unknown;
    if (s.status === 'approved') body = h('p', { class: 'atlas-text', role: 'status', 'data-atlas': 'device-authorization-approved' }, l.approved);
    else if (s.status === 'denied') body = h('p', { class: 'atlas-text', role: 'status', 'data-atlas': 'device-authorization-denied' }, l.denied);
    else if (a && (s.status === 'review' || busy))
      body = h('div', { 'data-atlas': 'device-authorization-review' }, [
        h('p', { class: 'atlas-text' }, formatLabel(l.request, { app: a.client.name })),
        a.scopes.length ? [h('p', { class: 'atlas-text' }, l.scopesTitle), h('ul', { class: 'atlas-list', 'data-atlas': 'device-authorization-scopes' }, a.scopes.map((sc) => h('li', { class: 'atlas-list-item' }, sc.description)))] : null,
        h('p', { class: 'atlas-text', 'data-atlas': 'device-authorization-code' }, formatLabel(l.checkCode, { code: a.userCode })),
        s.needsReverification
          ? h('div', { 'data-atlas': 'device-authorization-reverification', role: 'dialog', 'aria-label': r.title }, [
              h('p', h('strong', r.title)),
              h('p', r.subtitle),
              h('label', { class: 'atlas-field' }, [h('span', { class: 'atlas-field-label' }, r.passwordLabel), h('input', { class: 'atlas-account-input', type: 'password', autocomplete: 'current-password', value: password(), onInput: (e: Event) => setPassword((e.target as HTMLInputElement).value) })]),
              reauthError() ? h('p', { class: 'atlas-error', role: 'alert' }, reauthError()) : null,
              button(r.submit, () => void confirmIdentity(), true),
              button(r.cancel, () => controller.cancelReverification()),
            ])
          : h('div', [button(l.approve, () => void controller.approve(), true, busy), button(l.deny, () => void controller.deny(), false, busy)]),
      ]);
    else
      body = h(
        'form',
        {
          'data-atlas': 'device-authorization-entry',
          onSubmit: (e: Event) => {
            e.preventDefault();
            void controller.lookup(code());
          },
        },
        [
          h('p', { class: 'atlas-text' }, l.subtitle),
          h('label', { class: 'atlas-field' }, [h('span', { class: 'atlas-field-label' }, l.codeLabel), h('input', { class: 'atlas-account-input', value: code(), autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: false, placeholder: 'XXXX-XXXX', onInput: (e: Event) => setCode((e.target as HTMLInputElement).value) })]),
          s.error ? h('p', { class: 'atlas-error', role: 'alert' }, s.invalidCode ? l.invalidCode : s.error) : null,
          h('button', { type: 'submit', class: 'atlas-button', disabled: busy || !code().trim() }, l.continue),
        ],
      );
    return h('section', { class: 'atlas-card', 'data-atlas': 'device-authorization' }, [
      h('h2', { class: 'atlas-section-title' }, l.title),
      body,
      s.status === 'approved' || s.status === 'denied' || s.status === 'error'
        ? button(l.another, () => {
            setCode('');
            controller.reset();
          })
        : null,
    ]);
  }) as unknown as JSX.Element;
}
