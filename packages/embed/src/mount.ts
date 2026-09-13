import { AtlasWidget, type WidgetOptions } from './widget';
import { optionsFromApi } from './config';

/** A mount target: an element, or a CSS selector resolved against the document. */
export type MountTarget = Element | string;

function resolve(target: MountTarget): HTMLElement | null {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  return el instanceof HTMLElement ? el : null;
}

function mount(
  mode: 'sign-in' | 'sign-up',
  target: MountTarget,
  overrides: Partial<WidgetOptions>,
): AtlasWidget | null {
  const host = resolve(target);
  if (!host) return null;

  const options = optionsFromApi(mode, overrides);
  if (!options) {
    host.textContent =
      'Atlas: a publishable key and a frontend API origin are required to mount the widget.';
    return null;
  }

  const widget = new AtlasWidget(host, options);
  void widget.mount();
  return widget;
}

/** Imperatively mount the sign-in panel into an element or selector. */
export function mountSignIn(
  target: MountTarget,
  overrides: Partial<WidgetOptions> = {},
): AtlasWidget | null {
  return mount('sign-in', target, overrides);
}

/** Imperatively mount the sign-up panel into an element or selector. */
export function mountSignUp(
  target: MountTarget,
  overrides: Partial<WidgetOptions> = {},
): AtlasWidget | null {
  return mount('sign-up', target, overrides);
}
