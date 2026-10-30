import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { AtlasFlowController } from './flow-controller';
import { EN_US, translate } from '../i18n';

/**
 * `<atlas-sign-in>`'s passkey sign-in: offered on the first step when the
 * instance turns it on (`strategies.passkey` in /v1/appearance) and the browser
 * can run WebAuthn; `passkey.signIn()` starts the usernameless ceremony at
 * /v1/client/sign_ins/passkey/begin and lands its outcome in the flow state.
 * Runs under vitest (node), where there is no WebAuthn: the ceremony fails like
 * a cancelled prompt, which is exactly the localized-cancel path.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function controller(opts: { passkey: boolean; begin: Response }) {
  const posts: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'POST') posts.push(path);
    if (path === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: {},
        strategies: { passkey: opts.passkey },
      });
    }
    if (path === '/v1/client/sign_ins/passkey/begin') return opts.begin.clone();
    return json({});
  }) as unknown as typeof fetch;
  const flow = new AtlasFlowController(new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }), async () => true, null);
  await flow.loadSettings();
  return { flow, posts };
}

describe('AtlasFlowController passkey sign-in', () => {
  it('is offered only on the first step, with the instance setting on and a WebAuthn browser', async () => {
    const { flow } = await controller({ passkey: true, begin: json({}) });
    expect(flow.passkeyOffered()).toBe(false);
    flow.passkeySupported.set(true);
    expect(flow.passkeyOffered()).toBe(true);
    flow.state.set({ ...flow.state(), attempt: { id: 'sia_1', status: 'needs_first_factor' } as never });
    expect(flow.passkeyOffered()).toBe(false);
    flow.destroy();

    const off = await controller({ passkey: false, begin: json({}) });
    off.flow.passkeySupported.set(true);
    expect(off.flow.passkeyOffered()).toBe(false);
    off.flow.destroy();
  });

  it('signIn() posts the begin and shows its refusal', async () => {
    const { flow, posts } = await controller({
      passkey: true,
      begin: json({ errors: [{ code: 'PASSKEY_UNAVAILABLE', message: 'No passkey sign-in right now.' }] }, 400),
    });
    await flow.passkey.signIn();
    expect(posts).toContain('/v1/client/sign_ins/passkey/begin');
    expect(flow.state().errors[0]?.message).toBe('No passkey sign-in right now.');
    expect(flow.state().busy).toBe(false);
    flow.destroy();
  });

  it('a prompt that did not finish is a localized PASSKEY_CANCELLED error, never a throw', async () => {
    const { flow, posts } = await controller({
      passkey: true,
      begin: json({ challenge: 'AAAA', rpId: 'example.com', allowCredentials: [], userVerification: 'preferred', timeout: 60000 }),
    });
    await flow.passkey.signIn();
    expect(posts).not.toContain('/v1/client/sign_ins/passkey/finish');
    expect(flow.state().errors).toEqual([{ code: 'PASSKEY_CANCELLED', message: translate(EN_US, 'signIn.passkeyCancelled') }]);
    flow.destroy();
  });
});
