import { describe, expect, it } from 'vitest';

import { bumpAtlasDeps, toRange } from './version-bump';

describe('toRange', () => {
  it('carets a bare semver', () => {
    expect(toRange('0.2.0')).toBe('^0.2.0');
  });
  it('passes latest / * through verbatim', () => {
    expect(toRange('latest')).toBe('latest');
    expect(toRange('*')).toBe('*');
  });
  it('respects an explicit operator', () => {
    expect(toRange('~1.0.0')).toBe('~1.0.0');
    expect(toRange('^1.2.3')).toBe('^1.2.3');
  });
});

describe('bumpAtlasDeps', () => {
  const manifest = JSON.stringify(
    {
      name: 'my-app',
      dependencies: {
        '@atlasauth/react': '^0.1.0',
        '@atlasauth/nextjs': '0.1.0',
        react: '^18.0.0',
      },
      devDependencies: {
        '@atlasauth/testing': '^0.1.0',
      },
      peerDependencies: {
        '@atlasauth/js': 'workspace:*',
      },
    },
    null,
    2,
  );

  it('bumps every @atlasauth/* range across dep fields', () => {
    const { source, updated } = bumpAtlasDeps(manifest, '0.2.0');
    const parsed = JSON.parse(source);
    expect(parsed.dependencies['@atlasauth/react']).toBe('^0.2.0');
    expect(parsed.dependencies['@atlasauth/nextjs']).toBe('^0.2.0');
    expect(parsed.devDependencies['@atlasauth/testing']).toBe('^0.2.0');
    expect(updated).toContain('@atlasauth/react');
    expect(updated).toContain('@atlasauth/testing');
  });

  it('leaves non-atlas deps and workspace: ranges untouched', () => {
    const { source } = bumpAtlasDeps(manifest, '0.2.0');
    const parsed = JSON.parse(source);
    expect(parsed.dependencies.react).toBe('^18.0.0');
    expect(parsed.peerDependencies['@atlasauth/js']).toBe('workspace:*');
  });

  it('supports the latest dist-tag', () => {
    const { source } = bumpAtlasDeps(manifest, 'latest');
    expect(JSON.parse(source).dependencies['@atlasauth/react']).toBe('latest');
  });

  it('reports no changes when there is nothing to bump', () => {
    const none = JSON.stringify({ name: 'x', dependencies: { react: '^18' } }, null, 2);
    const { source, updated } = bumpAtlasDeps(none, '0.2.0');
    expect(updated).toEqual([]);
    expect(source).toBe(none);
  });

  it('preserves a trailing newline', () => {
    const withNl = manifest + '\n';
    expect(bumpAtlasDeps(withNl, '0.2.0').source.endsWith('\n')).toBe(true);
    expect(bumpAtlasDeps(manifest, '0.2.0').source.endsWith('\n')).toBe(false);
  });
});
