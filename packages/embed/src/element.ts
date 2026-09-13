import { AtlasWidget } from './widget';
import { optionsFromElement } from './config';

/**
 * The custom elements: `<atlas-sign-in>` and `<atlas-sign-up>`.
 *
 * Each is a thin host — on connect it resolves its options from its own
 * attributes plus the script-tag defaults and mounts an {@link AtlasWidget}
 * into itself (light DOM, NOT a shadow root, so the tenant's page CSS and
 * password managers reach the inputs). Missing required config renders a
 * legible message instead of a blank box.
 */
abstract class AtlasElement extends HTMLElement {
  protected abstract readonly mode: 'sign-in' | 'sign-up';
  private widget: AtlasWidget | null = null;

  connectedCallback(): void {
    // Guard against a re-entrant connect (move within the DOM) re-mounting.
    if (this.widget) return;

    const options = optionsFromElement(this, this.mode);
    if (!options) {
      this.textContent =
        'Atlas: set data-atlas-key (publishable key) and data-atlas-fapi (frontend API origin).';
      return;
    }

    this.widget = new AtlasWidget(this, options);
    void this.widget.mount();
  }
}

export class AtlasSignInElement extends AtlasElement {
  protected readonly mode = 'sign-in' as const;
}

export class AtlasSignUpElement extends AtlasElement {
  protected readonly mode = 'sign-up' as const;
}

/** Register the custom elements. Idempotent — safe to call more than once. */
export function defineElements(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get('atlas-sign-in')) {
    customElements.define('atlas-sign-in', AtlasSignInElement);
  }
  if (!customElements.get('atlas-sign-up')) {
    customElements.define('atlas-sign-up', AtlasSignUpElement);
  }
}
