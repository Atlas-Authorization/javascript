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
import { OrganizationProfileComponent } from './organization-profile.component';

/**
 * `<atlas-organization-profile>` against a scripted Frontend API, through a
 * real `AtlasService`: members (role change, remove), invitations (invite,
 * revoke, resend), settings (leave) and the organization's own custom roles
 * (create, edit, delete). Admin controls appear only with the members-manage
 * permission on the token.
 */

const FAPI = 'https://fapi.example';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ADMIN = { sub: 'user_1', org_id: 'org_1', org_role: 'org:admin', org_permissions: ['org:sys_memberships:manage', 'org:sys_memberships:read'] };
const MEMBER = { sub: 'user_2', org_id: 'org_1', org_role: 'org:member', org_permissions: ['org:sys_memberships:read'] };

const MEMBERS = [
  { object: 'organization_membership', id: 'm1', role: 'org:admin', user: { id: 'user_1', first_name: 'Me', last_name: null, image_url: null } },
  { object: 'organization_membership', id: 'm2', role: 'org:member', user: { id: 'user_2', first_name: 'Bo', last_name: 'Lee', image_url: null } },
];
const ROLES = [
  { object: 'role', key: 'org:admin', name: 'Admin', description: null, organization_id: null },
  { object: 'role', key: 'org:member', name: 'Member', description: null, organization_id: null },
  { object: 'role', id: 'role_aud', key: 'org:auditor', name: 'Auditor', description: null, organization_id: 'org_1', permissions: ['org:sys_memberships:read'] },
];
const PERMISSIONS = [
  { object: 'permission', key: 'org:sys_memberships:read', name: 'Read members', description: null },
  { object: 'permission', key: 'org:sys_memberships:manage', name: 'Manage members', description: null },
];
const INVITE = { object: 'organization_invitation', id: 'inv_1', email_address: 'x@y.co', role: 'org:member', status: 'pending' };

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

async function mount(claims: Record<string, unknown>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: 'org_1' },
        user: { id: claims.sub, first_name: 'Me' },
        jwt: jwt(claims),
        organization_memberships: [
          { role: claims.org_role, organization: { id: 'org_1', name: 'Acme', slug: 'acme', image_url: null } },
        ],
      });
    }
    if (url.includes('/memberships?')) return json({ object: 'list', data: MEMBERS, total_count: 2, has_more: false });
    if (method === 'GET' && url.endsWith('/roles')) return json({ object: 'list', data: ROLES, has_more: false });
    if (url.endsWith('/permissions')) return json({ object: 'list', data: PERMISSIONS, has_more: false });
    if (url.includes('/invitations?')) return json({ object: 'list', data: [INVITE], has_more: false });
    if (method === 'POST' && url.endsWith('/invitations')) return json({ ...INVITE, id: 'inv_2' }, 201);
    if (method === 'POST' && url.endsWith('/roles')) return json({ object: 'role', id: 'role_new', key: 'org:viewer', name: 'Viewer' }, 201);
    return json({ ok: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);

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
  const ref: ComponentRef<OrganizationProfileComponent> = createComponent(OrganizationProfileComponent, {
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
  return { el, calls, settle };
}

const button = (el: HTMLElement, label: string) => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${el.innerHTML}`);
  return found;
};
const typeInto = (input: Element | null, value: string) => {
  (input as HTMLInputElement).value = value;
  input!.dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = (form: Element | null) => form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

describe('<atlas-organization-profile>', () => {
  it('an admin changes a role and removes a member (never themselves); custom roles are in the picker', async () => {
    const { el, calls, settle } = await mount(ADMIN);
    const rows = el.querySelectorAll('[data-atlas="organization-member"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('select')).toBeNull();
    const select = rows[1]!.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('org:auditor');

    select.value = 'org:admin';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toMatch(/memberships\/user_2$/);
    expect(patch?.body).toEqual({ role: 'org:admin' });

    button(el, 'Remove').click();
    await settle();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/organizations/org_1/memberships/user_2'))).toBe(true);
  });

  it('invites, resends and revokes from the invitations tab', async () => {
    const { el, calls, settle } = await mount(ADMIN);
    button(el, 'Invitations').click();
    await settle();
    expect(el.querySelectorAll('[data-atlas="organization-invitation"]')).toHaveLength(1);

    typeInto(el.querySelector('input[type="email"]'), 'new@y.co');
    await settle();
    submit(el.querySelector('[data-atlas="organization-invitations"] form'));
    await settle();
    const invite = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/organizations/org_1/invitations'));
    expect(invite?.body).toEqual({ email_address: 'new@y.co', role: 'org:member' });

    button(el, 'Resend').click();
    button(el, 'Revoke').click();
    await settle();
    expect(calls.some((c) => c.url.endsWith('/invitations/inv_1/resend'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/invitations/inv_1/revoke'))).toBe(true);
  });

  it('a member sees no admin controls and leaves after confirming', async () => {
    const { el, calls, settle } = await mount(MEMBER);
    expect(el.querySelectorAll('[data-atlas="organization-member"]')).toHaveLength(2);
    expect(el.querySelector('select')).toBeNull();
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Invitations');
    expect(labels).not.toContain('Roles');
    expect(calls.some((c) => c.url.includes('/invitations') || c.url.endsWith('/permissions'))).toBe(false);

    button(el, 'Settings').click();
    await settle();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete organization')).toBe(false);
    button(el, 'Leave organization').click();
    await settle();
    button(el, 'Confirm').click();
    await settle();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/me/organizations/org_1/membership'))).toBe(true);
  });

  it("an admin creates, edits and deletes the organization's own roles", async () => {
    const { el, calls, settle } = await mount(ADMIN);
    button(el, 'Roles').click();
    await settle();
    expect(el.querySelectorAll('[data-atlas="organization-role"]')).toHaveLength(1);

    typeInto(el.querySelector('input[name="role_key"]'), 'org:viewer');
    typeInto(el.querySelector('input[name="role_name"]'), 'Viewer');
    const box = (i: number) => el.querySelectorAll('[data-atlas="organization-role-permission"] input')[i] as HTMLInputElement;
    box(0).checked = true;
    box(0).dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    submit(el.querySelector('[data-atlas="organization-role-form"]'));
    await settle();
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/client/organizations/org_1/roles'));
    expect(create?.body).toEqual({ key: 'org:viewer', name: 'Viewer', permissions: ['org:sys_memberships:read'] });

    button(el, 'Edit').click();
    await settle();
    expect(el.querySelector('input[name="role_key"]')).toBeNull();
    box(1).checked = true;
    box(1).dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    submit(el.querySelector('[data-atlas="organization-role-form"]'));
    await settle();
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/roles/role_aud'));
    expect(patch?.body).toEqual({ name: 'Auditor', permissions: ['org:sys_memberships:read', 'org:sys_memberships:manage'] });

    button(el, 'Delete').click();
    await settle();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/client/organizations/org_1/roles/role_aud'))).toBe(true);
  });
});
