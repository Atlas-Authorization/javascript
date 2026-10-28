import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyAcceptanceController, normalizePolicy, type Policy } from '@atlasauth/js';
import {
  createPolicyClient,
  loadPendingController,
  loadPolicyController,
  mountAcceptStep,
  mountClickwrap,
  mountConsent,
  mountPolicyGate,
  policyText,
} from './policies';

/**
 * The Qwik policy helpers mount `@atlasauth/js`'s DOM pieces into a ref'd host
 * and tear them down, like `mountAtlasWidget`. They run here against happy-dom
 * and a fake Frontend API.
 */

const BASE = 'https://fapi.example.test';

function policy(key: string, extra: Record<string, unknown> = {}): Policy {
  return normalizePolicy({
    key,
    title: key.toUpperCase(),
    display: 'checkbox',
    required: true,
    version_id: `polv_${key}`,
    version: '1',
    content_html: `<p>${key} body</p>`,
    content_sha256: `sha_${key}`,
    ...extra,
  })!;
}

function fakeApi(handlers: Record<string, (body: any) => unknown>) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return new Response('null', { status: 404 });
    const out = handler(body) as { status?: number; body?: unknown };
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const POLICIES = {
  object: 'list',
  data: [
    { object: 'policy', key: 'tos', title: 'Terms', display: 'checkbox', required: true, applies_to: 'sign_in_and_sign_up', version_id: 'polv_1', version: '2', content_html: '<p>Hello</p>', content_sha256: 'abc' },
    { object: 'policy', key: 'privacy', title: 'Privacy', display: 'scroll', required: true, applies_to: 'sign_up', version_id: 'polv_2', version: '3', content_html: '<p>P</p>', content_sha256: 'def' },
  ],
};

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('policyText', () => {
  it('falls back to English and applies overrides', () => {
    expect(policyText()('policy.accept')).toBe('Accept');
    expect(policyText({ 'policy.accept': 'Aceptar' })('policy.accept')).toBe('Aceptar');
    expect(policyText({ 'policy.required': 'Falta {policy}' })('policy.required', { policy: 'TOS' })).toBe('Falta TOS');
  });
});

describe('loading', () => {
  it('createPolicyClient + loadPolicyController load the policies, filtered for sign-in', async () => {
    const { fetchImpl, calls } = fakeApi({ 'GET /v1/client/policies': () => ({ body: POLICIES }) });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const client = createPolicyClient({ publishableKey: 'pk_test', frontendApi: BASE, locale: 'fr' });
      const all = await loadPolicyController(client, { locale: 'fr' });
      expect(all.policies.map((p) => p.key)).toEqual(['tos', 'privacy']);
      expect(calls[0]!.path).toBe('/v1/client/policies?locale=fr');
      const signIn = await loadPolicyController(client, { signIn: true });
      expect(signIn.policies.map((p) => p.key)).toEqual(['tos']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('loadPendingController fills in the content a held attempt only listed', async () => {
    const { fetchImpl } = fakeApi({ 'GET /v1/client/policies': () => ({ body: POLICIES }) });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const client = createPolicyClient({ publishableKey: 'pk_test', frontendApi: BASE });
      const c = await loadPendingController(client, {
        pending_policies: [{ policy: 'tos', title: 'Terms', display: 'checkbox', version_id: 'polv_1', version: '2', content_sha256: 'abc' }],
      });
      expect(c.policies[0]!.contentHtml).toBe('<p>Hello</p>');
      expect(c.policies[0]!.required).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('mountConsent / mountClickwrap', () => {
  it('mounts the combined checkbox, ticks the controller, and tears down', () => {
    const c = new PolicyAcceptanceController([policy('tos'), policy('privacy')]);
    const host = document.createElement('div');
    document.body.append(host);
    const off = mountConsent(host, c);
    const box = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box).not.toBeNull();
    expect(host.textContent).toContain('I agree to the TOS and PRIVACY');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(c.canSubmit()).toBe(true);
    expect(document.getElementById('atlas-policy-styles')).not.toBeNull();
    off();
    expect(host.childElementCount).toBe(0);
    expect(() => off()).not.toThrow();
  });

  it('the clickwrap shows only link policies', () => {
    const c = new PolicyAcceptanceController([policy('tos'), policy('cookies', { display: 'link' })]);
    const host = document.createElement('p');
    document.body.append(host);
    const off = mountClickwrap(host, c, { strings: { 'policy.clickwrap': 'Continuing means you accept {policies}.' } });
    expect(host.textContent).toBe('Continuing means you accept COOKIES.');
    off();
  });
});

describe('mountAcceptStep', () => {
  it('enables Accept and continue once ticked and submits the acceptances', () => {
    const c = new PolicyAcceptanceController([policy('tos')]);
    const host = document.createElement('div');
    document.body.append(host);
    const onSubmit = vi.fn();
    const step = mountAcceptStep(host, c, { onSubmit });
    const button = host.querySelector<HTMLButtonElement>('[data-atlas-policy-continue]')!;
    expect(button.disabled).toBe(true);
    const box = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(button.disabled).toBe(false);
    button.click();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ policy: 'tos', version_id: 'polv_tos', content_sha256: 'sha_tos', display: 'checkbox' }),
    ]);
    step.setBusy(true);
    expect(button.disabled).toBe(true);
    step.destroy();
    expect(host.childElementCount).toBe(0);
  });
});

describe('mountPolicyGate', () => {
  const meJson = { data: [{ policy: 'tos', title: 'Terms', needs_reaccept: true, grace_ends_at: 1792800000000 }, { policy: 'privacy', needs_reaccept: false }] };

  it('shows the banner for stale policies, re-accepts and disappears', async () => {
    let stale = true;
    const { fetchImpl, calls } = fakeApi({
      'GET /v1/client/me/policies': () => ({ body: stale ? meJson : { data: [{ policy: 'tos', title: 'Terms', needs_reaccept: false }] } }),
      'GET /v1/client/policies': () => ({ body: POLICIES }),
      'POST /v1/client/me/policies/accept': () => {
        stale = false;
        return { body: {} };
      },
    });
    const client = createPolicyClient({ publishableKey: 'pk_test', frontendApi: BASE });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const host = document.createElement('div');
      document.body.append(host);
      const onAccepted = vi.fn();
      const gate = mountPolicyGate(host, { client, onAccepted });
      await gate.ready;
      expect(host.querySelector('[data-atlas-policy-banner]')).not.toBeNull();
      expect(host.textContent).toContain('We have updated: Terms. Please review and accept.');
      expect(host.textContent).toContain('Accept by 2026-10-24 to keep your access.');

      host.querySelector<HTMLButtonElement>('[data-atlas-policy-banner] button')!.click();
      await vi.waitFor(() => expect(host.querySelector('[data-atlas-policy-continue]')).not.toBeNull());
      const box = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      host.querySelector<HTMLButtonElement>('[data-atlas-policy-continue]')!.click();
      await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());

      const accept = calls.find((c) => c.path === '/v1/client/me/policies/accept')!;
      expect(accept.body.policy_acceptances[0]).toMatchObject({ policy: 'tos', version_id: 'polv_1' });
      expect(host.querySelector('[data-atlas-policy-banner]')).toBeNull();
      gate.destroy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('draws nothing when nothing needs accepting', async () => {
    const { fetchImpl } = fakeApi({ 'GET /v1/client/me/policies': () => ({ body: { data: [{ policy: 'tos', needs_reaccept: false }] } }) });
    const client = createPolicyClient({ publishableKey: 'pk_test', frontendApi: BASE });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const host = document.createElement('div');
      document.body.append(host);
      const gate = mountPolicyGate(host, { client });
      await gate.ready;
      expect(host.querySelector('[data-atlas-policy-banner]')).toBeNull();
      gate.destroy();
    } finally {
      globalThis.fetch = original;
    }
  });
});
