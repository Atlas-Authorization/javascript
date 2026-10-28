import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { AtlasProvider } from '@atlasauth/react';
import { Field } from './primitives';
import * as SignUp from './sign-up';
import * as SignIn from './sign-in';

/**
 * `<SignUp.Captcha>` / `<SignIn.Captcha>` draw the instance's captcha and the
 * flow sends its token as `captcha_token`: sign-up creates the account with it,
 * a CAPTCHA_FAILED refusal shows the localized message and draws a fresh widget,
 * and sign-in answers the `needs_captcha` challenge. The provider is a fake
 * Turnstile global; FAPI is a scripted fetch behind the real `AtlasProvider`.
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

function fakeTurnstile() {
  const widgets: Record<string, unknown>[] = [];
  const api = {
    render: vi.fn((_el: HTMLElement, opts: Record<string, unknown>) => {
      widgets.push(opts);
      return `w${widgets.length}`;
    }),
    remove: vi.fn(),
    execute: vi.fn(),
  };
  (window as unknown as Record<string, unknown>).turnstile = api;
  return {
    api,
    solve: (token: string) => act(() => (widgets[widgets.length - 1]!.callback as (t: string) => void)(token)),
  };
}

let calls: Call[] = [];
beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).turnstile;
  vi.unstubAllGlobals();
});

async function mount(ui: React.ReactNode, opts: { captchaFlows?: Record<string, unknown>; routes: Route[] }) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (call.path === '/v1/client') return json({ session: null, user: null });
    if (call.path === '/v1/appearance') {
      return json({ object: 'appearance', appearance: {}, captchaFlows: opts.captchaFlows ?? {} });
    }
    for (const route of opts.routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <AtlasProvider
        publishableKey="pk_test_x"
        frontendApi={FAPI}
        fetchImpl={fetchImpl}
        appearance={{ instanceDesign: false }}
      >
        {ui}
      </AtlasProvider>,
    );
  });
  return view.container as HTMLElement;
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const TURNSTILE = { enabled: true, provider: 'turnstile', siteKey: 'ts-site', widget: 'managed' };

function type(el: HTMLElement, name: string, value: string) {
  fireEvent.change(el.querySelector(`input[name="${name}"]`)!, { target: { value } });
}

const signUpUi = (
  <SignUp.Root>
    {(flow) => (
      <>
        {flow.errors.map((e) => (
          <p key={e.code} role="alert">
            {e.message}
          </p>
        ))}
        <SignUp.Step name="start">
          <Field name="email">
            <Field.Input />
          </Field>
          <Field name="password">
            <Field.Input />
          </Field>
          <SignUp.Captcha />
          <SignUp.Action action="submit">Create account</SignUp.Action>
        </SignUp.Step>
        <SignUp.Step name="verifications">
          <Field name="code">
            <Field.Input />
          </Field>
        </SignUp.Step>
      </>
    )}
  </SignUp.Root>
);

describe('<SignUp.Captcha>', () => {
  it('draws the widget; create sends its token; CAPTCHA_FAILED localizes, redraws and the NEW token is sent', async () => {
    const ts = fakeTurnstile();
    let tries = 0;
    const el = await mount(signUpUi, {
      captchaFlows: { signUp: TURNSTILE },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ups') return undefined;
          tries += 1;
          return tries === 1
            ? json({ errors: [{ code: 'CAPTCHA_FAILED', message: 'x', param: 'captcha_token' }] }, 400)
            : json({ id: 'sua_1', status: 'needs_email_verification' }, 201);
        },
      ],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    expect(ts.api.render.mock.calls[0]![1]).toMatchObject({ sitekey: 'ts-site' });

    type(el, 'email', 'new@example.com');
    type(el, 'password', 'blue tangerine anvil 71!');
    ts.solve('tok-bad');
    await act(async () => {
      fireEvent.click(el.querySelector('button')!);
    });
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(1));
    expect(posts('/v1/client/sign_ins')).toHaveLength(0);
    expect(posts('/v1/client/sign_ups')[0]!.body).toEqual({
      email: 'new@example.com',
      password: 'blue tangerine anvil 71!',
      captcha_token: 'tok-bad',
      // The SDK stamps its device id on every account-creating start.
      device_id: expect.stringMatching(/^d_/),
    });
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(
        "The security check didn't pass. Please try again.",
      ),
    );
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));

    ts.solve('tok-good');
    await act(async () => {
      fireEvent.click(el.querySelector('button')!);
    });
    await vi.waitFor(() => expect(posts('/v1/client/sign_ups')).toHaveLength(2));
    expect(posts('/v1/client/sign_ups')[1]!.body).toMatchObject({ captcha_token: 'tok-good' });
    await vi.waitFor(() => expect(el.querySelector('input[name="code"]')).not.toBeNull());
  });

  it('renders nothing when the instance has no sign-up captcha', async () => {
    const el = await mount(signUpUi, { routes: [] });
    expect(el.querySelector('[data-atlas-captcha]')).toBeNull();
  });
});

describe('<SignIn.Captcha>', () => {
  it('answers needs_captcha: draws the widget and, once solved, re-sends the identifier with the token', async () => {
    const ts = fakeTurnstile();
    const el = await mount(
      <SignIn.Root>
        <SignIn.Step name="start">
          <Field name="identifier">
            <Field.Input />
          </Field>
          <SignIn.Captcha />
          <SignIn.Action action="submit">Continue</SignIn.Action>
        </SignIn.Step>
        <SignIn.Step name="first-factor">
          <Field name="password">
            <Field.Input />
          </Field>
        </SignIn.Step>
      </SignIn.Root>,
      {
        captchaFlows: { signIn: { ...TURNSTILE, enabled: false } },
        routes: [
          (c) => {
            if (c.path !== '/v1/client/sign_ins') return undefined;
            return c.body?.captcha_token
              ? json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: [{ strategy: 'password' }] }, 201)
              : json({ id: null, status: 'needs_captcha', identifier: 'me@example.com' }, 201);
          },
        ],
      },
    );
    expect(el.querySelector('[data-atlas-captcha]')).toBeNull();
    type(el, 'identifier', 'me@example.com');
    await act(async () => {
      fireEvent.click(el.querySelector('button')!);
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));

    ts.solve('tok-si');
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins')).toHaveLength(2));
    expect(posts('/v1/client/sign_ins')[1]!.body).toEqual({
      identifier: 'me@example.com',
      captcha_token: 'tok-si',
    });
    await vi.waitFor(() => expect(el.querySelector('input[name="password"]')).not.toBeNull());
  });
});

describe('<SignIn.PasskeyButton> with a sign-in captcha', () => {
  const BEGIN = { handle: 'wa_1', challenge: 'Y2hhbA', rpId: 'example.com', allowCredentials: [], userVerification: 'preferred' };
  const stubAuthenticator = () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    const get = vi.fn(async () => ({
      rawId: new Uint8Array([1]).buffer,
      id: 'AQ',
      response: { authenticatorData: new Uint8Array([2]).buffer, clientDataJSON: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer },
    }));
    Object.defineProperty(window.navigator, 'credentials', { configurable: true, value: { get, create: vi.fn() } });
    return get;
  };
  const passkeyUi = (
    <SignIn.Root>
      {(flow) => (
        <>
          {flow.errors.map((e) => (
            <p key={e.code} role="alert">
              {e.message}
            </p>
          ))}
          <SignIn.Step name="start">
            <SignIn.Captcha />
            <SignIn.PasskeyButton>Passkey</SignIn.PasskeyButton>
          </SignIn.Step>
        </>
      )}
    </SignIn.Root>
  );
  const begins = () => posts('/v1/client/sign_ins/passkey/begin').map((c) => c.body);
  const finishRoute: Route = (c) =>
    c.path === '/v1/client/sign_ins/passkey/finish' ? json({ id: 'sia_p', status: 'needs_second_factor' }) : undefined;

  it('an always-on sign-in captcha: the begin carries the solved token', async () => {
    const ts = fakeTurnstile();
    stubAuthenticator();
    const el = await mount(passkeyUi, {
      captchaFlows: { signIn: TURNSTILE },
      routes: [(c) => (c.path === '/v1/client/sign_ins/passkey/begin' ? json(BEGIN, 201) : undefined), finishRoute],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    ts.solve('tok-pk');
    await act(async () => {
      fireEvent.click(el.querySelector('button')!);
    });
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/passkey/finish')).toHaveLength(1));
    expect(begins()).toEqual([{ captcha_token: 'tok-pk' }]);
  });

  it('a force-challenge refusal draws the challenge, then retries the begin once with its token', async () => {
    const ts = fakeTurnstile();
    stubAuthenticator();
    const el = await mount(passkeyUi, {
      captchaFlows: { signIn: { ...TURNSTILE, enabled: false } },
      routes: [
        (c) => {
          if (c.path !== '/v1/client/sign_ins/passkey/begin') return undefined;
          return c.body?.captcha_token
            ? json(BEGIN, 201)
            : json({ errors: [{ code: 'CAPTCHA_REQUIRED', message: 'x', param: 'captcha_token' }] }, 400);
        },
        finishRoute,
      ],
    });
    expect(ts.api.render).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(el.querySelector('button')!);
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    ts.solve('tok-fc');
    await vi.waitFor(() => expect(posts('/v1/client/sign_ins/passkey/finish')).toHaveLength(1));
    expect(begins()).toEqual([{}, { captcha_token: 'tok-fc' }]);
  });

  it('CAPTCHA_FAILED: one retry with a fresh token, then the localized refusal', async () => {
    const ts = fakeTurnstile();
    const get = stubAuthenticator();
    const el = await mount(passkeyUi, {
      captchaFlows: { signIn: TURNSTILE },
      routes: [
        (c) =>
          c.path === '/v1/client/sign_ins/passkey/begin'
            ? json({ errors: [{ code: 'CAPTCHA_FAILED', message: 'x', param: 'captcha_token' }] }, 400)
            : undefined,
      ],
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(1));
    ts.solve('tok-1');
    await act(async () => {
      fireEvent.click(el.querySelector('button')!);
    });
    await vi.waitFor(() => expect(ts.api.render).toHaveBeenCalledTimes(2));
    ts.solve('tok-2');
    await vi.waitFor(() => expect(begins()).toHaveLength(2));
    expect(begins()).toEqual([{ captcha_token: 'tok-1' }, { captcha_token: 'tok-2' }]);
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
    expect(get).not.toHaveBeenCalled();
  });
});
