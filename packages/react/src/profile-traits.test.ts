// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { ProfileTraits } from './profile-traits';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<ProfileTraits/>` renders `GET /v1/client/profile_schema` and saves the user's own edits as `traits`. */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SCHEMA = {
  object: 'profile_schema',
  groups: [{ key: 'work', label: 'Arbeit' }],
  fields: [
    { key: 'company', type: 'string', label: 'Firma', description: null, group: 'work', required: true, editable: true },
    { key: 'birthday', type: 'date', label: 'Geburtstag', description: null, group: null, required: false, editable: true },
    { key: 'tier', type: 'enum', label: 'Stufe', description: null, group: null, required: false, editable: false, enum: ['a', 'b'] },
  ],
  values: { company: 'Acme', tier: 'a' },
};

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mount(onPatch: (body: unknown) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init.method ?? 'GET', body });
      if (url.endsWith('/v1/client')) return json({ session: { id: 'sess_1', status: 'active' }, user: { id: 'user_1' }, jwt: JWT });
      if (url.includes('/v1/client/profile_schema')) return json(SCHEMA);
      if (url.endsWith('/v1/client/me') && init.method === 'PATCH') return onPatch(body);
      return json({});
    }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        fetchImpl,
        appearance: { instanceDesign: false },
        children: createElement(ProfileTraits, { locale: 'de-DE' }),
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  unmount = () => root.unmount();
  return { el, calls };
}

describe('<ProfileTraits/>', () => {
  it('renders the schema by section, with required marked and a read-only field disabled', async () => {
    const { el, calls } = await mount(() => json({}));
    expect(calls.some((c) => c.url.includes('/v1/client/profile_schema?locale=de-DE'))).toBe(true);
    expect(el.querySelector('legend')?.textContent).toBe('Arbeit');
    expect(el.textContent).toContain('Firma *');
    expect((el.querySelector('#atlas_trait_company') as HTMLInputElement).value).toBe('Acme');
    expect((el.querySelector('#atlas_trait_tier') as HTMLSelectElement).disabled).toBe(true);
    expect((el.querySelector('#atlas_trait_birthday') as HTMLInputElement).type).toBe('date');
  });

  it('sends only what the user changed, as traits', async () => {
    const { el, calls } = await mount(() => json({ object: 'user' }));
    const input = el.querySelector('#atlas_trait_company') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Globex');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ traits: { company: 'Globex' } });
  });

  it('shows a refused value under its field', async () => {
    const { el } = await mount(() => json({ errors: [{ code: 'VALIDATION_FAILED', message: 'bad', param: 'traits.company' }] }, 400));
    const input = el.querySelector('#atlas_trait_company') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'X');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('bad');
  });
});
