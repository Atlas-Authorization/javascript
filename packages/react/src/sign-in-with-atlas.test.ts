import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atlasIdLabels,
  buildAtlasAuthorizeUrl,
  completeSignInWithAtlas,
  listenAtlasIdEvents,
  oneTapWithAtlas,
  signInWithAtlasPopup,
  SignInWithAtlasButton,
} from './sign-in-with-atlas';
import { AtlasSsoButton, atlasSsoTarget } from './flow';

const store = new Map<string, string>();
const assign = vi.fn();
beforeEach(() => {
  store.clear();
  assign.mockReset();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', {
    location: { href: 'https://site.test/page', origin: 'https://site.test', assign },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const opts = { clientId: 'cid', redirectUri: 'https://site.test/cb' };
const b64u = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

async function start() {
  const url = new URL(await buildAtlasAuthorizeUrl(opts));
  const state = url.searchParams.get('state')!;
  return { url, state, saved: JSON.parse(store.get(`atlasid:${state}`)!) };
}

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const ISS = 'https://atlasauth.net';
/** Claims a valid id_token for `saved` carries. */
const good = (saved: { nonce: string }, extra: object = {}) => ({ sub: 'u1', nonce: saved.nonce, iss: ISS, aud: 'cid', ...extra });

/** A started transaction plus a token endpoint answering with `body`. */
async function exchange(body: (saved: { nonce: string }) => unknown, init: { ok?: boolean; raw?: string } = {}) {
  const { state, saved } = await start();
  const fetch = vi.fn(async () =>
    init.raw !== undefined
      ? new Response(init.raw, { status: init.ok === false ? 400 : 200 })
      : Response.json(body(saved), { status: init.ok === false ? 400 : 200 }),
  );
  const run = () =>
    completeSignInWithAtlas({
      url: `https://site.test/cb?code=abc&state=${state}`,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
  return { state, saved, fetch, run };
}

describe('buildAtlasAuthorizeUrl', () => {
  it('builds the authorize URL and a matching S256 challenge', async () => {
    const { url, saved } = await start();
    expect(url.origin + url.pathname).toBe('https://atlasauth.net/oauth2/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('redirect_uri')).toBe(opts.redirectUri);
    expect(p.get('scope')).toBe('openid profile email');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('nonce')).toBe(saved.nonce);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.verifier));
    expect(p.get('code_challenge')).toBe(b64u(digest));
    expect(saved).toMatchObject({
      state: p.get('state'),
      redirectUri: opts.redirectUri,
      clientId: 'cid',
      issuer: 'https://atlasauth.net',
    });
  });
});

describe('completeSignInWithAtlas', () => {
  it('rejects state_mismatch without fetching', async () => {
    const fetch = vi.fn();
    await expect(
      completeSignInWithAtlas({ url: 'https://site.test/cb?code=c&state=nope', fetch }),
    ).rejects.toThrow('state_mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects error= with an unknown state and makes no fetch', async () => {
    const fetch = vi.fn();
    await expect(
      completeSignInWithAtlas({ url: 'https://site.test/cb?error=access_denied&state=nope', fetch }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a corrupt stored entry as state_mismatch', async () => {
    store.set('atlasid:bad', '{not json');
    const fetch = vi.fn();
    await expect(
      completeSignInWithAtlas({ url: 'https://site.test/cb?code=c&state=bad', fetch }),
    ).rejects.toThrow('state_mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an undecodable id_token as invalid_id_token', async () => {
    const { state } = await start();
    const fetch = vi.fn(async () =>
      Response.json({ id_token: 'a.%%%.c', access_token: 'at', expires_in: 1 }),
    );
    await expect(
      completeSignInWithAtlas({
        url: `https://site.test/cb?code=abc&state=${state}`,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('invalid_id_token');
  });

  it('rejects with the callback error_description', async () => {
    const { state } = await start();
    await expect(
      completeSignInWithAtlas({
        url: `https://site.test/cb?error=access_denied&error_description=User%20said%20no&state=${state}`,
        fetch: vi.fn(),
      }),
    ).rejects.toThrow('User said no');
  });

  it('exchanges the code and returns claims', async () => {
    const { state, saved } = await start();
    const fetch = vi.fn(async () =>
      Response.json({
        id_token: jwt(good(saved)),
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
      }),
    );
    const r = await completeSignInWithAtlas({
      url: `https://site.test/cb?code=abc&state=${state}`,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const [u, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(u).toBe('https://atlasauth.net/oauth2/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: opts.redirectUri,
      client_id: 'cid',
      code_verifier: saved.verifier,
    });
    expect(r).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
    expect(r.claims.sub).toBe('u1');
    expect(store.has(`atlasid:${state}`)).toBe(false);
  });

  it('rejects nonce_mismatch', async () => {
    const { state } = await start();
    const fetch = vi.fn(async () =>
      Response.json({ id_token: jwt({ nonce: 'other', iss: ISS, aud: 'cid' }), access_token: 'at', expires_in: 1 }),
    );
    await expect(
      completeSignInWithAtlas({
        url: `https://site.test/cb?code=abc&state=${state}`,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('nonce_mismatch');
  });

  it('rejects invalid_id_token on the wrong issuer or audience', async () => {
    for (const extra of [{ iss: 'https://evil.test' }, { aud: 'other' }, { aud: ['other'] }, { iss: undefined }]) {
      const { run } = await exchange((saved) => ({ id_token: jwt(good(saved, extra)), access_token: 'at' }));
      await expect(run(), JSON.stringify(extra)).rejects.toThrow('invalid_id_token');
    }
  });

  it('accepts an aud array that contains the client id', async () => {
    const { run } = await exchange((saved) => ({ id_token: jwt(good(saved, { aud: ['x', 'cid'] })), access_token: 'at' }));
    await expect(run()).resolves.toMatchObject({ accessToken: 'at' });
  });

  it.each([
    ['{}'],
    ['null'],
    ['"str"'],
    ['[]'],
    [JSON.stringify({ nonce: 'n', verifier: '', redirectUri: 'r', clientId: 'c', issuer: 'i' })],
    [JSON.stringify({ nonce: 'n', verifier: 'v', redirectUri: 'r', clientId: 7, issuer: 'i' })],
    [JSON.stringify({ verifier: 'v', redirectUri: 'r', clientId: 'c', issuer: 'i' })],
  ])('treats a malformed stored entry %s as state_mismatch, removes it, and never fetches', async (stored) => {
    store.set('atlasid:S1', stored);
    const fetch = vi.fn();
    await expect(
      completeSignInWithAtlas({ url: 'https://site.test/cb?code=c&state=S1', fetch }),
    ).rejects.toThrow('state_mismatch');
    expect(fetch).not.toHaveBeenCalled();
    expect(store.has('atlasid:S1')).toBe(false);
  });

  it('removes the stored entry on every path after it is read (one-shot)', async () => {
    const { state, fetch, run } = await exchange(() => ({}));
    fetch.mockRejectedValueOnce(new Error('network'));
    await expect(run()).rejects.toThrow('network');
    expect(store.has(`atlasid:${state}`)).toBe(false);

    const again = await start();
    await expect(
      completeSignInWithAtlas({ url: `https://site.test/cb?state=${again.state}`, fetch: vi.fn() }),
    ).rejects.toThrow('missing_code');
    expect(store.has(`atlasid:${again.state}`)).toBe(false);
  });

  it('checks error= before state, like the hosted script, and leaves storage alone', async () => {
    const { state } = await start();
    await expect(
      completeSignInWithAtlas({ url: `https://site.test/cb?error=access_denied&state=${state}`, fetch: vi.fn() }),
    ).rejects.toThrow('access_denied');
    expect(store.has(`atlasid:${state}`)).toBe(true);
  });

  it('an unparseable token response is token_exchange_failed', async () => {
    await expect((await exchange(() => null, { raw: '<html>' })).run()).rejects.toThrow('token_exchange_failed');
    await expect((await exchange(() => null, { raw: '<html>', ok: false })).run()).rejects.toThrow('token_exchange_failed');
  });

  it('surfaces the token endpoint error', async () => {
    const { run } = await exchange(() => ({ error: 'invalid_grant', error_description: 'bad code' }), { ok: false });
    await expect(run()).rejects.toThrow('bad code');
  });

  it('a response without id_token or access_token is token_exchange_failed', async () => {
    await expect((await exchange(() => ({ access_token: 'at' }))).run()).rejects.toThrow('token_exchange_failed');
    await expect((await exchange((saved) => ({ id_token: jwt(good(saved)) }))).run()).rejects.toThrow('token_exchange_failed');
  });

  it('rejects an id_token with no payload, or a non-object payload, as invalid_id_token', async () => {
    await expect((await exchange(() => ({ id_token: 'nodots', access_token: 'at' }))).run()).rejects.toThrow('invalid_id_token');
    await expect((await exchange(() => ({ id_token: jwt(null as unknown as object), access_token: 'at' }))).run()).rejects.toThrow('invalid_id_token');
  });

  it('blocked storage rejects state_mismatch rather than throwing a SecurityError', async () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const fetch = vi.fn();
    await expect(
      completeSignInWithAtlas({ url: 'https://site.test/cb?code=c&state=S1', fetch }),
    ).rejects.toThrow('state_mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an unparseable callback URL is invalid_url', async () => {
    await expect(completeSignInWithAtlas({ url: 'not a url', fetch: vi.fn() })).rejects.toThrow('invalid_url');
  });
});

describe('SignInWithAtlasButton', () => {
  it('renders without a provider, with the right label', () => {
    const html = renderToString(createElement(SignInWithAtlasButton, { ...opts, text: 'continue' }));
    expect(html).toContain('Continue with Atlas');
    expect(renderToString(createElement(SignInWithAtlasButton, opts))).toContain(
      'Sign in with Atlas',
    );
    expect(
      renderToString(createElement(SignInWithAtlasButton, { ...opts, text: 'signup' })),
    ).toContain('Sign up with Atlas');
  });
});

type ButtonProps = Parameters<typeof SignInWithAtlasButton>[0];
/** The rendered <button> element, so its onClick can be driven without a DOM. */
const button = (props: ButtonProps) =>
  SignInWithAtlasButton(props) as unknown as { props: { onClick: () => void; style: Record<string, unknown> } };

describe('SignInWithAtlasButton look (parity with the hosted script)', () => {
  it('uses the script button colours, weight and Atlas mark', () => {
    const html = renderToString(createElement(SignInWithAtlasButton, opts));
    expect(html).toContain('M12 2 3 21h4l5-11 5 11h4L12 2z');
    const dark = button(opts).props.style;
    // The script's colours, behind the host page's --atlas-host-* variables.
    expect(dark).toMatchObject({ background: 'var(--atlas-host-accent, #0f1117)', color: 'var(--atlas-host-accent-ink, #fff)', borderColor: 'var(--atlas-host-accent, #0f1117)', height: 44, borderRadius: 6 });
    expect(String(dark.font)).toMatch(/^600 15px\/1 /);
    expect(button({ ...opts, theme: 'light' }).props.style).toMatchObject({ background: 'var(--atlas-host-surface, #fff)', color: 'var(--atlas-host-ink, #0f1117)', borderColor: 'var(--atlas-host-line, #dadce0)' });
    expect(button({ ...opts, size: 'small', shape: 'pill' }).props.style).toMatchObject({ height: 32, borderRadius: 999 });
  });
});

describe('SignInWithAtlasButton clicks', () => {
  it('browser mode: starts PKCE and navigates to the authorize URL', async () => {
    button(opts).props.onClick();
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(String(assign.mock.calls[0]![0])).toMatch(/^https:\/\/atlasauth\.net\/oauth2\/authorize\?/);
    expect(store.size).toBe(1);
  });

  it('browser mode without clientId reports an error and does not navigate', async () => {
    const onError = vi.fn();
    button({ redirectUri: 'https://site.test/cb', onError } as unknown as ButtonProps).props.onClick();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect((onError.mock.calls[0]![0] as Error).message).toBe('clientId is required');
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ['/auth/atlas/login', 'https://site.test/auth/atlas/login'],
    ['/auth/login?x=1', 'https://site.test/auth/login?x=1'],
    ['https://app.example/login', 'https://app.example/login'],
    ['https://site.test/auth', 'https://site.test/auth'],
  ])('loginUri %s navigates to the normalized %s with no PKCE or storage', (loginUri, href) => {
    button({ loginUri }).props.onClick();
    expect(assign.mock.calls).toEqual([[href]]);
    expect(store.size).toBe(0);
  });

  it.each([
    ['javascript:alert(1)'], ['http://evil.test/x'], ['//evil.test/x'], ['/\\evil.test'], ['relative/path'], [''],
    ['/\t/evil.test'], ['/\n/evil.test'], ['/\r/evil.test'], [' /x'], ['/x '], ['https://a.test/\n'],
  ])('refuses loginUri %j', (loginUri) => {
    const onError = vi.fn();
    button({ loginUri, clientId: 'cid', redirectUri: 'https://site.test/cb', onError }).props.onClick();
    expect(assign).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a refused loginUri without onError logs instead of throwing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => button({ loginUri: 'http://evil.test' }).props.onClick()).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('loginUri mode type-checks without clientId/redirectUri', () => {
    expect(renderToString(createElement(SignInWithAtlasButton, { loginUri: '/auth/atlas/login' }))).toContain('Sign in with Atlas');
  });
});

describe('prebuilt sign-in Atlas button', () => {
  it('Space activates without scrolling the page', () => {
    const onClick = vi.fn();
    const el = AtlasSsoButton({ onClick }) as unknown as { props: { onKeyDown: (e: { key: string; preventDefault: () => void }) => void } };
    const preventDefault = vi.fn();
    el.props.onKeyDown({ key: ' ', preventDefault });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    el.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
    expect(onClick).toHaveBeenCalledTimes(2);
    el.props.onKeyDown({ key: 'a', preventDefault });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('resolves a target only when enabled with a connection_id', () => {
    expect(atlasSsoTarget({ sign_in_with_atlas: { enabled: true, connection_id: 'c1' } })).toBe('c1');
    expect(atlasSsoTarget({ sign_in_with_atlas: { enabled: false, connection_id: 'c1' } })).toBeNull();
    expect(atlasSsoTarget({ sign_in_with_atlas: { enabled: true } })).toBeNull();
    expect(atlasSsoTarget({})).toBeNull();
  });

  it('renders the button', () => {
    const html = renderToString(createElement(AtlasSsoButton, { onClick: () => {} }));
    expect(html).toContain('data-atlas-provider="atlas"');
    expect(html).toContain('Continue with Atlas');
  });
});


describe('signInWithAtlasPopup (response_mode=web_message)', () => {
  const ISS = 'https://atlasauth.net';
  function harness(opts: { blocked?: boolean } = {}) {
    const popup = { closed: false, location: { href: '' }, close: vi.fn(() => void (popup.closed = true)) };
    const listeners: Array<(ev: unknown) => void> = [];
    const open = vi.fn(() => (opts.blocked ? null : popup));
    vi.stubGlobal('window', {
      location: { href: 'https://site.test/page', origin: 'https://site.test', assign },
      open,
      addEventListener: (t: string, fn: (ev: unknown) => void) => t === 'message' && listeners.push(fn),
      removeEventListener: (_t: string, fn: (ev: unknown) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    });
    const post = (ev: { source?: unknown; origin?: string; data: unknown }) =>
      listeners.slice().forEach((fn) => fn({ source: popup, origin: ISS, ...ev }));
    return { popup, open, post };
  }
  const jwt = (claims: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  it('opens a popup, accepts only the matching message, and exchanges with PKCE', async () => {
    const h = harness();
    const fetchMock = vi.fn();
    const pending = signInWithAtlasPopup({ ...opts, fetch: fetchMock as unknown as typeof fetch });
    expect(h.open).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.popup.location.href).not.toBe(''));
    const url = new URL(h.popup.location.href);
    expect(url.searchParams.get('response_mode')).toBe('web_message');
    const state = url.searchParams.get('state')!;
    const saved = JSON.parse(store.get(`atlasid:${state}`)!);
    expect(saved.popup).toBe(true);

    const data = { type: 'atlasid:authorization_response', response: { code: 'abc', state } };
    h.post({ origin: 'https://evil.test', data });
    h.post({ source: {}, data });
    expect(fetchMock).not.toHaveBeenCalled();

    const token = jwt({ iss: ISS, aud: 'cid', nonce: saved.nonce, sub: 'u1' });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id_token: token, access_token: 'at' }) });
    h.post({ data });
    const r = await pending;
    expect(r.credential).toBe(token);
    expect(r.claims.sub).toBe('u1');
    expect(h.popup.close).toHaveBeenCalled();
    expect(new URLSearchParams(fetchMock.mock.calls[0]![1].body).get('code_verifier')).toBe(saved.verifier);
  });

  it('rejects popup_closed when the user closes the popup', async () => {
    const h = harness();
    const pending = signInWithAtlasPopup(opts);
    h.popup.closed = true;
    await expect(pending).rejects.toThrow('popup_closed');
  });

  it('rejects with the OP error', async () => {
    const h = harness();
    const pending = signInWithAtlasPopup(opts);
    await vi.waitFor(() => expect(h.popup.location.href).not.toBe(''));
    const state = new URL(h.popup.location.href).searchParams.get('state')!;
    h.post({ data: { type: 'atlasid:authorization_response', response: { error: 'access_denied', state } } });
    await expect(pending).rejects.toThrow('access_denied');
  });

  it('falls back to a full-page redirect when the popup is blocked', async () => {
    harness({ blocked: true });
    void signInWithAtlasPopup(opts);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(new URL(assign.mock.calls[0]![0] as string).searchParams.get('response_mode')).toBeNull();
  });
});

describe('Sign in with Atlas carries the referral', () => {
  it('adds ref_* from the page URL to the authorize URL; referral: false opts out', async () => {
    vi.stubGlobal('window', {
      location: { href: 'https://site.test/page?via=REACT01', origin: 'https://site.test', search: '?via=REACT01', assign },
    });
    let url = new URL(await buildAtlasAuthorizeUrl(opts));
    expect(url.searchParams.get('ref')).toBe('REACT01');
    expect(url.searchParams.get('ref_consent')).toBe('not_required');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    url = new URL(await buildAtlasAuthorizeUrl({ ...opts, referral: false }));
    expect(url.searchParams.get('ref')).toBeNull();
  });

  it("prefers the page's referral script, with ids under consent", async () => {
    vi.stubGlobal('window', {
      location: { href: 'https://site.test/page?ref=URLCODE', origin: 'https://site.test', search: '?ref=URLCODE', assign },
      aff: { getReferral: () => ({ code: 'SCRIPT1', clickId: 'clk_1', anonId: 'a_1', ts: 1_790_000_000 }) },
    });
    const url = new URL(await buildAtlasAuthorizeUrl({ ...opts, referralConsent: 'granted' }));
    const p = url.searchParams;
    expect([p.get('ref'), p.get('ref_click_id'), p.get('ref_anon_id'), p.get('ref_consent')]).toEqual([
      'SCRIPT1',
      'clk_1',
      'a_1',
      'granted',
    ]);
    expect(p.get('ref_captured_at')).toBe(new Date(1_790_000_000 * 1000).toISOString());
  });
});

describe('SignInWithAtlasButton accessibility and atlasid:* events', () => {
  it('labels in the requested language and sets a matching aria-label', () => {
    const html = renderToString(createElement(SignInWithAtlasButton, { ...opts, text: 'continue', locale: 'es-MX' }));
    expect(html).toContain('Continuar con Atlas');
    expect(html).toContain('aria-label="Continuar con Atlas"');
    expect(atlasIdLabels('pt').signin).toBe('Entrar com Atlas');
    expect(atlasIdLabels('xx').signup).toBe('Sign up with Atlas');
  });

  it('dispatches atlasid:ready and sets data-atlasid-state when mounted', () => {
    const events: Array<{ type: string; detail: unknown }> = [];
    const attrs: Record<string, string> = {};
    const node = {
      hasAttribute: (k: string) => k in attrs,
      setAttribute: (k: string, v: string) => void (attrs[k] = v),
      dispatchEvent: (e: CustomEvent) => (events.push({ type: e.type, detail: e.detail }), true),
    };
    const onReady = vi.fn();
    const el = SignInWithAtlasButton({ ...opts, onReady }) as unknown as { ref: (n: unknown) => void } & { props: unknown };
    (el as unknown as { ref: (n: unknown) => void }).ref(node);
    expect(attrs['data-atlasid-state']).toBe('ready');
    expect(events.map((e) => e.type)).toEqual(['atlasid:ready']);
    expect(onReady).toHaveBeenCalledWith({ version: 'react' });
  });

  it('listenAtlasIdEvents subscribes and unsubscribes', () => {
    const target = new EventTarget();
    const onError = vi.fn();
    const off = listenAtlasIdEvents(target, { onError });
    target.dispatchEvent(new CustomEvent('atlasid:error', { detail: { error: 'csp_blocked' } }));
    off();
    target.dispatchEvent(new CustomEvent('atlasid:error', { detail: { error: 'again' } }));
    expect(onError.mock.calls).toEqual([[{ error: 'csp_blocked' }]]);
  });

  it('the authorize URL carries the button marker', async () => {
    const url = new URL(await buildAtlasAuthorizeUrl(opts));
    expect(url.searchParams.get('atlasid_button')).toBe('react');
  });

  it('oneTapWithAtlas reports fedcm_unavailable without FedCM', async () => {
    await expect(oneTapWithAtlas({ clientId: 'cid' })).rejects.toThrow('fedcm_unavailable');
  });

  it('oneTapWithAtlas verifies the issuer, audience and nonce of the FedCM token', async () => {
    let req: { identity: { providers: Array<{ nonce: string; configURL: string }> } } | null = null;
    vi.stubGlobal('IdentityCredential', function IdentityCredential() {});
    vi.stubGlobal('navigator', {
      credentials: {
        get: async (r: typeof req) => {
          req = r;
          const nonce = r!.identity.providers[0]!.nonce;
          return { token: jwt({ iss: 'https://atlasauth.net', aud: 'cid', nonce }) };
        },
      },
    });
    const r = await oneTapWithAtlas({ clientId: 'cid' });
    expect(r.via).toBe('fedcm');
    expect(req!.identity.providers[0]!.configURL).toBe('https://atlasauth.net/oauth2/fedcm/config.json');
    vi.stubGlobal('navigator', { credentials: { get: async () => ({ token: jwt({ iss: 'https://atlasauth.net', aud: 'cid', nonce: 'other' }) }) } });
    await expect(oneTapWithAtlas({ clientId: 'cid' })).rejects.toThrow('nonce_mismatch');
  });
});
