import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { resolveDesign } from '@atlasauth/design';
import AtlasProvider from '../lib/components/AtlasProvider.svelte';
import { cssVariables, renderAppearance, resolveTokens } from '../lib/appearance';

vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('<AtlasProvider> design support (same semantics as @atlasauth/react)', () => {
  it('without a design, renders exactly the legacy token variables', () => {
    const appearance = { variables: { colorPrimary: '#ff0000' } };
    expect(renderAppearance(appearance, null).style).toEqual(cssVariables(resolveTokens(appearance)));
    expect(renderAppearance(appearance, null).css).toBe('');
  });

  it('design: null from the server leaves the legacy look', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/v1/appearance') ? jsonResponse({ design: null }) : jsonResponse({ session: null, user: null }),
    ) as unknown as typeof fetch;
    const { container } = render(AtlasProvider, { props: { publishableKey: 'pk_test', fetchImpl } });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const root = container.querySelector('.atlas-root')!;
    expect(root.hasAttribute('data-atlas-design')).toBe(false);
    expect(root.getAttribute('style')).toContain('--atlas-color-primary: #5b5bd6');
  });

  it('applies a code preset on the root and in <head>', () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: null, user: null })) as unknown as typeof fetch;
    const { container } = render(AtlasProvider, {
      props: { publishableKey: 'pk_test', appearance: { preset: 'midnight', instanceDesign: false }, fetchImpl },
    });
    const root = container.querySelector('.atlas-root')!;
    const key = root.getAttribute('data-atlas-design');
    expect(key).toBeTruthy();
    const css = document.head.querySelector(`style[data-atlas-design="${key}"]`)?.textContent ?? '';
    expect(css).toContain(resolveDesign({ preset: 'midnight' }).palette.primary);
  });

  it('adopts the dashboard design, with code overrides winning', async () => {
    const resolved = resolveDesign({ preset: 'forest' });
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/v1/appearance') ? jsonResponse({ design: { resolved } }) : jsonResponse({ session: null, user: null }),
    ) as unknown as typeof fetch;
    const { container } = render(AtlasProvider, {
      props: { publishableKey: 'pk_test', appearance: { design: { card: { style: 'glass' } } }, fetchImpl },
    });
    const root = container.querySelector('.atlas-root')!;
    const cssFor = () =>
      document.head.querySelector(`style[data-atlas-design="${root.getAttribute('data-atlas-design')}"]`)?.textContent ?? '';
    await waitFor(() => expect(cssFor()).toContain(`--atlas-color-primary:${resolved.palette.primary}`));
    expect(root.getAttribute('data-atlas-card')).toBe('glass');
  });
});
