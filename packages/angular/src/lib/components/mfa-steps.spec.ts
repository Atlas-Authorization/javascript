// @vitest-environment happy-dom
import '@angular/compiler';
import {
  Injector,
  RendererFactory2,
  createComponent,
  createEnvironmentInjector,
  type ComponentRef,
  type EnvironmentInjector,
  type Renderer2,
  type RendererType2,
  type Type,
} from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { EN_US } from '../i18n';
import { AttemptFlowComponent } from './attempt-flow.component';
import { EmailLinkComponent } from './email-link.component';
import { AtlasFlowController } from './flow-controller';
import { RecoveryCodesComponent } from './recovery-codes.component';

/**
 * The sign-in's MFA steps: the controller starts the enrolment step for a
 * `needs_mfa_enrollment` attempt (authenticator app with its QR code, or a
 * texted code where the app can text) and texts a second-factor code on
 * request; `<atlas-attempt-flow>` draws them. JIT-compiled and rendered into
 * happy-dom through a minimal DOM renderer, with a stand-in `AtlasService`.
 */

const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The handful of Renderer2 calls a rendered template makes, straight onto the DOM. */
class DomRenderer {
  readonly data: Record<string, unknown> = {};
  destroyNode = null;
  destroy(): void {}
  createElement(name: string, namespace?: string | null): Element {
    return namespace
      ? document.createElementNS(namespace === 'svg' ? 'http://www.w3.org/2000/svg' : namespace, name)
      : document.createElement(name);
  }
  createComment(value: string): Comment {
    return document.createComment(value);
  }
  createText(value: string): Text {
    return document.createTextNode(value);
  }
  appendChild(parent: Node, child: Node): void {
    parent.appendChild(child);
  }
  insertBefore(parent: Node, child: Node, ref: Node | null): void {
    parent.insertBefore(child, ref);
  }
  removeChild(parent: Node | null, child: Node): void {
    (parent ?? child.parentNode)?.removeChild(child);
  }
  selectRootElement(selectorOrNode: string | Element): Element {
    return typeof selectorOrNode === 'string' ? document.querySelector(selectorOrNode)! : selectorOrNode;
  }
  parentNode(node: Node): Node | null {
    return node.parentNode;
  }
  nextSibling(node: Node): Node | null {
    return node.nextSibling;
  }
  setAttribute(el: Element, name: string, value: string): void {
    el.setAttribute(name, value);
  }
  removeAttribute(el: Element, name: string): void {
    el.removeAttribute(name);
  }
  addClass(el: Element, name: string): void {
    el.classList.add(name);
  }
  removeClass(el: Element, name: string): void {
    el.classList.remove(name);
  }
  setStyle(el: HTMLElement, style: string, value: string): void {
    el.style.setProperty(style, value);
  }
  removeStyle(el: HTMLElement, style: string): void {
    el.style.removeProperty(style);
  }
  setProperty(el: Record<string, unknown>, name: string, value: unknown): void {
    el[name] = value;
  }
  setValue(node: Node, value: string): void {
    node.nodeValue = value;
  }
  listen(target: EventTarget, event: string, callback: (e: Event) => boolean | void): () => void {
    const handler = (e: Event) => void callback(e);
    target.addEventListener(event, handler);
    return () => target.removeEventListener(event, handler);
  }
}

class DomRendererFactory {
  private readonly renderer = new DomRenderer();
  createRenderer(_host: unknown, _type: RendererType2 | null): Renderer2 {
    return this.renderer as unknown as Renderer2;
  }
  begin(): void {}
  end(): void {}
}

const atlasStub = { localization: EN_US, appearance: undefined } as unknown as AtlasService;
const refs: ComponentRef<unknown>[] = [];

function render<T>(component: Type<T>, inputs: Record<string, unknown>): ComponentRef<T> {
  // An environment-scoped injector, as an application's is: standalone
  // components resolve their imports through it.
  const injector = createEnvironmentInjector(
    [
      { provide: RendererFactory2, useClass: DomRendererFactory },
      { provide: AtlasService, useValue: atlasStub },
    ],
    Injector.create({ providers: [] }) as unknown as EnvironmentInjector,
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ref = createComponent(component, { environmentInjector: injector, hostElement: host });
  for (const [name, value] of Object.entries(inputs)) ref.setInput(name, value);
  ref.changeDetectorRef.detectChanges();
  refs.push(ref);
  return ref;
}

let calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];

const TOTP_SETUP = { object: 'mfa_enrollment', strategy: 'totp', factor_id: 'mfa_t', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x', qr_code: 'data:image/gif;base64,R0lG' };
const SMS_ACCOUNT = { username: null, email_verification: 'code', password_reset: 'code', mfa: { totp: true, sms: true, totp_codes: 1 } };

let factorsHeld = ['sms', 'totp', 'passkey'];
let prepareAnswer: (() => Response) | null = null;
async function controller(status: string, account?: Record<string, unknown>, backupCodes: string[] = []) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    switch (url.pathname) {
      case '/v1/appearance':
        return json({ object: 'appearance', appearance: { signUpFields: [] }, captchaFlows: {}, ...(account ? { account } : {}) });
      case '/v1/client/sign_ins':
        return json({ id: 'sia_1', status }, 201);
      case '/v1/client/sign_ins/sia_1/prepare_mfa_enrollment':
        return json(body?.strategy === 'phone_code' ? { object: 'mfa_enrollment', strategy: 'phone_code', factor_id: 'mfa_s', phone: '+1•••0101' } : TOTP_SETUP, 201);
      case '/v1/client/sign_ins/sia_1/attempt_mfa_enrollment':
        return json({ id: 'sia_1', status: 'complete', ticket: 'tkt_e', backup_codes: backupCodes });
      case '/v1/client/sign_ins/sia_1/prepare_second_factor':
        if (prepareAnswer) return prepareAnswer();
        return json({ object: 'second_factor_challenge', strategy: body?.strategy, sent_to: '+1•••0101' }, 201);
      case '/v1/client/sign_ins/sia_1/second_factors':
        return json({ object: 'second_factors', factors: factorsHeld });
      default:
        return json({});
    }
  }) as unknown as typeof fetch;
  const flow = new AtlasFlowController(new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }), async () => true, null);
  await flow.loadSettings();
  await flow.submit({ identifier: 'ada@example.com' });
  return flow;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

/** `<atlas-attempt-flow>` bound to the controller the way `<atlas-sign-in>` binds it. */
function draw(flow: AtlasFlowController) {
  return render(AttemptFlowComponent, {
    attempt: flow.state().attempt,
    busy: flow.state().busy,
    errors: flow.state().errors,
    enrollment: flow.enrollment,
    enrollmentState: flow.enrollmentState(),
    offerSmsSecondFactor: flow.mfaChoices().sms,
    textedSecondFactor: flow.smsSecondFactor(),
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  while (refs.length) refs.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('MFA enrolment mid-sign-in', () => {
  it('offers every factor the app offers; a YubiKey posts its OTP', async () => {
    const flow = await controller('needs_mfa_enrollment', { ...SMS_ACCOUNT, mfa: { totp: true, sms: false, totp_codes: 1, hotp: true, yubikey: true, duo: true } });
    await settle();
    let el = draw(flow).location.nativeElement as HTMLElement;
    for (const m of ['totp', 'hotp', 'yubikey', 'duo']) expect(el.querySelector(`[data-atlas-mfa-method="${m}"]`)).not.toBeNull();
    await flow.enrollment.choose('yubikey');
    refs.pop()!.destroy();
    el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('input[name="otp"]')).not.toBeNull();
    const values = await flow.enrollment.submit({ otp: 'ccccccfjkbbb' });
    await flow.submit(values!);
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ strategy: 'yubikey', otp: 'ccccccfjkbbb' });
    flow.destroy();
  });

  it('the waiting tab shows the code from a mailed link', () => {
    const ref = render(AttemptFlowComponent, {
      attempt: { id: 'sia_l', object: 'sign_up_attempt', status: 'needs_email_verification', identifier: 'l@example.com' },
      busy: false,
      errors: [],
      emailVerification: 'link',
      matchCode: '482113',
    });
    expect((ref.location.nativeElement as HTMLElement).querySelector('[data-atlas="link-match-code"]')!.textContent).toContain('482113');
  });

  it('authenticator app only: the setup is fetched at once and drawn with its QR code and setup key', async () => {
    const flow = await controller('needs_mfa_enrollment');
    await settle();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')[0]!.body).toEqual({ strategy: 'totp' });
    const el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas="mfa-qr"]')!.getAttribute('src')).toBe(TOTP_SETUP.qr_code);
    expect(el.querySelector('[data-atlas="mfa-setup-key"]')!.textContent).toContain('JBSW Y3DP EHPK 3PXP');
    expect(el.querySelector('input[name="secondCode"]')).not.toBeNull();
    expect(el.querySelector('[data-atlas-mfa-method="phone_code"]')).toBeNull();

    const values = await flow.enrollment.submit({ code: '111111', secondCode: '222222' });
    await flow.submit(values!);
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ factor_id: 'mfa_t', codes: ['111111', '222222'] });
    expect(flow.state().attempt?.status).toBe('complete');
    flow.destroy();
  });

  it('where the app can text: a method choice, then the number, then the texted code', async () => {
    const flow = await controller('needs_mfa_enrollment', SMS_ACCOUNT);
    await settle();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')).toHaveLength(0);
    let el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas-mfa-method="totp"]')).not.toBeNull();
    expect(el.querySelector('[data-atlas-mfa-method="phone_code"]')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')).toBeNull();

    await flow.enrollment.choose('phone_code');
    refs.pop()!.destroy();
    el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('input[name="phone"]')!.getAttribute('type')).toBe('tel');
    expect(el.querySelector('button[type="submit"]')!.textContent).toContain('Text me a code');

    expect(await flow.enrollment.submit({ phone: '+14155550101' })).toBeNull();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_mfa_enrollment')[0]!.body).toEqual({ strategy: 'phone_code', phone: '+14155550101' });
    refs.pop()!.destroy();
    el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas="mfa-code-texted"]')!.textContent).toContain('+1•••0101');

    await flow.submit((await flow.enrollment.submit({ code: '654321' }))!);
    expect(posts('/v1/client/sign_ins/sia_1/attempt_mfa_enrollment')[0]!.body).toEqual({ factor_id: 'mfa_s', code: '654321' });
    flow.destroy();
  });
});

describe('recovery codes after enrolment', () => {
  it('redeems the ticket while the codes are shown (copy, download as .txt), and finishes on "I\'ve saved my codes"', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:codes');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const flow = await controller('needs_mfa_enrollment', undefined, ['aaaa-1111', 'bbbb-2222']);
    await settle();
    await flow.submit((await flow.enrollment.submit({ code: '111111', secondCode: '222222' }))!);
    expect(flow.state().attempt?.status).toBe('complete');
    expect(flow.recoveryCodes()).toEqual(['aaaa-1111', 'bbbb-2222']);
    expect(flow.state().attempt).not.toHaveProperty('backup_codes');
    // Redeemed while they show: the ticket dies in 60 seconds. The app hears on the save.
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
    expect(flow.state().sessionKept).toBeUndefined();

    const ref = render(RecoveryCodesComponent, { codes: flow.recoveryCodes(), busy: false });
    let saved = 0;
    ref.instance.saved.subscribe(() => (saved += 1));
    const el = ref.location.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('[data-atlas="recovery-codes-list"] li')].map((li) => li.textContent)).toEqual(['aaaa-1111', 'bbbb-2222']);

    (el.querySelector('[data-atlas="recovery-codes-copy"]') as HTMLButtonElement).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('aaaa-1111\nbbbb-2222');
    ref.changeDetectorRef.detectChanges();
    expect(el.querySelector('[data-atlas="recovery-codes-copied"]')).not.toBeNull();
    (el.querySelector('[data-atlas="recovery-codes-download"]') as HTMLButtonElement).click();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    (el.querySelector('[data-atlas="recovery-codes-saved"]') as HTMLButtonElement).click();
    expect(saved).toBe(1);

    await flow.saveRecoveryCodes();
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
    expect(posts('/v1/client/tickets/exchange')[0]!.body).toMatchObject({ attempt_id: 'sia_1', ticket: 'tkt_e' });
    expect(flow.recoveryCodes()).toBeNull();
    expect(flow.state().sessionKept).toBe(true);
    flow.destroy();
    vi.restoreAllMocks();
  });

  it('a completion with no codes finishes straight away', async () => {
    const flow = await controller('needs_mfa_enrollment');
    await settle();
    await flow.submit((await flow.enrollment.submit({ code: '111111', secondCode: '222222' }))!);
    expect(flow.recoveryCodes()).toBeNull();
    expect(posts('/v1/client/tickets/exchange')).toHaveLength(1);
    flow.destroy();
  });
});

describe('texted second factor', () => {
  it('sendSmsSecondFactor() texts the code and the step says where it went', async () => {
    const flow = await controller('needs_second_factor', SMS_ACCOUNT);
    let el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas="sms-second-factor"]')).not.toBeNull();
    await flow.sendSmsSecondFactor();
    expect(posts('/v1/client/sign_ins/sia_1/prepare_second_factor').at(-1)!.body).toEqual({ strategy: 'sms' });
    refs.pop()!.destroy();
    el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas="sms-second-factor-sent"]')!.textContent).toContain('+1•••0101');
    flow.destroy();
  });

  it('offers a resend after a send, and says how long a limited send must wait', async () => {
    const flow = await controller('needs_second_factor', SMS_ACCOUNT);
    await flow.sendSmsSecondFactor();
    let el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas="sms-second-factor-resend"]')!.textContent).toContain('Resend code');
    prepareAnswer = () => json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.', meta: { retry_after: 30 } }] }, 429);
    await flow.sendSmsSecondFactor();
    prepareAnswer = null;
    refs.pop()!.destroy();
    el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.textContent).toContain('another code in 30 seconds');
    expect(el.querySelector('[data-atlas="sms-second-factor-sent"]')).not.toBeNull();
    flow.destroy();
  });

  it('hides what the account lacks', async () => {
    factorsHeld = ['totp'];
    const flow = await controller('needs_second_factor', SMS_ACCOUNT);
    await vi.waitFor(() => expect(flow.lacks('sms')).toBe(true));
    expect(flow.lacks('passkey')).toBe(true);
    factorsHeld = ['sms', 'totp', 'passkey'];
    flow.destroy();
  });

  it('is not offered where the app has not said it can text', async () => {
    const flow = await controller('needs_second_factor');
    const el = draw(flow).location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas="sms-second-factor"]')).toBeNull();
    flow.destroy();
  });
});

describe('<atlas-email-link>', () => {
  const stub = atlasStub as unknown as { createFapiClient?: () => FapiClient };
  afterEach(() => {
    delete stub.createFapiClient;
    window.localStorage.clear();
  });
  const client = (confirm: unknown) => () =>
    new FapiClient({
      publishableKey: 'pk_test_x',
      baseUrl: FAPI,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
        return json(url.pathname.endsWith('/confirm') ? confirm : { requires_confirmation: true });
      }) as typeof fetch,
    });

  it('with nothing stored, asks for the typed code and confirms with it', async () => {
    stub.createFapiClient = client({ verified: true });
    const ref = render(EmailLinkComponent, { link: { attempt: 'sia_l', token: 'tok', flow: 'sign_up' } });
    await settle();
    ref.changeDetectorRef.detectChanges();
    const el = ref.location.nativeElement as HTMLElement;
    const input = el.querySelector('input[name="match_code"]') as HTMLInputElement;
    input.value = '482113';
    input.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    ref.changeDetectorRef.detectChanges();
    expect(el.querySelector('[data-atlas-status="confirmed"]')).not.toBeNull();
    expect(posts('/v1/client/sign_ups/verify/confirm')[0]!.body).toEqual({ attempt: 'sia_l', token: 'tok', match_code: '482113' });
  });

  it('with the secret stored, confirms with no typing', async () => {
    stub.createFapiClient = client({ verified: true });
    window.localStorage.setItem('atlas_link_sia_s', 'ps_s');
    const ref = render(EmailLinkComponent, { link: { attempt: 'sia_s', token: 'tok', flow: 'sign_in' } });
    await settle();
    ref.changeDetectorRef.detectChanges();
    const el = ref.location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas-status="confirmed"]')).not.toBeNull();
    expect(el.querySelector('input[name="match_code"]')).toBeNull();
    expect(posts('/v1/client/sign_ins/verify/confirm')[0]!.body).toEqual({ attempt: 'sia_s', token: 'tok', poll_secret: 'ps_s' });
  });
});
