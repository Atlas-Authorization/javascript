import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import transform, { type ClerkToAtlasOptions } from './clerk-to-atlas';

// Drive the transform exactly as jscodeshift would, but in-process so we can
// assert on the returned source directly. The `tsx` parser handles every
// source flavour we support.
const j = jscodeshift.withParser('tsx');
const api: API = {
  j,
  jscodeshift: j,
  stats: () => undefined,
  report: () => undefined,
};

function run(source: string, options: ClerkToAtlasOptions = {}): string | undefined {
  return transform({ path: 'test.tsx', source }, api, options);
}

describe('clerk-to-atlas: package imports', () => {
  it('renames the @clerk/* package to its @atlasauth/* peer', () => {
    const out = run(`import { useUser } from '@clerk/clerk-react';`);
    expect(out).toContain(`from '@atlasauth/react'`);
    // A shared same-named symbol must survive untouched.
    expect(out).toContain('useUser');
    expect(out).not.toContain('@clerk/');
  });

  it('maps every known package in a mixed file', () => {
    const out = run(
      [
        `import { useAuth } from '@clerk/nextjs';`,
        `import { createClerkClient } from '@clerk/backend';`,
      ].join('\n'),
    );
    expect(out).toContain(`from '@atlasauth/nextjs'`);
    expect(out).toContain(`from '@atlasauth/backend'`);
  });

  it('rewrites require() and dynamic import() specifiers', () => {
    const out = run(
      [`const a = require('@clerk/express');`, `const b = import('@clerk/fastify');`].join('\n'),
    );
    expect(out).toContain(`require('@atlasauth/express')`);
    expect(out).toContain(`import('@atlasauth/fastify')`);
  });
});

describe('clerk-to-atlas: identifier renames', () => {
  it('renames the provider in both the import and JSX usage', () => {
    const out = run(
      [
        `import { ClerkProvider } from '@clerk/clerk-react';`,
        `export const App = () => <ClerkProvider><div /></ClerkProvider>;`,
      ].join('\n'),
    );
    expect(out).toContain(`import { AtlasProvider } from '@atlasauth/react'`);
    expect(out).toContain('<AtlasProvider>');
    expect(out).toContain('</AtlasProvider>');
    expect(out).not.toContain('ClerkProvider');
  });

  it('renames a hook and every reference to it', () => {
    const out = run(
      [`import { useClerk } from '@clerk/clerk-react';`, `const c = useClerk();`].join('\n'),
    );
    expect(out).toContain(`import { useAtlas } from '@atlasauth/react'`);
    expect(out).toContain('const c = useAtlas();');
    expect(out).not.toContain('useClerk');
  });

  it('renames clerkMiddleware to atlasMiddleware', () => {
    const out = run(
      [`import { clerkMiddleware } from '@clerk/nextjs';`, `export default clerkMiddleware();`].join(
        '\n',
      ),
    );
    expect(out).toContain(`import { atlasMiddleware } from '@atlasauth/nextjs'`);
    expect(out).toContain('export default atlasMiddleware();');
  });

  it('keeps an aliased import working (renames the imported name only)', () => {
    const out = run(
      [`import { ClerkProvider as Provider } from '@clerk/clerk-react';`, `const x = Provider;`].join(
        '\n',
      ),
    );
    expect(out).toContain('AtlasProvider as Provider');
    // The local alias and its usage are already correct, so they stay.
    expect(out).toContain('const x = Provider;');
  });

  it('does not touch an unrelated property that shares the name', () => {
    const out = run(
      [
        `import { useClerk } from '@clerk/clerk-react';`,
        `const o = { useClerk: 1 };`,
        `const v = useClerk();`,
      ].join('\n'),
    );
    // object key stays; the call reference is renamed.
    expect(out).toContain('{ useClerk: 1 }');
    expect(out).toContain('const v = useAtlas();');
  });
});

describe('clerk-to-atlas: environment variables', () => {
  it('rewrites process.env.CLERK_* and NEXT_PUBLIC_CLERK_*', () => {
    const out = run(
      [
        `const s = process.env.CLERK_SECRET_KEY;`,
        `const p = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;`,
      ].join('\n'),
    );
    expect(out).toContain('process.env.ATLAS_SECRET_KEY');
    expect(out).toContain('process.env.NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(out).not.toContain('CLERK_');
  });

  it('rewrites bracketed and import.meta.env env access', () => {
    const out = run(
      [`const a = process.env['CLERK_SECRET_KEY'];`, `const b = import.meta.env.CLERK_API_URL;`].join(
        '\n',
      ),
    );
    expect(out).toContain(`'ATLAS_SECRET_KEY'`);
    expect(out).toContain('import.meta.env.ATLAS_API_URL');
  });
});

describe('clerk-to-atlas: deferrals and no-ops', () => {
  it('leaves a TODO for a Clerk symbol with no Atlas equivalent', () => {
    const out = run(`import { clerkPlugin, someClerkOnly } from '@clerk/clerk-react';`);
    expect(out).toContain(`from '@atlasauth/react'`);
    expect(out).toContain('TODO(atlas-upgrade):');
    expect(out).toContain('clerkPlugin');
    expect(out).toContain('someClerkOnly');
  });

  it('flags an unmapped Clerk package but keeps the import', () => {
    const out = run(`import x from '@clerk/some-future-package';`);
    expect(out).toContain('TODO(atlas-upgrade):');
    expect(out).toContain('@clerk/some-future-package');
  });

  it('does NOT add a TODO for a shared, same-named symbol', () => {
    const out = run(`import { SignedIn } from '@clerk/clerk-react';`);
    expect(out).toContain(`from '@atlasauth/react'`);
    expect(out).toContain('SignedIn');
    expect(out).not.toContain('TODO(atlas-upgrade):');
  });

  it('returns undefined for non-Clerk code (untouched)', () => {
    const out = run(
      [`import { useState } from 'react';`, `const [n] = useState(0);`].join('\n'),
    );
    expect(out).toBeUndefined();
  });

  it('reports counts through the onCount sink', () => {
    const kinds: string[] = [];
    run(
      [`import { ClerkProvider } from '@clerk/clerk-react';`, `const x = <ClerkProvider />;`].join(
        '\n',
      ),
      { onCount: (k) => kinds.push(k) },
    );
    expect(kinds).toContain('import');
    expect(kinds).toContain('identifier');
  });
});
