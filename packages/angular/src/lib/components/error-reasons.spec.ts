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
import type { FieldError } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';
import { EN_US, withFallback } from '../i18n';
import { AttemptFlowComponent } from './attempt-flow.component';

/**
 * Server form errors render in the app's language: `<atlas-attempt-flow>`
 * shows the catalog's `error.<reason>` instead of the server's English
 * `message`, and falls back to the message for a reason it has no string for.
 * Rendered into happy-dom through the same minimal DOM renderer as the
 * email-delivery spec, with a stand-in `AtlasService`.
 */

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

const ES = { locale: 'es-ES', 'error.form_password_incorrect': 'Esas credenciales son incorrectas.' };
const refs: ComponentRef<unknown>[] = [];

function render<T>(component: Type<T>, atlas: object, inputs: Record<string, unknown>): ComponentRef<T> {
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

const errorsOf = (errors: FieldError[], atlas: object) => {
  const ref = render(AttemptFlowComponent, atlas, { errors });
  const el = ref.location.nativeElement as HTMLElement;
  return [...el.querySelectorAll('.atlas-error')].map((n) => n.textContent?.trim()).join(' | ');
};

describe('<atlas-attempt-flow> server errors by reason', () => {
  const refused: FieldError = {
    code: 'VERIFICATION_FAILED',
    message: 'Those credentials are incorrect (server).',
    reason: 'form_password_incorrect',
  };

  it('renders the English catalog string by default', () => {
    expect(errorsOf([refused], { localization: EN_US, errorLocalization: EN_US, appearance: undefined })).toBe(
      EN_US['error.form_password_incorrect'],
    );
  });

  it('renders the Spanish string under a Spanish bundle', () => {
    expect(errorsOf([refused], { localization: withFallback(ES), errorLocalization: ES, appearance: undefined })).toBe(
      'Esas credenciales son incorrectas.',
    );
  });

  it('falls back to the server message for an unknown reason', () => {
    expect(
      errorsOf([{ code: 'X', message: 'Mensaje del servidor.', reason: 'brand_new' }], {
        localization: withFallback(ES),
        errorLocalization: ES,
        appearance: undefined,
      }),
    ).toBe('Mensaje del servidor.');
  });
});
