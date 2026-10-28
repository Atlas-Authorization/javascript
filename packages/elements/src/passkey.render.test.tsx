import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Passkey from './passkey';

afterEach(() => cleanup());

const buf = (a: number[]) => new Uint8Array(a).buffer;
const endpoints = { registrationInit: '/r/i', registrationFinalize: '/r/f', loginInit: '/l/i', loginFinalize: '/l/f' };
const host = {
  credentials: {
    create: vi.fn(async () => ({ rawId: buf([9]), id: 'CQ', response: { attestationObject: buf([1]), clientDataJSON: buf([2]) } }) as unknown as Credential),
    get: vi.fn(async () => null),
  },
};
const fetchOk = (fail = false) =>
  (async (url: string) => {
    if (fail && url === endpoints.registrationInit) return new Response(JSON.stringify({ error: { message: 'Not signed in.' } }), { status: 401 });
    if (url === endpoints.registrationInit) return new Response(JSON.stringify({ options: { challenge: 'Y2g', rp: { id: 'a.test', name: 'A' }, user: { id: 'dTE', name: 'u', displayName: 'U' }, pubKeyCredParams: [] } }));
    return new Response(JSON.stringify({ id: 'pk_1' }));
  }) as unknown as typeof fetch;

describe('<Passkey.*> (external user store)', () => {
  it('registers through the backend endpoints and reports success', async () => {
    const onSuccess = vi.fn();
    render(
      <Passkey.Root endpoints={endpoints} fetch={fetchOk()} host={host} onSuccess={onSuccess}>
        <Passkey.Register>Add a passkey</Passkey.Register>
        <Passkey.Error />
      </Passkey.Root>,
    );
    fireEvent.click(screen.getByText('Add a passkey'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: 'pk_1' }, 'register'), { timeout: 5000 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the backend error and calls onError', async () => {
    const onError = vi.fn();
    render(
      <Passkey.Root endpoints={endpoints} fetch={fetchOk(true)} host={host} onError={onError}>
        <Passkey.Register>Add</Passkey.Register>
        <Passkey.Error />
      </Passkey.Root>,
    );
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not signed in.'), { timeout: 5000 });
    expect(onError).toHaveBeenCalled();
  });

  it('parts outside a Root fail loudly, and asChild merges onto the child', () => {
    expect(() => render(<Passkey.Register>x</Passkey.Register>)).toThrow('inside <Passkey.Root>');
    cleanup();
    render(
      <Passkey.Root endpoints={endpoints} host={host}>
        <Passkey.Login asChild>
          <a href="#x">Sign in</a>
        </Passkey.Login>
      </Passkey.Root>,
    );
    expect(screen.getByText('Sign in').tagName).toBe('A');
  });
});
