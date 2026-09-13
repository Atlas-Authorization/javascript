import { renderGoogleOverlayButton } from '@atlasauth/js';
import { providerLabel, SEARCH_AUTO_THRESHOLD } from '../appearance';
import { providerIcon } from '../icons';
import type { AtlasWidget } from '../widget';
import { CHEVRON_LEFT, CHEVRON_RIGHT, COPY, HANDLE_PROVIDERS } from './constants';
import { cls, doc, el, submitButton } from './dom';
import { render, renderNote } from './render';
import { completeIdToken, startOAuth, startSso } from './flow';
import { passkeySignIn } from './passkey';

/** §5.5 the "Sign in with a passkey" button on the identifier screen. */
export function renderPasskeyButton(w: AtlasWidget): HTMLElement {
  const btn = el(
    w,
    'button',
    cls(w, 'socialButton', 'atlas-embed-social-button'),
    'Sign in with a passkey',
  ) as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('data-atlas-passkey', '');
  btn.disabled = w.busy;
  btn.addEventListener('click', () => {
    void passkeySignIn(w);
  });
  return btn;
}

/**
 * All providers to render as buttons: the redirect providers PLUS any native
 * provider (e.g. Google GSI) not already among them. A native-only provider —
 * one configured with a client_id but absent from `strategies.oauthProviders`
 * — must still get a button, or an instance whose only social login is Google
 * would render none at all.
 */
export function socialProviders(w: AtlasWidget): string[] {
  const ids = [...w.providers];
  for (const native of w.nativeProviders) {
    if (!ids.includes(native.provider)) ids.push(native.provider);
  }
  return ids;
}

// The Atlas mark — a trusted, static, first-party SVG (never tenant input).
const ATLAS_MARK =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none">' +
  '<path d="M12 2 3 21h4l5-11 5 11h4L12 2z" fill="currentColor"/>' +
  '</svg>';

/**
 * The "Sign in with Atlas" button — starts the preset OIDC connection's SSO
 * flow. It is a first-class social login: it lives in the provider grid and
 * takes the same layout/size/variant as every other provider button (a full
 * bar in `block`, a tile in `grid`, icon-only in `icon`), so it reads as one
 * of the grid, not a banner bolted above it.
 */
export function atlasButton(w: AtlasWidget, connectionId: string): HTMLElement {
  const { variant, labels } = w.social;
  // Mirror styledSocialButton's copy rules: "Continue with Atlas" for the bar,
  // "Atlas" for the tile/compact forms, with a per-provider label override.
  const text = labels.atlas ?? (variant === 'block' ? 'Continue with Atlas' : 'Atlas');

  const button = el(
    w,
    'button',
    cls(w, 'socialButton', 'atlas-embed-social-button'),
  ) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('data-atlas-provider', 'atlas');
  button.setAttribute('data-variant', variant);

  const icon = doc(w).createElement('span');
  icon.className = 'atlas-embed-social-icon';
  icon.innerHTML = ATLAS_MARK;
  button.appendChild(icon);

  if (variant === 'icon') {
    // Icon-only: the name lives in the tooltip and the a11y label instead.
    button.setAttribute('aria-label', 'Continue with Atlas');
    button.setAttribute('title', 'Atlas');
  } else {
    const label = doc(w).createElement('span');
    label.className = 'atlas-embed-social-label';
    label.textContent = text;
    button.appendChild(label);
  }

  // GSI-style: open the Atlas sign-in in a popup (with a redirect fallback when
  // popups are blocked) so the host page never loses its own state.
  button.addEventListener('click', () => {
    void startSso(w, connectionId, { popup: true });
  });
  return button;
}

export function renderSocial(w: AtlasWidget): HTMLElement {
  const providers = socialProviders(w);
  const wrap = el(w, 'div', 'atlas-embed-social');
  // The layout/size/variant drive the CSS: list vs grid vs a scroll-snap
  // carousel, button scale, and whether each button is a full bar or icon-only.
  wrap.setAttribute('data-layout', w.social.layout);
  wrap.setAttribute('data-size', w.social.size);
  wrap.setAttribute('data-variant', w.social.variant);
  // "Sign in with Atlas" leads the provider grid as its first tile — a social
  // login among the rest, taking the same layout/variant (not a banner above).
  if (w.signInWithAtlas.enabled && w.signInWithAtlas.connection_id) {
    wrap.appendChild(atlasButton(w, w.signInWithAtlas.connection_id));
  }
  for (const provider of providers) {
    // A native provider (Google GSI) shows OUR uniform button with Google's
    // real button invisibly overlaid — the user sees our design, the click
    // drives the secretless id_token flow (no redirect, no Google styling).
    // Every other provider uses the redirect button.
    const native = w.nativeProviders.find((n) => n.provider === provider);
    const button =
      provider === 'google' && native?.client_id
        ? googleOverlayButton(w, native.client_id)
        : redirectButton(w, provider);
    // Guarantee the filter can find the provider even on the Google overlay.
    if (!button.getAttribute('data-atlas-provider')) {
      button.setAttribute('data-atlas-provider', provider);
    }
    wrap.appendChild(button);
  }

  // Carousel layout: wrap the scroll row in prev/next controls so a long row
  // is obviously scrollable AND clickable, not just swipeable, with the arrows
  // auto-hiding when everything already fits and disabling at each end.
  const body = w.social.layout === 'carousel' ? carouselShell(w, wrap) : wrap;

  // §customization: a search box to narrow a long provider list. `always`
  // forces it; `auto` (default) shows it only past the threshold so a common
  // handful stays button-only while a wall of 20 becomes filterable; `never`
  // hides it. Pure client-side filter over the already-rendered buttons — it
  // adds no request and touches no config, so it cannot expose a provider the
  // instance has not enabled.
  const showSearch =
    w.social.search === 'always' ||
    (w.social.search === 'auto' && providers.length > SEARCH_AUTO_THRESHOLD);
  if (!showSearch) return body;

  const field = el(w, 'div', 'atlas-embed-social-field');
  const input = doc(w).createElement('input');
  input.type = 'search';
  input.className = 'atlas-embed-social-search';
  input.setAttribute('placeholder', 'Search sign-in options…');
  input.setAttribute('aria-label', 'Search sign-in options');
  input.autocomplete = 'off';

  const empty = el(w, 'div', 'atlas-embed-social-empty');
  empty.textContent = 'No matching sign-in options.';
  empty.setAttribute('hidden', '');

  const buttons = Array.from(wrap.children) as HTMLElement[];
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let visible = 0;
    for (const b of buttons) {
      const key = b.getAttribute('data-atlas-provider') ?? '';
      // Match on both the display name ("GitHub") and the key ("github"), so
      // typing either narrows correctly regardless of a label override.
      const match =
        q === '' || providerLabel(key).toLowerCase().includes(q) || key.toLowerCase().includes(q);
      b.toggleAttribute('hidden', !match);
      if (match) visible += 1;
    }
    empty.toggleAttribute('hidden', visible !== 0);
    // Hiding buttons changes the scrollable width, so nudge the carousel to
    // re-evaluate its arrows (a no-op for the non-carousel layouts).
    wrap.dispatchEvent(new Event('scroll'));
  });

  field.appendChild(input);
  field.appendChild(body);
  field.appendChild(empty);
  return field;
}

/**
 * Wrap a carousel scroll-row with prev/next arrow buttons. The arrows page the
 * row left/right, hide themselves entirely when everything already fits, and
 * disable at each end — so a long row reads as a real, clickable carousel
 * rather than a bare overflow the user might not notice they can scroll. State
 * is recomputed on scroll and on resize (via ResizeObserver when available).
 */
export function carouselShell(w: AtlasWidget, row: HTMLElement): HTMLElement {
  const win = doc(w).defaultView ?? (typeof window !== 'undefined' ? window : null);
  const shell = el(w, 'div', 'atlas-embed-carousel');

  const nav = (dir: 'prev' | 'next'): HTMLButtonElement => {
    const b = el(w, 'button', 'atlas-embed-carousel-nav') as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('data-dir', dir);
    b.setAttribute(
      'aria-label',
      dir === 'prev' ? 'Scroll to previous sign-in options' : 'Scroll to more sign-in options',
    );
    b.innerHTML = dir === 'prev' ? CHEVRON_LEFT : CHEVRON_RIGHT;
    b.addEventListener('click', () => {
      const amount = Math.max(row.clientWidth * 0.8, 140);
      // Guarded: not every host (jsdom in tests) implements scrollBy.
      if (typeof row.scrollBy === 'function') {
        row.scrollBy({ left: (dir === 'prev' ? -1 : 1) * amount, behavior: 'smooth' });
      }
    });
    return b;
  };
  const prev = nav('prev');
  const next = nav('next');

  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    const overflow = max > 2;
    shell.setAttribute('data-overflow', overflow ? 'true' : 'false');
    prev.disabled = !overflow || row.scrollLeft <= 1;
    next.disabled = !overflow || row.scrollLeft >= max - 1;
  };
  row.addEventListener('scroll', update, { passive: true } as AddEventListenerOptions);
  const RO = win && (win as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (RO) new RO(update).observe(row);
  else if (win) win.addEventListener('resize', update);
  // Measure once the row has real dimensions (it is still detached here).
  if (win?.requestAnimationFrame) win.requestAnimationFrame(update);
  update();

  shell.appendChild(prev);
  shell.appendChild(row);
  shell.appendChild(next);
  return shell;
}

/** The uniform, always-styled visual button (no click behaviour of its own). */
export function styledSocialButton(
  w: AtlasWidget,
  provider: string,
  tag: 'button' | 'div' = 'button',
): HTMLElement {
  const { variant, labels } = w.social;
  const name = providerLabel(provider);
  // `block` → "Continue with Google"; `compact`/`icon` → "Google". A per-provider
  // label override wins for the text variants.
  const text =
    labels[provider] ?? (variant === 'block' ? `Continue with ${name}` : name);

  const element = el(w, tag, cls(w, 'socialButton', 'atlas-embed-social-button'));
  if (tag === 'button') (element as HTMLButtonElement).type = 'button';
  element.setAttribute('data-atlas-provider', provider);
  element.setAttribute('data-variant', variant);

  const iconSvg = providerIcon(provider);
  if (iconSvg) {
    const icon = doc(w).createElement('span');
    icon.className = 'atlas-embed-social-icon';
    // Trusted, static, first-party SVG (see icons.ts) — never tenant input.
    icon.innerHTML = iconSvg;
    element.appendChild(icon);
  }

  if (variant === 'icon') {
    // Icon-only: the name lives in the tooltip and the a11y label instead.
    element.setAttribute('aria-label', `Continue with ${name}`);
    element.setAttribute('title', name);
  } else {
    const label = doc(w).createElement('span');
    label.className = 'atlas-embed-social-label';
    label.textContent = text;
    element.appendChild(label);
  }
  return element;
}

export function redirectButton(w: AtlasWidget, provider: string): HTMLElement {
  const button = styledSocialButton(w, provider);
  button.addEventListener('click', () => {
    // Handle-first providers (Bluesky) need the user's handle to resolve their
    // PDS before the redirect — show the small prompt instead of navigating.
    if (HANDLE_PROVIDERS.has(provider)) {
      w.handlePrompt = provider;
      render(w);
    } else {
      void startOAuth(w, provider);
    }
  });
  return button;
}

/**
 * The handle-first sub-screen (Bluesky). AT-Proto resolves the user's PDS from
 * their handle, so we collect it here, then hand it to startOAuth. A Back link
 * returns to the normal start screen.
 */
export function renderHandlePrompt(w: AtlasWidget, provider: string): HTMLElement {
  const name = providerLabel(provider);
  const form = doc(w).createElement('form');
  form.className = 'atlas-embed-form';
  form.setAttribute('novalidate', 'true');

  for (const err of w.state.errors.filter((e) => !e.param)) {
    form.appendChild(el(w, 'div', 'atlas-embed-form-error', err.message));
  }

  const field = el(w, 'label', cls(w, 'field', 'atlas-embed-field'));
  field.appendChild(el(w, 'span', cls(w, 'label', 'atlas-embed-label'), `${name} handle`));
  const input = doc(w).createElement('input');
  input.className = cls(w, 'input', 'atlas-embed-input');
  input.type = 'text';
  input.name = 'identifier';
  input.placeholder = 'you.bsky.social';
  input.setAttribute('autocomplete', 'username');
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('spellcheck', 'false');
  field.appendChild(input);
  form.appendChild(field);

  const button = submitButton(w, COPY[w.mode].submit);
  form.appendChild(button);

  const back = el(w, 'button', 'atlas-embed-handle-back', 'Back');
  (back as HTMLButtonElement).type = 'button';
  back.addEventListener('click', () => {
    w.handlePrompt = null;
    w.state = { ...w.state, errors: [] };
    render(w);
  });
  form.appendChild(back);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const handle = input.value.trim();
    if (!handle) {
      w.state = {
        ...w.state,
        errors: [{ code: 'validation_error', message: `Enter your ${name} handle.` }],
      };
      render(w);
      return;
    }
    void startOAuth(w, provider, handle);
  });

  return form;
}

/**
 * Our uniform Google button, backed by Google's invisible real button. A DIV
 * (role=button), not a <button>, so Google's own button can be nested legally.
 * If GSI can't load, the same element falls back to the redirect flow so it is
 * never a dead button.
 */
export function googleOverlayButton(w: AtlasWidget, clientId: string): HTMLElement {
  const element = styledSocialButton(w, 'google', 'div');
  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  void renderGoogleOverlayButton({
    wrapper: element,
    clientId,
    onCredential: (idToken) => void completeIdToken(w, 'google', idToken),
    onError: () => renderNote(w, 'Google sign-in could not start.'),
  }).catch(() => {
    // GSI blocked/offline — make the same button do the redirect flow instead.
    element.addEventListener('click', () => void startOAuth(w, 'google'));
  });
  return element;
}
