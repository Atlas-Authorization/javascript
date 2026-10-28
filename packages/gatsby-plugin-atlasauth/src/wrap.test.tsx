import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Stand in for the real provider so the test can read the props the wrap feeds
// it off the DOM, without the live provider's boot fetch / cookie work.
vi.mock('@atlasauth/react', () => ({
  AtlasConfigError: class AtlasConfigError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AtlasConfigError';
      this.code = code;
    }
  },
  AtlasProvider: (props: {
    publishableKey: string;
    frontendApi: string;
    oauthMode?: string;
    children?: React.ReactNode;
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'atlas-provider',
        'data-publishable-key': props.publishableKey,
        'data-frontend-api': props.frontendApi,
        'data-oauth-mode': props.oauthMode ?? '',
      },
      props.children,
    ),
}));

// Imported AFTER the mock is registered.
import { wrapRootElement } from './wrap';
import * as gatsbySsr from './gatsby-ssr';
import * as gatsbyBrowser from './gatsby-browser';

afterEach(() => cleanup());

describe('gatsby-ssr / gatsby-browser exports', () => {
  it('both export a wrapRootElement that is a function', () => {
    expect(typeof gatsbySsr.wrapRootElement).toBe('function');
    expect(typeof gatsbyBrowser.wrapRootElement).toBe('function');
  });

  it('both use the SAME wrap — reference-equal, so SSR and hydration cannot diverge', () => {
    expect(gatsbySsr.wrapRootElement).toBe(gatsbyBrowser.wrapRootElement);
    expect(gatsbySsr.wrapRootElement).toBe(wrapRootElement);
  });
});

describe('wrapRootElement', () => {
  it('renders AtlasProvider around the element with the passed key / frontend API', () => {
    const element = createElement('span', { 'data-testid': 'page' }, 'hello');
    const tree = wrapRootElement(
      { element },
      { publishableKey: 'pk_test_wrap', frontendApi: 'https://auth.example', oauthMode: 'popup' },
    );

    render(tree as React.ReactElement);

    const provider = screen.getByTestId('atlas-provider');
    expect(provider.getAttribute('data-publishable-key')).toBe('pk_test_wrap');
    expect(provider.getAttribute('data-frontend-api')).toBe('https://auth.example');
    expect(provider.getAttribute('data-oauth-mode')).toBe('popup');
    // the original page element is nested inside the provider
    expect(provider.contains(screen.getByTestId('page'))).toBe(true);
  });

  it('falls back to env when options are omitted', () => {
    process.env.GATSBY_ATLAS_PUBLISHABLE_KEY = 'pk_test_env';
    process.env.GATSBY_ATLAS_FRONTEND_API = 'https://env.example';
    try {
      const tree = wrapRootElement({ element: createElement('span') });
      render(tree as React.ReactElement);
      const provider = screen.getByTestId('atlas-provider');
      expect(provider.getAttribute('data-publishable-key')).toBe('pk_test_env');
      expect(provider.getAttribute('data-frontend-api')).toBe('https://env.example');
    } finally {
      delete process.env.GATSBY_ATLAS_PUBLISHABLE_KEY;
      delete process.env.GATSBY_ATLAS_FRONTEND_API;
    }
  });

  it('throws a clear config error when frontendApi is set nowhere', () => {
    const saved = { gatsby: process.env.GATSBY_ATLAS_FRONTEND_API, plain: process.env.ATLAS_FRONTEND_API };
    delete process.env.GATSBY_ATLAS_FRONTEND_API;
    delete process.env.ATLAS_FRONTEND_API;
    let caught: unknown;
    try {
      wrapRootElement({ element: createElement('span') }, { publishableKey: 'pk_test_wrap' });
    } catch (error) {
      caught = error;
    } finally {
      if (saved.gatsby !== undefined) process.env.GATSBY_ATLAS_FRONTEND_API = saved.gatsby;
      if (saved.plain !== undefined) process.env.ATLAS_FRONTEND_API = saved.plain;
    }
    expect((caught as { name?: string }).name).toBe('AtlasConfigError');
    expect((caught as { code?: string }).code).toBe('FRONTEND_API_REQUIRED');
    expect((caught as Error).message).toContain('GATSBY_ATLAS_FRONTEND_API');
  });
});
