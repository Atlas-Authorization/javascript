// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishActiveAtlas, type ActiveAtlas } from './active-atlas';
import { mountReferralElement, referralFromUser, referralWidgetSrc } from './referral-panel';

const atlas = (over: Partial<ActiveAtlas> = {}): ActiveAtlas => ({
  status: 'signed_in',
  user: { id: 'user_1', public_metadata: {} } as ActiveAtlas['user'],
  claims: { sub: 'user_1', sid: 's', exp: 1, external_id: 'ext_1' },
  getToken: async () => 'jwt-1',
  signOut: async () => undefined,
  reload: async () => true,
  ...over,
});

afterEach(() => {
  publishActiveAtlas(null);
  delete (window as { Atlas?: unknown }).Atlas;
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

describe('referralFromUser', () => {
  it('reads public_metadata.referalli, camel or snake', () => {
    expect(referralFromUser({ public_metadata: { referalli: { code: 'abc', link_url: 'https://r.test/abc' } } })).toEqual({ code: 'abc', linkUrl: 'https://r.test/abc' });
    expect(referralFromUser({ public_metadata: { referalli: { code: 'abc', linkUrl: 'https://r.test/abc' } } })?.linkUrl).toBe('https://r.test/abc');
  });
  it('falls back to the attribution mirror, and is null without a code', () => {
    expect(referralFromUser({ public_metadata: { referral: { own_code: 'zed' } } })).toEqual({ code: 'zed', linkUrl: null });
    expect(referralFromUser({ public_metadata: {} })).toBeNull();
    expect(referralFromUser(null)).toBeNull();
  });
});

describe('window.Atlas.session via the provider registry', () => {
  it('exposes the mounted provider and keeps an existing window.Atlas', async () => {
    (window as { Atlas?: unknown }).Atlas = { keep: 1 };
    publishActiveAtlas(atlas());
    const a = window.Atlas as { keep?: number; session?: { getToken(): Promise<string | null>; getIdToken(): Promise<string | null>; isSignedIn: boolean }; billing?: { customerMetadata(): unknown } };
    expect(a.keep).toBe(1);
    expect(await a.session?.getToken()).toBe('jwt-1');
    expect(await a.session?.getIdToken()).toBe('jwt-1');
    expect(a.session?.isSignedIn).toBe(true);
    expect(a.billing?.customerMetadata()).toEqual({ atlas_user_id: 'user_1', atlas_external_id: 'ext_1' });
  });

  it('is signed out (null) when the provider is', async () => {
    publishActiveAtlas(atlas({ status: 'signed_out', user: null, getToken: async () => null }));
    expect(await window.Atlas?.session?.getToken()).toBeNull();
    expect(window.Atlas?.session?.isSignedIn).toBe(false);
  });

  it('dispatches atlas:session when the user changes', () => {
    const seen: unknown[] = [];
    window.addEventListener('atlas:session', (e) => seen.push((e as CustomEvent).detail));
    publishActiveAtlas(atlas({ status: 'signed_out', user: null }));
    publishActiveAtlas(atlas());
    expect(seen.at(-1)).toEqual({ signedIn: true, userId: 'user_1' });
  });
});

// happy-dom disables script loading and answers every <script src> with an
// immediate load/error event; these tests fire onload/onerror themselves.
const realDispatch = HTMLScriptElement.prototype.dispatchEvent;
beforeEach(() => {
  vi.spyOn(HTMLScriptElement.prototype, 'dispatchEvent').mockImplementation(function (this: HTMLScriptElement, e: Event) {
    return e.type === 'load' || e.type === 'error' ? true : realDispatch.call(this, e);
  });
});

describe('mountReferralElement', () => {
  it('loads the script, then mounts the element with the session token getter', async () => {
    const host = document.createElement('div');
    const off = mountReferralElement(host, { program: 'prg_1', src: 'https://widgets.test/w.js', getAuthToken: async () => 'tok' });
    const script = document.head.querySelector('script') as HTMLScriptElement;
    expect(script.src).toBe('https://widgets.test/w.js');
    script.onload?.(new Event('load'));
    await new Promise((r) => setTimeout(r, 0));
    const el = host.querySelector('referalli-referral-widget') as HTMLElement & { getAuthToken(): Promise<string> };
    expect(el.getAttribute('program')).toBe('prg_1');
    expect(el.getAttribute('auth')).toBe('atlas');
    expect(await el.getAuthToken()).toBe('tok');
    off();
    expect(host.children.length).toBe(0);
  });

  it('builds the per-merchant widget script URL from the tracking token', () => {
    expect(referralWidgetSrc('tt_abc')).toBe('https://referalli.com/t/tt_abc/widget.js');
    expect(referralWidgetSrc('a b', 'https://ref.example.com/')).toBe('https://ref.example.com/t/a%20b/widget.js');
  });
});
