import { classFor } from '../appearance';
import type { AtlasWidget } from '../widget';

export function doc(w: AtlasWidget): Document {
  return w.root.ownerDocument ?? document;
}

export function el(w: AtlasWidget, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc(w).createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  // The two button classes the ripple stylesheet clips — bind the tap ripple
  // here so every submit/social button gets it without touching each call site.
  if (
    node.classList.contains('atlas-embed-button') ||
    node.classList.contains('atlas-embed-social-button')
  ) {
    bindRipple(w, node);
  }
  return node;
}

export function cls(w: AtlasWidget, element: Parameters<typeof classFor>[0], base: string): string {
  return classFor(element, base, w.options.appearance);
}

/**
 * A material tap ripple: spawn a scaled circle at the pointer, sized to cover
 * the button, and remove it when its animation ends. No-op unless the ripple
 * effect is active and motion is allowed — cheap enough to bind to every button.
 */
export function bindRipple(w: AtlasWidget, button: HTMLElement): void {
  if (w.interaction.buttonEffect !== 'ripple' || !w.interaction.animations) return;
  button.addEventListener('pointerdown', (ev) => {
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = doc(w).createElement('span');
    span.className = 'atlas-embed-ripple';
    span.style.width = span.style.height = `${size}px`;
    span.style.left = `${(ev as PointerEvent).clientX - rect.left - size / 2}px`;
    span.style.top = `${(ev as PointerEvent).clientY - rect.top - size / 2}px`;
    span.addEventListener('animationend', () => span.remove());
    button.appendChild(span);
  });
}

/**
 * The primary submit button, with a built-in busy state: while `busy` it shows
 * a spinner in place of its label (and is disabled), so clicking "Continue"
 * gives immediate progress feedback instead of a dead, unchanged button. Goes
 * through `el()` so the ripple/interaction bindings still apply.
 */
export function submitButton(w: AtlasWidget, label: string): HTMLButtonElement {
  const btn = el(w, 'button', cls(w, 'buttonPrimary', 'atlas-embed-button')) as HTMLButtonElement;
  btn.type = 'submit';
  btn.disabled = w.busy;
  if (w.busy) {
    btn.setAttribute('data-busy', '');
    btn.setAttribute('aria-label', label);
    const sp = el(w, 'span', 'atlas-embed-btn-spinner');
    sp.setAttribute('aria-hidden', 'true');
    btn.appendChild(sp);
  } else {
    btn.textContent = label;
  }
  return btn;
}
