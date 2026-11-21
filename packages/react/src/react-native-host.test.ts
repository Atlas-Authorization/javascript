import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider, isReactNative } from './AtlasProvider';

/**
 * Under React Native (Expo wraps this provider) there are no <style>, <link> or
 * <div> host elements: rendering one crashes the app at launch. The provider must
 * render only its context there, and never read `window.location` (RN has a
 * `window` but no location or document).
 */
const props = {
  publishableKey: 'pk_test_ZmFwaS5leGFtcGxlJA',
  frontendApi: 'https://fapi.example',
  fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
};

afterEach(() => vi.unstubAllGlobals());

describe('<AtlasProvider> host elements', () => {
  it('renders style, link and root div in a browser / on the server', () => {
    expect(isReactNative()).toBe(false);
    const html = renderToStaticMarkup(createElement(AtlasProvider, { ...props, children: 'child' }));
    expect(html).toContain('<style');
    expect(html).toContain('<div');
    expect(html).toContain('child');
  });

  it('renders only its children under React Native, without reading window.location', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('window', {}); // RN: window exists, location does not
    expect(isReactNative()).toBe(true);
    const html = renderToStaticMarkup(createElement(AtlasProvider, { ...props, children: 'child' }));
    expect(html).toBe('child');
  });
});
