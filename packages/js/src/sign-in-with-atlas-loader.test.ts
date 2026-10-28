// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cspBlockedMessage,
  loadSignInWithAtlas,
  resetSignInWithAtlasLoader,
  signInWithAtlasScriptUrl,
} from './sign-in-with-atlas-loader';

afterEach(() => {
  resetSignInWithAtlasLoader();
  delete (window as unknown as { AtlasID?: unknown }).AtlasID;
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

const lastScript = () => document.head.querySelector('script') as HTMLScriptElement;

describe('loadSignInWithAtlas', () => {
  it('builds evergreen, major and exact URLs', () => {
    expect(signInWithAtlasScriptUrl()).toBe('https://atlasauth.net/sign-in-with-atlas.js');
    expect(signInWithAtlasScriptUrl({ version: '1' })).toBe('https://atlasauth.net/sign-in-with-atlas@1.js');
    expect(signInWithAtlasScriptUrl({ version: '1.0.0', issuer: 'https://id.example/' })).toBe('https://id.example/sign-in-with-atlas@1.0.0.js');
    expect(signInWithAtlasScriptUrl({ version: '../x' })).toBe('https://atlasauth.net/sign-in-with-atlas.js');
  });

  it('adds integrity, crossorigin and nonce, and resolves window.AtlasID on load', async () => {
    const p = loadSignInWithAtlas({ version: '1.0.0', integrity: 'sha384-abc', nonce: 'n1' });
    const s = lastScript();
    expect(s.src).toBe('https://atlasauth.net/sign-in-with-atlas@1.0.0.js');
    expect(s.integrity).toBe('sha384-abc');
    expect(s.crossOrigin).toBe('anonymous');
    expect(s.nonce).toBe('n1');
    (window as unknown as { AtlasID: unknown }).AtlasID = { version: '1.0.0' };
    s.onload?.(new Event('load'));
    await expect(p).resolves.toEqual({ version: '1.0.0' });
  });

  it('logs the CSP line and rejects csp_blocked when the policy blocks the script', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = loadSignInWithAtlas();
    const ev = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
    Object.assign(ev, { blockedURI: 'https://atlasauth.net/sign-in-with-atlas.js', effectiveDirective: 'script-src-elem' });
    document.dispatchEvent(ev);
    await expect(p).rejects.toThrow('csp_blocked');
    expect(log).toHaveBeenCalledWith(cspBlockedMessage('https://atlasauth.net', 'script-src-elem'));
    expect(log.mock.calls[0]![0]).toBe(
      '[Atlas] blocked by CSP: add https://atlasauth.net to script-src-elem (see https://atlasauth.net/.well-known/atlas-embed.json)',
    );
  });

  it('ignores violations of other origins, and reports a plain load error', async () => {
    vi.useFakeTimers();
    const p = loadSignInWithAtlas();
    const ev = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
    Object.assign(ev, { blockedURI: 'https://other.example/x.js', effectiveDirective: 'script-src' });
    document.dispatchEvent(ev);
    lastScript().onerror?.(new Event('error'));
    vi.advanceTimersByTime(100);
    vi.useRealTimers();
    await expect(p).rejects.toThrow('script_load_failed');
  });
});
