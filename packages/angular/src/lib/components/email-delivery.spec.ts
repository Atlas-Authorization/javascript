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
import { EMAIL_UNAVAILABLE_MESSAGE, FapiClient } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { EN_US } from '../i18n';
import { AttemptFlowComponent } from './attempt-flow.component';
import { AtlasFlowController } from './flow-controller';
import { SignUpFormComponent } from './sign-up-form.component';

/**
 * `email_delivery` from `GET /v1/appearance`: an app that cannot send email
 * gets no email + password sign-up form (the `signUp.emailUnavailable` notice
 * instead) and no emailed-code option on the first-factor step. The engine is
 * the plain controller class; the two components are JIT-compiled and rendered
 * into happy-dom through a minimal DOM renderer (the package does not depend on
 * `@angular/platform-browser`), with a stand-in `AtlasService`.
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

async function controller(emailDelivery: Record<string, boolean> | undefined, routes: ((path: string) => Response | undefined)[] = []) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    if (url.pathname === '/v1/appearance') {
      return json({
        object: 'appearance',
        appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] },
        captchaFlows: {},
        ...(emailDelivery ? { email_delivery: emailDelivery } : {}),
      });
    }
    for (const route of routes) {
      const res = route(url.pathname);
      if (res) return res;
    }
    return json({});
  }) as unknown as typeof fetch;
  const flow = new AtlasFlowController(
    new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }),
    async () => undefined,
    null,
  );
  await flow.loadSettings();
  return flow;
}

const firstFactorRoute = (path: string) =>
  path === '/v1/client/sign_ins'
    ? json({ id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password', 'email_code'] }, 201)
    : undefined;

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  while (refs.length) refs.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('<atlas-sign-up-form> email delivery', () => {
  it('shows the "can\'t send email" notice and no password field when passwordSignUp is false', async () => {
    const flow = await controller({ available: false, password_reset: false, password_sign_up: false });
    expect(flow.signUpEmailUnavailable()).toBe(true);
    expect(flow.passwordResetAvailable()).toBe(false);

    const ref = render(SignUpFormComponent, { settings: flow.settings() });
    const el = ref.location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas-email-unavailable]')?.textContent?.trim()).toBe(EMAIL_UNAVAILABLE_MESSAGE);
    expect(el.querySelector('input[type="password"]')).toBeNull();
    expect(el.querySelector('input[name="email"]')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    flow.destroy();
  });

  it('renders the email + password form when the server omits email_delivery', async () => {
    const flow = await controller(undefined);
    expect(flow.settings()?.emailDelivery).toEqual({ available: true, passwordReset: true, passwordSignUp: true });
    expect(flow.signUpEmailUnavailable()).toBe(false);

    const ref = render(SignUpFormComponent, { settings: flow.settings() });
    const el = ref.location.nativeElement as HTMLElement;
    expect(el.querySelector('[data-atlas-email-unavailable]')).toBeNull();
    expect(el.querySelector('input[type="password"]')).not.toBeNull();
    expect(el.querySelector('input[name="email"]')).not.toBeNull();
    flow.destroy();
  });

  it('uses a localized signUp.emailUnavailable string', async () => {
    const flow = await controller({ available: false, password_reset: false, password_sign_up: false });
    const stub = atlasStub as unknown as { localization: Record<string, string> };
    stub.localization = { ...EN_US, 'signUp.emailUnavailable': 'E-Mail ist nicht verfügbar.' };
    try {
      const ref = render(SignUpFormComponent, { settings: flow.settings() });
      const el = ref.location.nativeElement as HTMLElement;
      expect(el.querySelector('[data-atlas-email-unavailable]')?.textContent?.trim()).toBe('E-Mail ist nicht verfügbar.');
    } finally {
      stub.localization = EN_US;
      flow.destroy();
    }
  });
});

describe('first-factor choice and email delivery', () => {
  it('hides email_code from the strategy choice when email is not available', async () => {
    const flow = await controller({ available: false, password_reset: false, password_sign_up: false }, [firstFactorRoute]);
    await flow.submit({ identifier: 'me@example.com' });
    expect(flow.state().attempt?.status).toBe('needs_first_factor');
    expect(flow.firstFactors()).toEqual(['password']);

    const ref = render(AttemptFlowComponent, {
      attempt: flow.state().attempt,
      firstFactors: flow.firstFactors(),
      preparedFactor: flow.preparedFactor(),
    });
    const el = ref.location.nativeElement as HTMLElement;
    expect(el.querySelector('input[type="password"]')).not.toBeNull();
    expect(el.textContent).not.toContain(EN_US['signIn.useEmailCode']);

    // Nor can it be prepared.
    await flow.prepare('email_code');
    expect(calls.some((c) => c.path.endsWith('/prepare_first_factor'))).toBe(false);
    flow.destroy();
  });

  it('offers the emailed code when email is available, and collects the code once it is sent', async () => {
    const flow = await controller({ available: true, password_reset: true, password_sign_up: true }, [
      firstFactorRoute,
      (path) => (path === '/v1/client/sign_ins/sia_1/prepare_first_factor' ? json({ status: 'needs_first_factor' }) : undefined),
    ]);
    await flow.submit({ identifier: 'me@example.com' });
    expect(flow.firstFactors()).toEqual(['password', 'email_code']);

    const ref = render(AttemptFlowComponent, {
      attempt: flow.state().attempt,
      firstFactors: flow.firstFactors(),
      preparedFactor: flow.preparedFactor(),
    });
    const el = ref.location.nativeElement as HTMLElement;
    const option = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === EN_US['signIn.useEmailCode'],
    );
    expect(option).toBeDefined();
    const chosen: string[] = [];
    ref.instance.chooseFactor.subscribe((s) => chosen.push(s));
    option!.click();
    expect(chosen).toEqual(['email_code']);

    await flow.prepare('email_code');
    expect(calls.find((c) => c.path === '/v1/client/sign_ins/sia_1/prepare_first_factor')?.body).toEqual({
      strategy: 'email_code',
    });
    expect(flow.preparedFactor()).toBe('email_code');
    ref.setInput('preparedFactor', flow.preparedFactor());
    ref.changeDetectorRef.detectChanges();
    expect(el.querySelector('input[name="code"]')).not.toBeNull();
    expect(el.querySelector('input[type="password"]')).toBeNull();
    flow.destroy();
  });
});
