// @vitest-environment happy-dom
import '@angular/compiler';
import * as ng from '@angular/core';
import {
  Injector,
  PLATFORM_ID,
  RendererFactory2,
  createComponent,
  createEnvironmentInjector,
  runInInjectionContext,
  type ComponentRef,
  type EnvironmentInjector,
  type Renderer2,
  type RendererType2,
} from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATLAS_OPTIONS } from '../atlas.config';
import { AtlasService } from '../atlas.service';
import { OrganizationSwitcherComponent } from './organization-switcher.component';

/** `<atlas-organization-switcher>`: a refused activation (org_mfa_step_up_required) prompts, steps up, retries. */

const FAPI = 'https://fapi.example';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
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

const teardown: (() => void)[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  while (teardown.length) teardown.pop()!();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});


async function mount(allowedFactors: string[]) {
  const calls: { url: string; body: unknown }[] = [];
  let touches = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
        user: { id: 'user_1', first_name: 'Me' },
        jwt: jwt({ sub: 'user_1' }),
        organization_memberships: [{ role: 'org:admin', organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } }],
      });
    }
    if (url.endsWith('/touch')) {
      // The first activation is refused until the step-up has happened.
      if (touches++ === 0) {
        return json({ errors: [{ code: 'STEP_UP_REQUIRED', reason: 'org_mfa_step_up_required', message: 'Step up', meta: { allowed_factors: allowedFactors } }] }, 403);
      }
      return json({ jwt: jwt({ sub: 'user_1', org_id: 'org_1' }) });
    }
    return json({ object: 'client', stepped_up: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('PublicKeyCredential', class {});
  const base = Injector.create({
    providers: [
      {
        provide: ATLAS_OPTIONS,
        useValue: { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, appearance: { instanceDesign: false } },
      },
      { provide: PLATFORM_ID, useValue: 'browser' },
      // A root-scoped injector, as an application's is: the component's
      // effect() resolves its scheduler from a `providedIn: 'root'` token.
      { provide: (ng as unknown as Record<string, unknown>)['ɵINJECTOR_SCOPE'] as ng.InjectionToken<string>, useValue: 'root' },
    ],
  });
  const atlas = runInInjectionContext(base, () => new AtlasService());
  await atlas.reload();

  const injector = createEnvironmentInjector(
    [
      { provide: RendererFactory2, useClass: DomRendererFactory },
      { provide: AtlasService, useValue: atlas },
    ],
    base as unknown as EnvironmentInjector,
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ref: ComponentRef<OrganizationSwitcherComponent> = createComponent(OrganizationSwitcherComponent, {
    environmentInjector: injector,
    hostElement: host,
  });
  teardown.push(() => {
    ref.destroy();
    atlas.ngOnDestroy();
  });
  const el = ref.location.nativeElement as HTMLElement;
  const settle = async () => {
    for (let round = 0; round < 3; round++) {
      ref.changeDetectorRef.detectChanges();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    }
    ref.changeDetectorRef.detectChanges();
  };
  await settle();
  const acme = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Acme')!;
  acme.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  return { el, calls, settle };
}

describe('<atlas-organization-switcher> step-up', () => {
  it('prompts for a code, steps up, then retries the activation; the passkey button shows only when allowed', async () => {
    const { el, calls, settle } = await mount(['totp', 'passkey']);
    const dialog = el.querySelector('[data-atlas="organization-step-up"]')!;
    expect(dialog).not.toBeNull();
    // code submit + passkey + cancel
    expect(dialog.querySelectorAll('button')).toHaveLength(3);

    const input = dialog.querySelector('input')!;
    input.value = '123456';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(calls.find((c) => c.url === `${FAPI}/v1/client/me/step_up`)?.body).toEqual({ strategy: 'totp', code: '123456' });
    expect(calls.filter((c) => c.url.endsWith('/touch'))).toHaveLength(2);
    expect(el.querySelector('[data-atlas="organization-step-up"]')).toBeNull();
  });

  it('hides the passkey button when only totp is allowed', async () => {
    const { el } = await mount(['totp']);
    expect(el.querySelector('[data-atlas="organization-step-up"]')!.querySelectorAll('button')).toHaveLength(2);
  });
});
