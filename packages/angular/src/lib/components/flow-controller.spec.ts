import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { AtlasFlowController } from './flow-controller';
import { EN_US } from '../i18n';

/**
 * `<atlas-sign-up>`'s engine really creates the account (POST
 * /v1/client/sign_ups, then the emailed code), draws the configured captcha,
 * sends its token, and recovers from a refused token; `<atlas-sign-in>`'s
 * answers the `needs_captcha` step. The provider is a fake Turnstile global, so
 * the shared `@atlasauth/js` renderer runs against it with no network; FAPI is a
 * scripted fetch. Runs under vitest (node) against the plain controller class:
 * `vitest run src/lib/components/flow-controller.spec.ts`.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
type Route = (call: Call) => Response | undefined;

const g = globalThis as unknown as Record<string, unknown>;

function fakeTurnstile() {
  const widgets: Record<string, unknown>[] = [];
  const api = {
    render: vi.fn((_el: unknown, opts: Record<string, unknown>) => {
      widgets.push(opts);
      return `w${widgets.length}`;
    }),
    remove: vi.fn(),
    execute: vi.fn(),
  };
  g.turnstile = api;
  return {
    api,
    solve: (token: string) => (widgets[widgets.length - 1]!.callback as (t: string) => void)(token),
  };
}

/** A stand-in for the slot element: the renderer only needs a container it can empty. */
const slot = () =>
  ({ ownerDocument: undefined, firstChild: null, removeChild: () => undefined }) as unknown as HTMLElement;

let calls: Call[] = [];
const reload = vi.fn(async () => true);
beforeEach(() => {
  calls = [];
  reload.mockClear();
});
afterEach(() => {
  delete g.turnstile;
});

async function controller(opts: { captchaFlows?: Record<string, unknown>; signInWithAtlas?: Record<string, unknown>; routes: Route[] }) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: opts.captchaFlows ?? {},
        ...(opts.signInWithAtlas ? { sign_in_with_atlas: opts.signInWithAtlas } : {}),
      });
    }
    for (const route of opts.routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  const flow = new AtlasFlowController(
    new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }),
    reload,
    null,
  );
  await flow.loadSettings();
  return flow;
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const TURNSTILE = { enabled: true, provider: 'turnstile', siteKey: 'ts-site', widget: 'managed' };

describe('AtlasFlowController sign-up', () => {
  it('create() posts /v1/client/sign_ups (not sign_ins), then submit() verifies the code and exchanges the ticket', async () => {
    const flow = await controller({
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ups'
            ? json({ id: 'sua_1', status: 'needs_email_verification' }, 201)
            : undefined,
        (c) =>
          c.path === '/v1/client/sign_ups/sua_1/attempt_verification'
            ? json({ id: 'sua_1', status: 'complete', ticket: 'tkt_1' })
            : undefined,
      ],
    });
    expect(flow.signUpCaptchaDrawn()).toBe(false);

    await flow.create({ email: 'new@example.com', password: 'blue tangerine anvil 71!' });
    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      consent: true,
    });
    expect(flow.state().attempt?.status).toBe('needs_email_verification');

    await flow.submit({ code: '424242' });
    expect(posts('/v1/client/sign_ups/sua_1/attempt_verification')[0]!.body).toEqual({ code: '424242' });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toEqual({ attempt_id: 'sua_1', ticket: 'tkt_1' });
    expect(reload).toHaveBeenCalled();
    flow.destroy();
  });

  it('sends the sign-up captcha token; on CAPTCHA_FAILED localizes the message, redraws and sends the NEW token', async () => {
    const ts = fakeTurnstile();
    let tries = 0;
    const flow = await controller({
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ups') return undefined;
          tries += 1;
          return tries === 1
            ? json({ errors: [{ code: 'CAPTCHA_FAILED', message: 'x', param: 'captcha_token' }] }, 400)
            : json({ id: 'sua_3', status: 'needs_email_verification' }, 201);
        },
      ],
    });
    expect(flow.signUpCaptchaDrawn()).toBe(true);
    flow.signUpCaptcha.attach(slot());
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    expect(ts.api.render.mock.calls[0]![1]).toMatchObject({ sitekey: 'ts-site', appearance: 'always' });

    ts.solve('tok-bad');
    await flow.create({ email: 'retry@example.com', password: 'pw' });
    expect(posts('/v1/client/sign_ups')[0]!.body).toMatchObject({ captcha_token: 'tok-bad' });
    expect(flow.state().errors).toEqual([{ code: 'CAPTCHA_FAILED', message: EN_US['captcha.failed'] }]);
    expect(ts.api.remove).toHaveBeenCalledWith('w1');
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));

    ts.solve('tok-good');
    await flow.create({ email: 'retry@example.com', password: 'pw' });
    expect(posts('/v1/client/sign_ups')[1]!.body).toMatchObject({ captcha_token: 'tok-good' });
    expect(flow.signUpCaptchaDrawn()).toBe(false);
    flow.destroy();
  });
});

describe('AtlasFlowController sign-in captcha', () => {
  it('answers needs_captcha: draws the widget and, once solved, re-sends the identifier with the token', async () => {
    const ts = fakeTurnstile();
    const flow = await controller({
      captchaFlows: { signIn: { ...TURNSTILE, enabled: false } },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ins') return undefined;
          return c.body?.captcha_token
            ? json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: [{ strategy: 'password' }] }, 201)
            : json({ id: null, status: 'needs_captcha', identifier: 'me@example.com' }, 201);
        },
      ],
    });
    expect(flow.captchaDrawn()).toBe(false);
    flow.captcha.attach(slot());

    await flow.submit({ identifier: 'me@example.com' });
    expect(flow.captchaDrawn()).toBe(true);
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));

    ts.solve('tok-si');
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(2));
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-si',
    });
    await vi.waitFor(() => expect(flow.state().attempt?.status).toBe('needs_first_factor'));
    flow.destroy();
  });
});

describe('AtlasFlowController passkey-only sign-up', () => {
  const routes: Route[] = [
    (c) =>
      c.path === '/v1/client/sign_ups/passkey'
        ? json({ id: 'sua_pk', object: 'sign_up_attempt', status: 'needs_first_factor', supported_first_factors: ['passkey'], poll_secret: 'ps_1' }, 201)
        : undefined,
    (c) =>
      c.path === '/v1/client/sign_ups/sua_pk/passkey/begin'
        ? json({ challenge: 'Y2hhbGxlbmdl', rp: { id: 'example.com', name: 'Atlas' }, user: { id: 'dXNlcl8x', name: 'u', displayName: 'u' }, pubKeyCredParams: [] }, 201)
        : undefined,
    (c) =>
      c.path === '/v1/client/sign_ups/sua_pk/passkey/finish'
        ? json({ id: 'sua_pk', object: 'sign_up_attempt', status: 'complete', ticket: 'tkt_pk' })
        : undefined,
  ];
  afterEach(() => vi.unstubAllGlobals());

  it('createWithPasskey() sends no password; createPasskey() registers it and exchanges the ticket', async () => {
    const create = vi.fn(async () => ({
      rawId: new Uint8Array([1]).buffer,
      response: { attestationObject: new Uint8Array([4, 5, 6]).buffer, clientDataJSON: new Uint8Array([7, 8, 9]).buffer },
    }));
    vi.stubGlobal('navigator', { credentials: { create, get: vi.fn() } });
    const flow = await controller({ routes });

    await flow.createWithPasskey({ email: '', password: 'ignored', company: 'Acme' });
    expect(posts('/v1/client/sign_ups/passkey')[0]!.body).toEqual({ fields: { company: 'Acme' }, consent: true });
    expect(flow.state().attempt?.status).toBe('needs_first_factor');
    expect(flow.state().pollSecret).toBe('ps_1');

    await flow.createPasskey();
    expect(create).toHaveBeenCalledTimes(1);
    expect(posts('/v1/client/sign_ups/sua_pk/passkey/finish')[0]!.body).toMatchObject({ poll_secret: 'ps_1' });
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sua_pk', ticket: 'tkt_pk' });
    expect(reload).toHaveBeenCalled();
    flow.destroy();
  });

  it('a cancelled prompt keeps the step and says so in the catalog wording', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn(async () => {
          throw new Error('NotAllowedError');
        }),
        get: vi.fn(),
      },
    });
    const flow = await controller({ routes });
    await flow.createWithPasskey({});
    await flow.createPasskey();
    expect(flow.state().attempt?.status).toBe('needs_first_factor');
    expect(flow.state().errors).toEqual([{ code: 'PASSKEY_CANCELLED', message: EN_US['signUp.passkeyCancelled'] }]);
    expect(posts('/v1/client/sign_ups/sua_pk/passkey/finish')).toHaveLength(0);
    flow.destroy();
  });
});

describe('AtlasFlowController emailed second factor and sign-up resend', () => {
  it('sendEmailSecondFactor() mails the code for this attempt and reports where it went; leaving the step clears it', async () => {
    const flow = await controller({
      routes: [
        (c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_1', status: 'needs_second_factor' }, 201) : undefined),
        (c) => (c.path === '/v1/client/sign_ins/sia_1/prepare_second_factor' ? json({ sent_to: 'a•••@example.com' }) : undefined),
        (c) => (c.path === '/v1/client/sign_ins/sia_1/attempt_second_factor' ? json({ id: 'sia_1', status: 'complete', ticket: 'tk' }) : undefined),
      ],
    });
    await flow.submit({ identifier: 'ada@example.com' });
    expect(flow.state().attempt?.status).toBe('needs_second_factor');
    await flow.sendEmailSecondFactor();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor')[0]!.body).toEqual({ strategy: 'email_code' });
    expect(flow.emailSecondFactor()).toEqual({ sentTo: 'a•••@example.com' });
    await flow.submit({ code: '123456' });
    expect(flow.emailSecondFactor()).toBeNull();
    flow.destroy();
  });

  it('a refused send is reported, not thrown', async () => {
    const flow = await controller({
      routes: [
        (c) => (c.path === '/v1/client/sign_ins' ? json({ id: 'sia_2', status: 'needs_second_factor' }, 201) : undefined),
        (c) =>
          c.path === '/v1/client/sign_ins/sia_2/prepare_second_factor'
            ? json({ errors: [{ code: 'TOO_MANY_REQUESTS', message: 'Slow down.' }] }, 429)
            : undefined,
      ],
    });
    await flow.submit({ identifier: 'ada@example.com' });
    await flow.sendEmailSecondFactor();
    expect(flow.emailSecondFactor()).toEqual({ error: 'Slow down.' });
    flow.destroy();
  });

  it('resendSignUp() asks for a fresh verification email for the attempt', async () => {
    const flow = await controller({
      routes: [
        (c) => (c.path === '/v1/client/sign_ups' ? json({ id: 'sua_9', object: 'sign_up_attempt', status: 'needs_email_verification' }, 201) : undefined),
        (c) => (c.path === '/v1/client/sign_ups/sua_9/prepare_verification' ? json({ id: 'sua_9', status: 'needs_email_verification' }) : undefined),
      ],
    });
    await flow.create({ email: 'n@example.com', password: 'blue tangerine anvil 71!' });
    await flow.resendSignUp();
    expect(posts('/v1/client/sign_ups/sua_9/prepare_verification')).toHaveLength(1);
    expect(flow.state().errors).toEqual([]);
    expect(flow.state().attempt?.status).toBe('needs_email_verification');
    flow.destroy();
  });
});

describe('AtlasFlowController Sign in with Atlas', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the connection from /v1/appearance and starts the SSO sign-in', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { href: 'https://app.example.com/login', assign } });
    const flow = await controller({
      signInWithAtlas: { enabled: true, connection_id: 'ssoc_1' },
      routes: [
        (c) => (c.path === '/v1/client/sign_ins/sso' ? json({ authorization_url: 'https://id.example/authorize?x=1' }) : undefined),
      ],
    });
    expect(flow.settings()?.signInWithAtlas).toEqual({ connectionId: 'ssoc_1' });
    await flow.signInWithAtlas('ssoc_1');
    expect(posts('/v1/client/sign_ins/sso')[0]!.body).toMatchObject({
      connection_id: 'ssoc_1',
      redirect_url: 'https://app.example.com/login',
    });
    expect(assign).toHaveBeenCalledWith('https://id.example/authorize?x=1');
    expect(flow.signInWithAtlasError()).toBeNull();
  });

  it("keeps the server's message when it cannot start, and has no connection when the instance has it off", async () => {
    vi.stubGlobal('window', { location: { href: 'https://app.example.com/login', assign: vi.fn() } });
    const flow = await controller({
      signInWithAtlas: { enabled: false },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins/sso'
            ? json({ errors: [{ code: 'VALIDATION_FAILED', message: 'Not active.' }] }, 422)
            : undefined,
      ],
    });
    expect(flow.settings()?.signInWithAtlas).toBeUndefined();
    await flow.signInWithAtlas('ssoc_1');
    expect(flow.signInWithAtlasError()).toBe('Not active.');
  });
});
