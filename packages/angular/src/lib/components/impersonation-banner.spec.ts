// @vitest-environment happy-dom
import '@angular/compiler';
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
import type { EndImpersonationResult } from '@atlasauth/js';
import { ATLAS_OPTIONS } from '../atlas.config';
import { AtlasService } from '../atlas.service';
import { ImpersonationBannerComponent } from './impersonation-banner.component';

/**
 * `<atlas-impersonation-banner>`, driven through a real `AtlasService` with a
 * scripted fetch: it shows only on an impersonation session, and "Return to
 * admin" ends it and adopts the impersonator's own session.
 */

const FAPI = 'https://fapi.example';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
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
  document.body.innerHTML = '';
});

async function mount(actorSessionId: string | null, impersonating = true) {
  let state: 'imp' | 'admin' | 'out' = impersonating ? 'imp' : 'admin';
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/v1/client')) {
      if (state === 'out') return json({ session: null, user: null });
      if (state === 'imp')
        return json({
          session: { id: 'sess_imp', status: 'active', actor: { sub: 'user_admin' }, actor_session_id: actorSessionId },
          user: { id: 'user_t', first_name: 'Tess', last_name: null },
          jwt: jwt({ sid: 'sess_imp', sub: 'user_t', act: { sub: 'user_admin' } }),
        });
      return json({
        session: { id: 'sess_admin', status: 'active' },
        user: { id: 'user_admin', first_name: 'Ada', last_name: null },
        jwt: jwt({ sid: 'sess_admin', sub: 'user_admin' }),
      });
    }
    if (url.endsWith('/sessions/sess_imp/end_impersonation')) {
      if (actorSessionId) {
        state = 'admin';
        return json({ resumed: true, active_session_id: 'sess_admin', jwt: jwt({ sid: 'sess_admin', sub: 'user_admin' }) });
      }
      state = 'out';
      return json({ resumed: false });
    }
    return json({});
  }) as unknown as typeof fetch;

  const base = Injector.create({
    providers: [
      {
        provide: ATLAS_OPTIONS,
        useValue: { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, appearance: { instanceDesign: false } },
      },
      { provide: PLATFORM_ID, useValue: 'browser' },
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
  const ref: ComponentRef<ImpersonationBannerComponent> = createComponent(ImpersonationBannerComponent, {
    environmentInjector: injector,
    hostElement: host,
  });
  const ended: EndImpersonationResult[] = [];
  ref.instance.ended.subscribe((r) => ended.push(r));
  ref.changeDetectorRef.detectChanges();
  teardown.push(() => {
    ref.destroy();
    atlas.ngOnDestroy();
  });
  const el = ref.location.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    ref.changeDetectorRef.detectChanges();
  };
  return { el, calls, ended, settle };
}

describe('<atlas-impersonation-banner>', () => {
  it('renders nothing on an ordinary session', async () => {
    const { el } = await mount(null, false);
    expect(el.querySelector('.atlas-impersonation-banner')).toBeNull();
  });

  it('returns to the admin session', async () => {
    const { el, calls, ended, settle } = await mount('sess_admin');
    const banner = el.querySelector('.atlas-impersonation-banner');
    expect(banner?.textContent).toContain('Tess');
    const button = banner!.querySelector('button')!;
    expect(button.textContent?.trim()).toBe('Return to admin');
    button.click();
    await settle();
    expect(calls).toContain(`POST ${FAPI}/v1/client/sessions/sess_imp/end_impersonation`);
    expect(ended[0]).toMatchObject({ ended: true, resumed: true, activeSessionId: 'sess_admin' });
    expect(el.querySelector('.atlas-impersonation-banner')).toBeNull();
  });

  it('"End impersonation" signs out when there is nothing to return to', async () => {
    const { el, ended, settle } = await mount(null);
    const button = el.querySelector('.atlas-impersonation-banner button') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('End impersonation');
    button.click();
    await settle();
    expect(ended[0]).toMatchObject({ ended: true, resumed: false });
    expect(el.querySelector('.atlas-impersonation-banner')).toBeNull();
  });
});
