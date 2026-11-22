// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { atlasReady } from '@atlasauth/js';
import { AtlasProvider, useAtlas } from './AtlasProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

describe('getToken during the first boot', () => {
  it('waits for the boot instead of answering null, and atlasReady resolves signed in', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/client')) {
        await gate;
        return new Response(
          JSON.stringify({
            session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
            user: { id: 'user_1' },
            jwt,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    let ctx: ReturnType<typeof useAtlas> | null = null;
    const Probe = () => {
      ctx = useAtlas();
      return null;
    };
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
          children: createElement(Probe),
        }),
      );
    });
    expect(ctx!.status).toBe('loading');

    const pending = ctx!.getToken();
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    await act(async () => {
      release();
    });
    expect(await pending).toBe(jwt);
    await expect(atlasReady()).resolves.toEqual({ signedIn: true });
    await act(async () => root.unmount());
  });
});
