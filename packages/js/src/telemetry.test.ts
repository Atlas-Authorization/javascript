// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BehaviorRecorder, collectDeviceSignals, deviceFingerprint, sendTelemetry } from './telemetry';

/**
 * §bot — the client collector. It must never throw, must capture COUNTS AND
 * TIMINGS ONLY (never key content), and must post to the telemetry beacon with
 * the publishable key on the query (so sendBeacon works).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('device signals', () => {
  it('collects a bounded snapshot without throwing', () => {
    const d = collectDeviceSignals();
    expect(typeof d.webdriver).toBe('boolean');
    expect(Array.isArray(d.languages)).toBe(true);
    // A fingerprint is a short stable hex string.
    expect(deviceFingerprint(d)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('behavioural recorder', () => {
  it('counts keys and mouse moves as timing aggregates, never content', () => {
    const rec = new BehaviorRecorder(document);
    // Simulate a human typing + moving.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace' }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace' }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 50 }));

    const snap = rec.snapshot();
    expect(snap.keyCount).toBe(2);
    expect(snap.backspaceCount).toBe(1);
    expect(snap.hadKeydown).toBe(true);
    expect(snap.hadPointerMove).toBe(true);
    expect(snap.mouseMoves).toBeGreaterThanOrEqual(2);
    expect(snap.mouseDistance).toBeGreaterThan(0);
    // The snapshot is pure aggregates — no field for captured text exists.
    expect(JSON.stringify(snap)).not.toContain('KeyA');
    rec.stop();
  });

  it('a bot that never interacts reports no pointer/keys', () => {
    const rec = new BehaviorRecorder(document);
    const snap = rec.snapshot();
    expect(snap.hadPointerMove).toBe(false);
    expect(snap.hadKeydown).toBe(false);
    expect(snap.keyCount).toBe(0);
    rec.stop();
  });
});

describe('sendTelemetry', () => {
  it('posts device + behaviour to the beacon with the pk on the query', async () => {
    // Force the fetch path — make sendBeacon decline so we fall through to fetch.
    Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: true });
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    const rec = new BehaviorRecorder(document);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX' }));

    const ok = await sendTelemetry({
      api: 'https://accounts.acme.com',
      publishableKey: 'pk_test_1',
      kind: 'sign_in',
      recorder: rec,
      fetchImpl,
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1/client/telemetry?publishable_key=pk_test_1');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.kind).toBe('sign_in');
    expect(body.device).toBeTruthy();
    expect(body.behavior.keyCount).toBe(1);
    rec.stop();
  });

  it('never throws and resolves false when there is no transport', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: true });
    vi.stubGlobal('fetch', undefined);
    const ok = await sendTelemetry({ api: '', publishableKey: 'pk_test_1' });
    expect(ok).toBe(false);
  });
});
