// @vitest-environment happy-dom
import '@angular/compiler';
import {
  Injector,
  RendererFactory2,
  createComponent,
  createEnvironmentInjector,
  signal,
  type ComponentRef,
  type EnvironmentInjector,
  type Renderer2,
  type RendererType2,
  type Type,
} from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { FapiClient, type OrganizationAuditLogOptions } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { AtlasOrganizationAuditLog } from './organization-audit-log';
import { OrganizationAuditLogComponent } from './organization-audit-log.component';
import * as api from '../../public-api';
import type { AtlasOrganizationMembership } from '../types';

/**
 * The engine behind `<atlas-organization-audit-log>` and
 * `AtlasService.organizationAuditLog()`: pages through the active organization's
 * audit trail against a scripted Frontend API, follows the active organization,
 * and reports a member who may not read it. The component is rendered into
 * happy-dom through the same minimal DOM renderer as the error-reasons spec,
 * with a stand-in `AtlasService`.
 */
const FAPI = 'https://fapi.example';
const membership = (id: string): AtlasOrganizationMembership => ({
  role: 'org:admin',
  organization: { id, name: id, slug: id, image_url: null },
});
const entry = (id: string) => ({
  object: 'audit_log',
  id,
  action: 'organization_membership.created',
  actor: { type: 'user', id: 'user_1' },
  target: { type: null, id: null },
  organization_id: 'org_1',
  ip: null,
  user_agent: null,
  metadata: {},
  created_at: 1_700_000_000_000,
});

function scripted(handler: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { urls, client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: FAPI, fetchImpl }) };
}

const settle = async (log: AtlasOrganizationAuditLog) => {
  for (let i = 0; i < 20 && log.state().loading; i++) await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe('AtlasOrganizationAuditLog', () => {
  it('is exported with its component', () => {
    expect(api.OrganizationAuditLogComponent).toBeTypeOf('function');
    expect(api.AtlasOrganizationAuditLog).toBeTypeOf('function');
    expect(api.ATLAS_UI).toContain(api.OrganizationAuditLogComponent);
  });

  it("pages through the active organization's log", async () => {
    const { urls, client } = scripted((url) =>
      url.includes('starting_after')
        ? { status: 200, body: { data: [entry('aud_3')], has_more: false, next_cursor: null } }
        : { status: 200, body: { data: [entry('aud_1'), entry('aud_2')], has_more: true, next_cursor: 'aud_2' } },
    );
    const log = new AtlasOrganizationAuditLog(client, new BehaviorSubject(membership('org_1')), { pageSize: 2 });
    await settle(log);
    expect(urls[0]).toBe(`${FAPI}/v1/client/organizations/org_1/audit_logs?limit=2`);
    expect(log.state()).toMatchObject({ hasMore: true, forbidden: false });
    await log.loadMore();
    expect(log.state().entries.map((e) => e.id)).toEqual(['aud_1', 'aud_2', 'aud_3']);
    expect(urls[1]).toContain('starting_after=aud_2');
    log.destroy();
  });

  it('follows the active organization until destroyed', async () => {
    const { urls, client } = scripted(() => ({ status: 200, body: { data: [], has_more: false, next_cursor: null } }));
    const org$ = new BehaviorSubject<AtlasOrganizationMembership | null>(membership('org_1'));
    const log = new AtlasOrganizationAuditLog(client, org$);
    await settle(log);
    org$.next(membership('org_1')); // same organization: no refetch
    org$.next(membership('org_2'));
    await settle(log);
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      '/v1/client/organizations/org_1/audit_logs',
      '/v1/client/organizations/org_2/audit_logs',
    ]);
    log.destroy();
    org$.next(membership('org_3'));
    await settle(log);
    expect(urls).toHaveLength(2);
  });

  it('reports a member who may not read it', async () => {
    const { client } = scripted(() => ({ status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'no' }] } }));
    const log = new AtlasOrganizationAuditLog(client, new BehaviorSubject(membership('org_1')));
    await settle(log);
    expect(log.state().forbidden).toBe(true);
    log.destroy();
  });
});

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

/** A stand-in AtlasService: the active organization and the audit-log engine over a scripted FAPI. */
function standIn(handler: (url: string) => { status: number; body: unknown }, active = membership('org_1')) {
  const { urls, client } = scripted(handler);
  const org$ = new BehaviorSubject<AtlasOrganizationMembership | null>(active);
  return {
    urls,
    atlas: {
      appearance: undefined,
      organization: signal<AtlasOrganizationMembership | null>(active),
      organizationAuditLog: (options: OrganizationAuditLogOptions) => new AtlasOrganizationAuditLog(client, org$, options),
    },
  };
}

const rendered = async (ref: ComponentRef<unknown>) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  ref.changeDetectorRef.detectChanges();
  return ref.location.nativeElement as HTMLElement;
};

describe('<atlas-organization-audit-log>', () => {
  it('lists the entries and pages with Load more', async () => {
    const { urls, atlas } = standIn((url) =>
      url.includes('starting_after')
        ? { status: 200, body: { data: [entry('aud_3')], has_more: false, next_cursor: null } }
        : { status: 200, body: { data: [entry('aud_1'), entry('aud_2')], has_more: true, next_cursor: 'aud_2' } },
    );
    const ref = render(OrganizationAuditLogComponent, atlas, { pageSize: 2, labels: { title: 'Activity' } });
    let el = await rendered(ref);
    expect(urls[0]).toBe(`${FAPI}/v1/client/organizations/org_1/audit_logs?limit=2`);
    expect(el.querySelector('h2')?.textContent).toBe('Activity');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('li strong')?.textContent).toBe('Organization membership created');
    (el.querySelector('button') as HTMLButtonElement).click();
    el = await rendered(ref);
    expect(el.querySelectorAll('li')).toHaveLength(3);
    expect(el.querySelector('button')).toBeNull();
  });

  it('renders nothing for a member who may not read the log', async () => {
    const { atlas } = standIn(() => ({ status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'no' }] } }));
    const el = await rendered(render(OrganizationAuditLogComponent, atlas));
    expect(el.querySelector('[data-atlas="organization-audit-log"]')).toBeNull();
  });

  it('shows the empty state for an organization with no activity', async () => {
    const { atlas } = standIn(() => ({ status: 200, body: { data: [], has_more: false, next_cursor: null } }));
    const el = await rendered(render(OrganizationAuditLogComponent, atlas));
    expect(el.querySelector('p')?.textContent).toBe('No activity recorded yet.');
  });
});
