/**
 * The IIFE entry bundled into `dist/atlas-lock.min.js`.
 *
 * Loaded with a plain `<script src=".../atlas-lock.min.js" data-atlas-key="pk_…"
 * data-atlas-domain="accounts.acme.com">`, it:
 *   1. defines the global `window.AtlasLock` (the class — `new AtlasLock({…})`),
 *   2. reads the script tag's `data-atlas-*` as a default config and, if a key +
 *      domain are present, constructs a singleton exposed as `window.atlasLock`,
 *   3. mounts it inline when `data-atlas-mount="#sel"` is set, opens it
 *      immediately when `data-atlas-auto` is present, and otherwise waits —
 *      binding any `[data-atlas-lock-open]` element's click to open the modal.
 *
 * `@atlasauth/embed` / `@atlasauth/js` / `@atlasauth/themes` are bundled in, so
 * the whole widget runs from the one script tag with no bare imports.
 */
import { AtlasLock } from './lock';
import type { AtlasLockConfig, AtlasLockOptions, AtlasLockScreen, AtlasLockTheme } from './options';

declare global {
  interface Window {
    AtlasLock?: typeof AtlasLock;
    atlasLock?: AtlasLock;
  }
}

function currentScript(): HTMLScriptElement | null {
  const active = document.currentScript;
  if (active instanceof HTMLScriptElement) return active;
  return (
    document.querySelector<HTMLScriptElement>('script[data-atlas-key]') ??
    document.querySelector<HTMLScriptElement>('script[src*="atlas-lock"]')
  );
}

/** Build a config from the loading script tag's `data-atlas-*` attributes. */
export function readScriptConfig(script: HTMLScriptElement | null | undefined): AtlasLockConfig | null {
  if (!script) return null;
  const d = script.dataset;
  if (!d.atlasKey || !d.atlasDomain) return null;

  const options: AtlasLockOptions = {};
  if (d.atlasScreen === 'sign-in' || d.atlasScreen === 'sign-up') {
    options.screen = d.atlasScreen as AtlasLockScreen;
  }
  if (d.atlasTheme) options.theme = d.atlasTheme as AtlasLockTheme;
  if (d.atlasPrimaryColor) options.primaryColor = d.atlasPrimaryColor;
  if (d.atlasRedirect) options.redirectUrl = d.atlasRedirect;
  if (d.atlasLogo) options.logo = d.atlasLogo;
  if (d.atlasTitle) options.title = d.atlasTitle;
  if (d.atlasMount) options.display = 'inline';

  const config: AtlasLockConfig = {
    publishableKey: d.atlasKey,
    domain: d.atlasDomain,
    options,
  };
  if (d.atlasMount) config.container = d.atlasMount;
  return config;
}

/** Wire every `[data-atlas-lock-open]` element to open the given lock as a modal. */
function bindTriggers(lock: AtlasLock, doc: Document): void {
  doc.querySelectorAll<HTMLElement>('[data-atlas-lock-open]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      lock.show();
    });
  });
}

function boot(): void {
  window.AtlasLock = AtlasLock;

  const script = currentScript();
  const config = readScriptConfig(script);
  if (!config) return;

  const lock = new AtlasLock(config);
  window.atlasLock = lock;

  const d = script!.dataset;
  const run = (): void => {
    if (d.atlasMount) {
      lock.show(); // inline panel
    } else if (d.atlasAuto !== undefined) {
      lock.show(); // open the modal immediately
    } else {
      bindTriggers(lock, document);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

boot();
