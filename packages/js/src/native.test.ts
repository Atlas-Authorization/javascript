import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnoseProvider,
  loadGoogleIdentityServices,
  nativeSignInBody,
  parseNativeSignInResponse,
  renderGoogleButton,
  renderGoogleOverlayButton,
  reportProviderUnavailable,
  requestGoogleCredential,
  resetGoogleCredentialFlag,
  resetGoogleIdentityServices,
} from './native';
import { FapiClient } from './fapi';

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

describe('§4.5 renderGoogleOverlayButton visible mode', () => {
  /**
   * A fake host whose GSI script already exists (so no <script> is injected) and
   * whose overlay <div> records the attributes + cssText the function sets, plus a
   * wrapper with a measurable width. Pure enough to assert the invisible-overlay vs
   * visible-button decision without a DOM.
   */
  function overlayHarness() {
    const attrs: Record<string, string> = {};
    const overlay = {
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      style: { cssText: '' },
      replaceChildren: () => {},
      remove: () => {},
      // stretchToFill (overlay stretch) + dev self-verify reach for these; a pure
      // stub returns nothing to stretch and a covering rect.
      querySelector: () => null,
      firstElementChild: null,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40 }),
    };
    const renders: Array<Record<string, unknown>> = [];
    const wrapper = {
      style: { position: '' },
      appendChild: () => {},
      getBoundingClientRect: () => ({ width: 300 }),
    } as unknown as HTMLElement;
    const host = {
      document: {
        // Truthy → script already present, so loadGoogleIdentityServices resolves
        // without creating a <script>; createElement is only hit for the overlay.
        querySelector: () => ({}),
        createElement: () => overlay,
        head: { appendChild: () => {} },
      },
      google: {
        accounts: {
          id: {
            initialize: () => {},
            renderButton: (_parent: unknown, options: Record<string, unknown>) => {
              renders.push(options);
            },
            prompt: () => {},
            cancel: () => {},
          },
        },
      },
    } as unknown as Parameters<typeof renderGoogleOverlayButton>[0]['host'];
    return { host, wrapper, overlay, attrs, renders };
  }

  // Each render registers a module-level mounted overlay; destroy to deregister so
  // it doesn't leak into diagnoseProvider's "no overlay mounted" expectation.
  const handles: Array<{ destroy: () => void }> = [];
  afterEach(() => handles.splice(0).forEach((h) => h.destroy()));

  it('defaults to a NEAR-zero (not exactly 0) invisible overlay + aria-hidden', async () => {
    const h = overlayHarness();
    handles.push(
      await renderGoogleOverlayButton({
        wrapper: h.wrapper,
        clientId: 'c',
        onCredential: () => {},
        host: h.host,
      }),
    );
    expect(h.attrs['aria-hidden']).toBe('true');
    // A tiny non-zero opacity: invisible to the user, but GSI's visibility check does
    // NOT see exactly-0 (which it silently refuses), so the click still reaches it.
    expect(h.overlay.style.cssText).toContain('opacity:0.004');
    expect(h.overlay.style.cssText).not.toContain('opacity:0;');
    expect(h.overlay.style.cssText).not.toContain('opacity:1');
  });

  it("visible:true renders Google's own button opaque and NOT aria-hidden", async () => {
    const h = overlayHarness();
    handles.push(
      await renderGoogleOverlayButton({
        wrapper: h.wrapper,
        clientId: 'c',
        onCredential: () => {},
        visible: true,
        host: h.host,
      }),
    );
    expect(h.attrs['aria-hidden']).toBeUndefined();
    expect(h.overlay.style.cssText).toContain('opacity:1');
  });

  it('keeps the stretch-to-fill in both modes (GSI width tracks the wrapper)', async () => {
    const h = overlayHarness();
    handles.push(
      await renderGoogleOverlayButton({
        wrapper: h.wrapper,
        clientId: 'c',
        onCredential: () => {},
        visible: true,
        host: h.host,
      }),
    );
    // Wrapper measured 300 → GSI button rendered at width 300 (within GSI's 200–400).
    expect(h.renders[0]?.width).toBe(300);
  });

  it('stretches the iframe GSI injects ASYNCHRONOUSLY (via a MutationObserver), not just the container', async () => {
    // GSI adds its <iframe> after renderButton() returns, so the synchronous stretch
    // can't see it. Model that: querySelector('iframe') is null at render, then a
    // fixed-px iframe appears and the observer re-stretches it.
    const iframe = { style: { width: '420px', height: '44px' } };
    let present = false;
    const container = { style: { width: '', height: '' } };
    const overlay = {
      setAttribute: () => {},
      style: { cssText: '' },
      replaceChildren: () => {},
      remove: () => {},
      firstElementChild: container,
      querySelector: (sel: string) => (sel === 'iframe' && present ? iframe : null),
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40 }),
    };
    let moCallback: (() => void) | undefined;
    const FakeMO = class {
      constructor(cb: () => void) {
        moCallback = cb;
      }
      observe() {}
      disconnect() {}
    };
    const wrapper = {
      style: { position: '' },
      appendChild: () => {},
      getBoundingClientRect: () => ({ width: 300 }),
    } as unknown as HTMLElement;
    const host = {
      document: { querySelector: () => ({}), createElement: () => overlay, head: { appendChild: () => {} } },
      google: { accounts: { id: { initialize: () => {}, renderButton: () => {}, prompt: () => {}, cancel: () => {} } } },
      MutationObserver: FakeMO as unknown as typeof MutationObserver,
    } as unknown as Parameters<typeof renderGoogleOverlayButton>[0]['host'];

    const handle = await renderGoogleOverlayButton({ wrapper, clientId: 'c', onCredential: () => {}, host });
    // Container stretched synchronously; iframe not present yet, so untouched.
    expect(container.style.width).toBe('100%');
    expect(iframe.style.width).toBe('420px');
    // GSI injects the iframe → the observer fires → it gets stretched to fill.
    present = true;
    moCallback?.();
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('100%');
    handle.destroy();
  });
});

describe('reportProviderUnavailable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a no-op under SSR (no window/navigator) and does not touch the transport', () => {
    // The default vitest env is node — window and navigator are undefined here.
    const fetchImpl = vi.fn();
    const client = new FapiClient({
      publishableKey: 'pk_test_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(() => reportProviderUnavailable(client, 'google', 'not_rendered')).not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the beacon with the pk header, keepalive, and {provider, reason}', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, init };
      // The real endpoint answers 204 No Content — no JSON body.
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = new FapiClient({
      publishableKey: 'pk_test_1',
      baseUrl: 'https://accounts.acme.com',
      fetchImpl,
    });

    reportProviderUnavailable(client, 'google', 'script_blocked');
    await Promise.resolve(); // let the fire-and-forget request settle

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured!.url).toBe('https://accounts.acme.com/v1/client/telemetry/provider_unavailable');
    const init = captured!.init as RequestInit & { keepalive?: boolean };
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)['x-publishable-key']).toBe('pk_test_1');
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'google', reason: 'script_blocked' });
  });

  it('never throws when the transport rejects', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const client = new FapiClient({ publishableKey: 'pk_test_1', fetchImpl });
    expect(() => reportProviderUnavailable(client, 'google', 'not_rendered')).not.toThrow();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('diagnoseProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGoogleCredentialFlag();
  });

  const envClient = (providers: unknown[]) => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ social_providers: providers }), { status: 200 }),
    ) as unknown as typeof fetch;
    return new FapiClient({ publishableKey: 'pk_test_1', baseUrl: 'https://accounts.acme.com', fetchImpl });
  };

  it('is SSR-safe: no window → null origin/overlay, and it never throws', async () => {
    // Default vitest env is node — window is undefined here. A rejecting transport
    // exercises the never-throw path too.
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const client = new FapiClient({ publishableKey: 'pk_test_1', fetchImpl });
    const out = await diagnoseProvider(client, 'google');
    expect(out).toEqual({
      provider: 'google',
      mode: null,
      clientId: null,
      native: false,
      origin: null,
      overlay: null,
      credentialMintedThisSession: false,
    });
  });

  it('reports the resolved native mode, client_id and current origin', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.acme.com' } });
    const client = envClient([
      { provider: 'google', native: true, client_id: 'gcid.apps.googleusercontent.com' },
    ]);
    const out = await diagnoseProvider(client, 'google');
    expect(out.mode).toBe('native'); // absent mode + native ⇒ resolved native
    expect(out.clientId).toBe('gcid.apps.googleusercontent.com');
    expect(out.native).toBe(true);
    expect(out.origin).toBe('https://app.acme.com');
    expect(out.overlay).toBeNull(); // no button mounted in this test
  });

  it('reports mode:"redirect" when the server pinned the provider to redirect', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.acme.com' } });
    const client = envClient([
      { provider: 'google', native: true, client_id: 'gcid', mode: 'redirect' },
    ]);
    const out = await diagnoseProvider(client, 'google');
    expect(out.mode).toBe('redirect');
  });

  it('returns null server fields for a provider not in the environment', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.acme.com' } });
    const client = envClient([{ provider: 'github', native: true, client_id: 'x' }]);
    const out = await diagnoseProvider(client, 'google');
    expect(out).toMatchObject({ mode: null, clientId: null, native: false });
  });
});
