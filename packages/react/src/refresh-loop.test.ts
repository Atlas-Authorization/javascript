// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCoordinatedRefresh } from '@atlasauth/js';
import { AtlasProvider } from './AtlasProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
// Expires in 5 s: inside the 10 s refresh lead window from the moment it is issued.
const nearExpiry = () => `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 5 })}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('proactive session-token refresh', () => {
  it.each([
    ['a failed refresh re-boots into the same near-expiry token', 500],
    ['a refresh that returns another near-expiry token', 200],
  ])('does not loop when %s', async (_name, refreshStatus) => {
    const calls = { client: 0, tokens: 0 };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/client')) {
        calls.client++;
        return json({ session: { id: 'sess_1', status: 'active', last_active_organization_id: null }, user: { id: 'user_1' }, jwt: nearExpiry() });
      }
      if (url.endsWith('/v1/client/sessions/sess_1/tokens')) {
        calls.tokens++;
        return refreshStatus === 200 ? json({ jwt: nearExpiry(), session_id: 'sess_1' }) : json({ errors: [] }, refreshStatus);
      }
      return json({});
    }) as unknown as typeof fetch;

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
          children: null,
        }),
      );
    });
    // In slices, so React flushes the updates each refresh causes (act holds them until it exits). Unbounded, a
    // zero-delay refresh fires about every 50 ms here and every ~250 ms on a device.
    for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 25)));
    expect(calls.tokens).toBeLessThanOrEqual(1);
    expect(calls.client).toBeLessThanOrEqual(3);
    await act(async () => root.unmount());
  });
});
