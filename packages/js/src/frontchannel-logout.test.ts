// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  frontChannelLogoutUrls,
  runFrontChannelLogout,
  runFrontChannelLogoutFromResponse,
} from './frontchannel-logout';

/**
 * Frames are appended to a detached container instead of the live body, so the
 * DOM never actually navigates them: each test decides when (or whether) a
 * frame "loads".
 */
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T) => host.appendChild(node));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const frames = () => Array.from(host.querySelectorAll('iframe'));

describe('runFrontChannelLogout', () => {
  it('loads each URL in a hidden sandboxed iframe and removes them once all load', async () => {
    const urls = ['https://app-a.example/fc?iss=x&sid=1', 'https://app-b.example/logout?sid=1'];
    let resolved = false;
    const p = runFrontChannelLogout(urls).then(() => {
      resolved = true;
    });

    const loaded = frames();
    expect(loaded.map((f) => f.src)).toEqual(urls);
    for (const f of loaded) {
      expect(f.style.display).toBe('none');
      expect(f.getAttribute('sandbox')).toBe('allow-same-origin');
      expect(f.getAttribute('aria-hidden')).toBe('true');
    }

    loaded[0]!.dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(resolved).toBe(false);
    loaded[1]!.dispatchEvent(new Event('error'));
    await p;
    expect(resolved).toBe(true);
    expect(frames()).toHaveLength(0);
  });

  it('gives up after the timeout and still removes the frames', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = runFrontChannelLogout(['https://slow.example/fc'], { timeoutMs: 5000 }).then(() => {
      resolved = true;
    });
    expect(frames()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    expect(frames()).toHaveLength(0);
  });

  it('defaults to a 5 s cap', async () => {
    vi.useFakeTimers();
    const p = runFrontChannelLogout(['https://slow.example/fc']);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeUndefined();
    expect(frames()).toHaveLength(0);
  });

  it('only loads https URLs (and http on loopback for development)', async () => {
    const p = runFrontChannelLogout([
      'http://evil.example/fc',
      'javascript:alert(1)',
      'data:text/html,hi',
      '/relative',
      'not a url',
      42,
      'https://ok.example/fc',
      'http://localhost:3000/fc',
      'http://127.0.0.1:8080/fc',
    ]);
    const srcs = frames().map((f) => f.src);
    expect(srcs).toEqual(['https://ok.example/fc', 'http://localhost:3000/fc', 'http://127.0.0.1:8080/fc']);
    for (const f of frames()) f.dispatchEvent(new Event('load'));
    await p;
  });

  it('is a no-op for an empty, missing or all-rejected list', async () => {
    await runFrontChannelLogout(undefined);
    await runFrontChannelLogout([]);
    await runFrontChannelLogout(['http://evil.example/fc']);
    expect(document.body.appendChild).not.toHaveBeenCalled();
  });

  it('is a no-op without a DOM (SSR)', async () => {
    vi.stubGlobal('document', undefined);
    try {
      await expect(runFrontChannelLogout(['https://app.example/fc'])).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(frames()).toHaveLength(0);
  });
});

describe('frontChannelLogoutUrls', () => {
  it('filters to safe absolute URLs', () => {
    expect(frontChannelLogoutUrls('https://a.example')).toEqual([]);
    expect(frontChannelLogoutUrls(['https://a.example/x', 'ftp://b.example'])).toEqual(['https://a.example/x']);
  });
});

describe('runFrontChannelLogoutFromResponse', () => {
  it('reads frontchannel_logout_urls from an OK revoke response', async () => {
    const res = new Response(
      JSON.stringify({ object: 'session', status: 'revoked', frontchannel_logout_urls: ['https://app.example/fc'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const p = runFrontChannelLogoutFromResponse(res);
    await vi.waitFor(() => expect(frames()).toHaveLength(1));
    frames()[0]!.dispatchEvent(new Event('load'));
    await p;
    expect(frames()).toHaveLength(0);
    // The body was read from a clone; the caller can still consume it.
    await expect(res.json()).resolves.toMatchObject({ status: 'revoked' });
  });

  it('ignores failed, non-OK and non-JSON responses', async () => {
    await runFrontChannelLogoutFromResponse(undefined);
    await runFrontChannelLogoutFromResponse(
      new Response(JSON.stringify({ frontchannel_logout_urls: ['https://app.example/fc'] }), { status: 401 }),
    );
    await runFrontChannelLogoutFromResponse(new Response('<html>', { status: 200 }));
    expect(document.body.appendChild).not.toHaveBeenCalled();
  });
});
