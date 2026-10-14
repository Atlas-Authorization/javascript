// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deDE, esES, frFR, ptBR, jaJP, nlNL, missingKeys } from '@atlasauth/localizations';
import { AtlasProvider, useAtlas } from './AtlasProvider';
import { EN_US } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The integration guard: the components' canonical catalog (`EN_US`) is the
 * source of truth, and the complete language bundles must cover every key of
 * it. Adding a UI string here without translating it fails this test.
 */
describe('language bundles cover every component string', () => {
  for (const [tag, bundle] of Object.entries({ esES, frFR, deDE, ptBR })) {
    it(`${tag} has every EN_US key`, () => {
      expect(missingKeys(bundle, EN_US)).toEqual([]);
    });
  }

  it('reports ja-JP / nl-NL coverage (partial bundles fall back to English)', () => {
    const total = Object.keys(EN_US).length;
    for (const bundle of [jaJP, nlNL]) {
      expect(total - missingKeys(bundle, EN_US).length).toBeGreaterThan(0);
    }
  });
});

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

async function catalogFor(props: { locale?: string; localization?: Record<string, string> }) {
  let ctx: ReturnType<typeof useAtlas> | null = null;
  const Probe = () => {
    ctx = useAtlas();
    return null;
  };
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ session: null, user: null }), { status: 200 }),
  ) as unknown as typeof fetch;
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        fetchImpl,
        appearance: { instanceDesign: false },
        ...props,
        children: createElement(Probe),
      }),
    );
  });
  unmount = () => act(() => root.unmount());
  return ctx!.catalog;
}

describe('<AtlasProvider locale>', () => {
  it('defaults to English', async () => {
    expect((await catalogFor({}))['signIn.title']).toBe(EN_US['signIn.title']);
  });

  it('resolves short and regional tags to the built-in bundle', async () => {
    expect((await catalogFor({ locale: 'es' }))['signIn.title']).toBe(esES['signIn.title']);
    unmount?.();
    expect((await catalogFor({ locale: 'es-MX' }))['signIn.title']).toBe(esES['signIn.title']);
    unmount?.();
    expect((await catalogFor({ locale: 'pt-BR' }))['signIn.title']).toBe(ptBR['signIn.title']);
    unmount?.();
    expect((await catalogFor({ locale: 'de' }))['signIn.title']).toBe(deDE['signIn.title']);
  });

  it('applies `localization` key by key on top of the locale', async () => {
    const catalog = await catalogFor({ locale: 'fr', localization: { 'signIn.title': 'Bonjour' } });
    expect(catalog['signIn.title']).toBe('Bonjour');
    expect(catalog['signIn.submit']).toBe(frFR['signIn.submit']);
  });

  it('falls back to English (with a warning) for an unknown locale', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = await catalogFor({ locale: 'xx-YY' });
    expect(catalog['signIn.title']).toBe(EN_US['signIn.title']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('xx-YY'));
  });
});
