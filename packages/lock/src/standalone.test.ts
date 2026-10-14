// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
// Importing the module runs its boot(): with no config-bearing script tag in
// the test document it simply defines the global and returns.
import { readScriptConfig } from './standalone';
import { AtlasLock } from './lock';

describe('the CDN global', () => {
  it('defines window.AtlasLock as the class', () => {
    expect(window.AtlasLock).toBeDefined();
    expect(window.AtlasLock).toBe(AtlasLock);
    // It is constructible the way the quickstart documents.
    const lock = new window.AtlasLock!({ publishableKey: 'pk', domain: 'id.acme.com' });
    expect(lock).toBeInstanceOf(AtlasLock);
  });
});

describe('readScriptConfig', () => {
  const script = (data: Record<string, string>): HTMLScriptElement => {
    const el = document.createElement('script');
    for (const [k, v] of Object.entries(data)) el.dataset[k] = v;
    return el;
  };

  it('returns null without a key + domain', () => {
    expect(readScriptConfig(null)).toBeNull();
    expect(readScriptConfig(script({ atlasKey: 'pk' }))).toBeNull();
  });

  it('parses a modal config from data-atlas-* attributes', () => {
    const cfg = readScriptConfig(
      script({ atlasKey: 'pk_1', atlasDomain: 'accounts.acme.com', atlasTheme: 'dark', atlasPrimaryColor: '#16a34a', atlasScreen: 'sign-up' }),
    )!;
    expect(cfg.publishableKey).toBe('pk_1');
    expect(cfg.domain).toBe('accounts.acme.com');
    expect(cfg.options?.theme).toBe('dark');
    expect(cfg.options?.primaryColor).toBe('#16a34a');
    expect(cfg.options?.screen).toBe('sign-up');
    expect(cfg.container).toBeUndefined();
  });

  it('switches to inline display when data-atlas-mount is present', () => {
    const cfg = readScriptConfig(script({ atlasKey: 'pk_1', atlasDomain: 'id.acme.com', atlasMount: '#slot' }))!;
    expect(cfg.options?.display).toBe('inline');
    expect(cfg.container).toBe('#slot');
  });
});
