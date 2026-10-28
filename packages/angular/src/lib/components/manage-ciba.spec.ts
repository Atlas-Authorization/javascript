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
import { afterEach, describe, expect, it } from 'vitest';
import { FapiClient } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { ManageCibaComponent } from './manage-ciba.component';
import * as api from '../../public-api';

/** `<atlas-manage-ciba>`: pending CIBA requests with Approve / Deny, and the CIBA PIN form. */
const FAPI = 'https://fapi.example';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { id: 'bcr_1', client_name: 'Acme Kiosk', scope: ['openid'], binding_message: 'Code 1234', created_at: 1, expires_at: 2 };

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

const refs: ComponentRef<unknown>[] = [];

function render<T>(component: Type<T>, atlas: object, inputs: Record<string, unknown> = {}): ComponentRef<T> {
  const injector = createEnvironmentInjector(
    [
      { provide: RendererFactory2, useClass: DomRendererFactory },
      { provide: AtlasService, useValue: atlas as AtlasService },
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

afterEach(() => {
  while (refs.length) refs.pop()!.destroy();
  document.body.innerHTML = '';
});

type Route = (url: string, init: RequestInit) => Response | undefined;
function standIn(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(String(input), init) ?? json({});
  }) as unknown as typeof fetch;
  return { calls, atlas: { appearance: undefined, createFapiClient: () => new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }) } };
}

const rendered = async (ref: ComponentRef<unknown>) => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  ref.changeDetectorRef.detectChanges();
  return ref.location.nativeElement as HTMLElement;
};
const buttonByText = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

describe('<atlas-manage-ciba>', () => {
  it('is exported and part of ATLAS_UI', () => {
    expect(api.ManageCibaComponent).toBeTypeOf('function');
    expect(api.ATLAS_UI).toContain(api.ManageCibaComponent);
  });

  it('renders nothing when there is no request, no PIN and no app that can ask', async () => {
    const { atlas } = standIn((url) => (url.endsWith('/ciba_pin') ? json({ set: false, available: false }) : json({ data: [] })));
    const el = await rendered(render(ManageCibaComponent, atlas));
    expect(el.querySelector('[data-atlas="manage-ciba"]')).toBeNull();
  });

  it('lists a request and sends the decision', async () => {
    let open = true;
    const { atlas, calls } = standIn((url, init) => {
      if (url.endsWith('/ciba_pin')) return json({ set: false, available: false });
      if (url.endsWith('/backchannel_requests')) return json({ data: open ? [REQUEST] : [] });
      if (url.endsWith('/bcr_1') && init.method === 'POST') { open = false; return json({ status: 'denied' }); }
      return undefined;
    });
    const ref = render(ManageCibaComponent, atlas);
    let el = await rendered(ref);
    expect(el.textContent).toContain('Acme Kiosk');
    buttonByText(el, 'Deny').click();
    el = await rendered(ref);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'deny' });
    expect(el.textContent).not.toContain('Acme Kiosk');
  });

  it('sets the PIN with the current password and shows a server refusal', async () => {
    const { atlas, calls } = standIn((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) return init.method === 'PUT' ? json({ errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }, 400) : json({ set: false, available: true });
      return undefined;
    });
    const ref = render(ManageCibaComponent, atlas);
    let el = await rendered(ref);
    const [pw, pin] = [...el.querySelectorAll('input')] as HTMLInputElement[];
    pw!.value = 'correct horse battery';
    pw!.dispatchEvent(new Event('input'));
    pin!.value = '12';
    pin!.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    el = await rendered(ref);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ pin: '12', current_password: 'correct horse battery' });
    expect(el.textContent).toContain('The PIN must be 6 to 12 digits.');
  });
});
