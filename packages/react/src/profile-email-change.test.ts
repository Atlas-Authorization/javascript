// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { ProfileCard } from './account';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Secure email change in `<ProfileCard/>`: "Make primary" on a verified address;
 * when the application asks for old-address confirmation the card asks for the
 * code mailed to the current primary address and finishes with confirm_primary.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(primaryAnswer: { status: number; body: unknown }) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === '/v1/client') {
      return json({
        session: { id: 'sess_1', status: 'active' },
        user: {
          id: 'user_1',
          first_name: 'Ada',
          last_name: null,
          email_addresses: [
            { id: 'em_old', email_address: 'old@example.com', verified: true, primary: true },
            { id: 'em_new', email_address: 'new@example.com', verified: true, primary: false },
          ],
        },
      });
    }
    if (url.pathname.endsWith('/em_new/primary')) return json(primaryAnswer.body, primaryAnswer.status);
    return json({ object: 'email_address', id: 'em_new', primary: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(createElement(AtlasProvider, { publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', fetchImpl, appearance: { instanceDesign: false }, children: createElement(ProfileCard) }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  unmount = () => act(() => root.unmount());
  return { el, calls };
}

const button = (el: HTMLElement, label: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${el.innerHTML}`);
  return found;
};
const click = (target: HTMLElement) => act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

describe('<ProfileCard/> secure email change', () => {
  it('asks for the old-address code on a pending answer, then confirms', async () => {
    const { el, calls } = await mount({ status: 202, body: { object: 'email_address', id: 'em_new', primary: false, status: 'pending_old_address_confirmation' } });
    expect(el.textContent).not.toContain('Make primary old@example.com');
    await click(button(el, 'Make primary'));
    expect(calls.some((c) => c.path.endsWith('/em_new/primary') && c.method === 'POST')).toBe(true);
    const input = el.querySelector('[data-atlas="email-primary-confirm"] input') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(el, 'Confirm'));
    const confirm = calls.find((c) => c.path.endsWith('/em_new/confirm_primary'));
    expect(confirm?.method).toBe('POST');
    expect(confirm?.body).toEqual({ code: '123456' });
  });

  it('without old-address confirmation the switch is immediate (no code step)', async () => {
    const { el, calls } = await mount({ status: 200, body: { object: 'email_address', id: 'em_new', primary: true } });
    await click(button(el, 'Make primary'));
    expect(el.querySelector('[data-atlas="email-primary-confirm"]')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/confirm_primary'))).toBe(false);
  });
});
