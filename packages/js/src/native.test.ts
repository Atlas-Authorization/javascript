import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadGoogleIdentityServices,
  nativeSignInBody,
  parseNativeSignInResponse,
  renderGoogleButton,
  requestGoogleCredential,
  resetGoogleIdentityServices,
} from './native';

afterEach(() => resetGoogleIdentityServices());

describe('nativeSignInBody', () => {
  it('includes the nonce only when present', () => {
    expect(nativeSignInBody({ provider: 'google', idToken: 't' })).toEqual({
      provider: 'google',
      id_token: 't',
    });
    expect(nativeSignInBody({ provider: 'google', idToken: 't', nonce: 'n' })).toEqual({
      provider: 'google',
      id_token: 't',
      nonce: 'n',
    });
  });
});

describe('parseNativeSignInResponse', () => {
  it('parses a completed sign-in with a ticket', () => {
    expect(parseNativeSignInResponse({ object: 'sign_in_attempt', id: 'a1', status: 'complete', ticket: 'tk' })).toEqual({
      attemptId: 'a1',
      status: 'complete',
      ticket: 'tk',
    });
  });

  it('parses a step-remaining response with no ticket', () => {
    expect(parseNativeSignInResponse({ id: 'a1', status: 'needs_second_factor' })).toEqual({
      attemptId: 'a1',
      status: 'needs_second_factor',
    });
  });

  it('returns null for malformed bodies', () => {
    expect(parseNativeSignInResponse(null)).toBeNull();
    expect(parseNativeSignInResponse({ status: 'complete' })).toBeNull();
    expect(parseNativeSignInResponse({ id: 'a1' })).toBeNull();
  });
});

/** A fake document that records the injected GSI script and fires load. */
function fakeDoc(withExisting = false) {
  const head = { appendChild: vi.fn((s: { dispatch?: (t: string) => void }) => s.dispatch?.('load')) };
  return {
    querySelector: vi.fn(() => (withExisting ? {} : null)),
    createElement: vi.fn(() => {
      const listeners: Record<string, () => void> = {};
      return {
        set src(_v: string) {},
        async: false,
        defer: false,
        addEventListener: (t: string, cb: () => void) => (listeners[t] = cb),
        dispatch: (t: string) => listeners[t]?.(),
      };
    }),
    head,
  } as unknown as Document;
}

describe('loadGoogleIdentityServices', () => {
  it('injects the GSI script and resolves on load', async () => {
    const doc = fakeDoc();
    await expect(loadGoogleIdentityServices(doc)).resolves.toBeUndefined();
    expect((doc.head.appendChild as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('does not re-inject when the script is already present', async () => {
    const doc = fakeDoc(true);
    await expect(loadGoogleIdentityServices(doc)).resolves.toBeUndefined();
    expect((doc.head.appendChild as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('requestGoogleCredential', () => {
  const host = (impl: (cfg: { callback: (r: { credential?: string }) => void }) => void) =>
    ({
      document: fakeDoc(true),
      google: {
        accounts: {
          id: {
            initialize: (cfg: { callback: (r: { credential?: string }) => void }) => impl(cfg),
            prompt: () => {},
            renderButton: () => {},
            cancel: () => {},
          },
        },
      },
    }) as unknown as Parameters<typeof requestGoogleCredential>[0]['host'];

  it('resolves the credential id_token from the GSI callback', async () => {
    const h = host((cfg) => cfg.callback({ credential: 'the-id-token' }));
    await expect(requestGoogleCredential({ clientId: 'c', host: h })).resolves.toBe('the-id-token');
  });

  it('rejects when GSI returns no credential', async () => {
    const h = host((cfg) => cfg.callback({}));
    await expect(requestGoogleCredential({ clientId: 'c', host: h })).rejects.toThrow(/no credential/i);
  });

  it('rejects when GSI is unavailable', async () => {
    const h = { document: fakeDoc(true) } as unknown as Parameters<typeof requestGoogleCredential>[0]['host'];
    await expect(requestGoogleCredential({ clientId: 'c', host: h })).rejects.toThrow(/unavailable/i);
  });
});

describe('renderGoogleButton', () => {
  const buttonHost = () => {
    const state: {
      cb: ((r: { credential?: string }) => void) | null;
      rendered: boolean;
      prompted: boolean;
    } = { cb: null, rendered: false, prompted: false };
    const host = {
      document: fakeDoc(true),
      google: {
        accounts: {
          id: {
            initialize: (cfg: { callback: (r: { credential?: string }) => void }) => {
              state.cb = cfg.callback;
            },
            prompt: () => {
              state.prompted = true;
            },
            renderButton: () => {
              state.rendered = true;
            },
            cancel: () => {},
          },
        },
      },
    } as unknown as Parameters<typeof renderGoogleButton>[0]['host'];
    return { host, state };
  };

  it('renders the button and forwards each credential to onCredential', async () => {
    const { host, state } = buttonHost();
    const creds: string[] = [];
    await renderGoogleButton({
      parent: {} as unknown as HTMLElement,
      clientId: 'c',
      onCredential: (t) => creds.push(t),
      host,
    });
    expect(state.rendered).toBe(true);
    // A button can be clicked repeatedly — the callback fires each time.
    state.cb?.({ credential: 'tok-1' });
    state.cb?.({ credential: 'tok-2' });
    expect(creds).toEqual(['tok-1', 'tok-2']);
  });

  it('shows the One-Tap prompt only when oneTap is set', async () => {
    const a = buttonHost();
    await renderGoogleButton({
      parent: {} as unknown as HTMLElement,
      clientId: 'c',
      onCredential: () => {},
      host: a.host,
    });
    expect(a.state.prompted).toBe(false);

    const b = buttonHost();
    await renderGoogleButton({
      parent: {} as unknown as HTMLElement,
      clientId: 'c',
      onCredential: () => {},
      oneTap: true,
      host: b.host,
    });
    expect(b.state.prompted).toBe(true);
  });

  it('reports an empty credential via onError, not onCredential', async () => {
    const { host, state } = buttonHost();
    let errored = false;
    const creds: string[] = [];
    await renderGoogleButton({
      parent: {} as unknown as HTMLElement,
      clientId: 'c',
      onCredential: (t) => creds.push(t),
      onError: () => {
        errored = true;
      },
      host,
    });
    state.cb?.({});
    expect(errored).toBe(true);
    expect(creds).toEqual([]);
  });
});
