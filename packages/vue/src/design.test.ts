import { describe, expect, it, vi } from 'vitest';
import { createApp, h } from 'vue';
import { resolveDesign } from '@atlasauth/design';
import { cssVariables, renderAppearance, resolveTokens } from './appearance';
import { createAtlas } from './plugin';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const reset = () => {
  document.head.innerHTML = '';
  for (const a of [...document.documentElement.attributes]) {
    if (a.name.startsWith('data-atlas') || a.name === 'style') document.documentElement.removeAttribute(a.name);
  }
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('appearance design support (same semantics as @atlasauth/react)', () => {
  it('without a design, renders exactly the legacy token variables', () => {
    const appearance = { baseTheme: 'dark' as const, variables: { colorPrimary: '#ff0000' } };
    expect(renderAppearance(appearance, null)).toEqual({
      style: cssVariables(resolveTokens(appearance)),
      attributes: {},
      css: '',
      key: '',
      fontStylesheets: [],
    });
  });

  it('design: null from the server leaves the legacy look', async () => {
    reset();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/appearance') ? json({ design: null }) : json({ session: null, user: null }),
    );
    createApp({ render: () => h('div') })
      .use(createAtlas({ publishableKey: 'pk_test', fetchImpl: fetchImpl as unknown as typeof fetch }))
      .mount(document.createElement('div'));
    await flush();
    await flush();
    expect(document.documentElement.hasAttribute('data-atlas-design')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--atlas-color-primary')).toBe('#5b5bd6');
  });

  it('applies a code preset to the document root at install', () => {
    reset();
    const fetchImpl = vi.fn(async () => json({ session: null, user: null }));
    createApp({ render: () => h('div') })
      .use(createAtlas({ publishableKey: 'pk_test', appearance: { preset: 'midnight' }, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .mount(document.createElement('div'));
    const root = document.documentElement;
    const key = root.getAttribute('data-atlas-design');
    expect(key).toBeTruthy();
    const style = document.head.querySelector(`style[data-atlas-design="${key}"]`);
    expect(style?.textContent).toContain(resolveDesign({ preset: 'midnight' }).palette.primary);
  });

  it('adopts the dashboard design, with code overrides winning', async () => {
    reset();
    const resolved = resolveDesign({ preset: 'forest', typography: { font: 'inter' } });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/v1/appearance') ? json({ design: { resolved } }) : json({ session: null, user: null }),
    );
    createApp({ render: () => h('div') })
      .use(
        createAtlas({
          publishableKey: 'pk_test',
          frontendApi: '',
          appearance: { design: { palette: { accent: '#123456' } } },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      )
      .mount(document.createElement('div'));
    await flush();
    await flush();
    const key = document.documentElement.getAttribute('data-atlas-design');
    const css = document.head.querySelector(`style[data-atlas-design="${key}"]`)?.textContent ?? '';
    expect(css).toContain(`--atlas-color-primary:${resolved.palette.primary}`);
    expect(css).toContain('--atlas-color-accent:#123456');
    expect(document.head.querySelector('link[data-atlas-font]')?.getAttribute('href')).toBe(
      '/v1/design/fonts/inter.css',
    );
  });
});
