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

function run(source: string, options: ClerkToAtlasOptions = {}, path = 'test.tsx'): string | undefined {
  return transform({ path, source }, api, options);
}

const lines = (...l: string[]) => l.join('\n');

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
    // The React surface of @clerk/nextjs lives in @atlasauth/react.
    expect(out).toContain(`import { useAuth } from '@atlasauth/react'`);
    expect(out).toContain(`import { createAtlasClient } from '@atlasauth/backend'`);
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

  it('turns the Next.js clerkMiddleware() into an env-configured, all-public createAtlasMiddleware()', () => {
    const out = run(
      [`import { clerkMiddleware } from '@clerk/nextjs';`, `export default clerkMiddleware();`].join(
        '\n',
      ),
    );
    expect(out).toContain(`import { createAtlasMiddleware } from '@atlasauth/nextjs/compat'`);
    // Clerk's middleware protects nothing by default; Atlas's protects what is not public.
    expect(out).toContain(`export default createAtlasMiddleware({ publicRoutes: ['/(.*)'] });`);
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

describe('clerk-to-atlas: Next.js', () => {
  it('sends the React surface of @clerk/nextjs to @atlasauth/react and gives the provider its keys', () => {
    const out = run(
      lines(
        `import { ClerkProvider, SignedIn, UserButton } from '@clerk/nextjs';`,
        `export default function RootLayout({ children }: { children: React.ReactNode }) {`,
        `  return (`,
        `    <ClerkProvider afterSignOutUrl="/">`,
        `      <SignedIn><UserButton /></SignedIn>`,
        `      {children}`,
        `    </ClerkProvider>`,
        `  );`,
        `}`,
      ),
    );
    expect(out).toContain(`import { AtlasProvider, SignedIn, UserButton } from '@atlasauth/react'`);
    expect(out).toContain('publishableKey={process.env.NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY!}');
    expect(out).toContain('frontendApi={process.env.NEXT_PUBLIC_ATLAS_FRONTEND_API!}');
    expect(out).not.toContain('afterSignOutUrl="/"');
    expect(out).toContain('TODO(atlas-upgrade): AtlasProvider: removed Clerk-only props afterSignOutUrl');
    expect(out).not.toContain('@clerk/');
  });

  it('maps @clerk/nextjs/server: auth and currentUser stay, clerkClient becomes atlasClient()', () => {
    const out = run(
      lines(
        `import { auth, currentUser, clerkClient } from '@clerk/nextjs/server';`,
        `export async function GET() {`,
        `  const { userId } = await auth();`,
        `  const user = await currentUser();`,
        `  const org = await clerkClient.organizations.getOrganization({ organizationId: 'org_1' });`,
        `  return Response.json({ userId, user, org });`,
        `}`,
      ),
    );
    expect(out).toContain(`import { auth, currentUser, atlasClient } from '@atlasauth/nextjs/server'`);
    expect(out).toContain('await atlasClient().organizations.getOrganization(');
    expect(out).toContain('TODO(atlas-upgrade): atlasClient(): resource methods differ from Clerk');
    expect(out).not.toContain('auth() returns a Promise');
    expect(out).not.toContain('currentUser(): the Atlas user is');
  });

  it('flags a non-awaited auth(), auth.protect() and Clerk-only User fields', () => {
    const out = run(
      lines(
        `import { auth, currentUser } from '@clerk/nextjs/server';`,
        `export async function Page() {`,
        `  const { userId } = auth();`,
        `  await auth.protect();`,
        `  const user = await currentUser();`,
        `  return user ? user.emailAddresses[0].emailAddress : userId;`,
        `}`,
      ),
    );
    expect(out).toContain('TODO(atlas-upgrade): auth() returns a Promise in Atlas: await it');
    expect(out).toContain('TODO(atlas-upgrade): auth.protect(): Atlas has no static auth.protect');
    expect(out).toContain('TODO(atlas-upgrade): currentUser(): the Atlas user is { id, email, name');
  });

  it('flags auth() fields Atlas does not return', () => {
    const out = run(
      lines(
        `import { auth } from '@clerk/nextjs/server';`,
        `export async function GET() {`,
        `  const { userId, getToken } = await auth();`,
        `  return Response.json({ userId, token: await getToken() });`,
        `}`,
      ),
    );
    expect(out).toContain('no getToken');
  });

  it('splits middleware imports and reports a clerkMiddleware handler', () => {
    const out = run(
      lines(
        `import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';`,
        `const isProtected = createRouteMatcher(['/dashboard(.*)']);`,
        `export default clerkMiddleware(async (auth, req) => {`,
        `  if (isProtected(req)) await auth.protect();`,
        `});`,
      ),
    );
    expect(out).toContain(`import { createAtlasMiddleware } from '@atlasauth/nextjs/compat'`);
    expect(out).toContain(`import { createRouteMatcher } from '@atlasauth/nextjs'`);
    expect(out).toContain('clerkMiddleware(handler): createAtlasMiddleware takes options, not a handler');
    expect(out).toContain('export default createAtlasMiddleware(async (auth, req) => {');
  });

  it('leaves webhook verification on Clerk with a precise TODO', () => {
    const out = run(`import { verifyWebhook } from '@clerk/nextjs/webhooks';`);
    expect(out).toContain(`import { verifyWebhook } from '@clerk/nextjs/webhooks'`);
    expect(out).toContain('verifyWebhook({ body: await req.text(), headers: req.headers, secret: process.env.ATLAS_WEBHOOK_SIGNING_SECRET })');
  });

  it('rewrites a require() of a subpath to its Atlas module', () => {
    const out = run(`const { auth } = require('@clerk/nextjs/server');`);
    expect(out).toContain(`require('@atlasauth/nextjs/server')`);
  });
});

describe('clerk-to-atlas: server adapters', () => {
  it('@clerk/express: config as options, requireAuth note, req.auth -> getAuth(req)', () => {
    const source = lines(
      `import express from 'express';`,
      `import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express';`,
      `const app = express();`,
      `app.use(clerkMiddleware());`,
      `app.get('/me', requireAuth(), (req, res) => {`,
      `  res.json({ userId: req.auth.userId, again: getAuth(req).userId });`,
      `});`,
    );
    const out = run(source, {}, 'server.ts');
    expect(out).toContain(`import { atlasMiddleware, requireAuth, getAuth } from '@atlasauth/express'`);
    expect(out).toContain('app.use(atlasMiddleware({ jwksUrl: process.env.ATLAS_JWKS_URL!, issuer: process.env.ATLAS_ISSUER! }));');
    expect(out).toContain(`app.get('/me', requireAuth({ jwksUrl: process.env.ATLAS_JWKS_URL!, issuer: process.env.ATLAS_ISSUER! }), (req, res) => {`);
    expect(out).toContain('userId: getAuth(req).userId');
    expect(out).toContain('TODO(atlas-upgrade): requireAuth(): Atlas answers a signed-out request with 401 JSON');
    expect(out).not.toContain('req.auth');
    // Idempotent: nothing Clerk is left to rewrite.
    expect(run(out!, {}, 'server.ts')).toBeUndefined();
  });

  it('reports middleware options that need the Atlas config', () => {
    const out = run(
      lines(`import { clerkMiddleware } from '@clerk/express';`, `app.use(clerkMiddleware({ secretKey: 'sk' }));`),
      {},
      'server.js',
    );
    expect(out).toContain('atlasMiddleware(options): Atlas needs { jwksUrl: process.env.ATLAS_JWKS_URL, issuer: process.env.ATLAS_ISSUER }');
  });

  it('@clerk/clerk-sdk-node: ClerkExpressRequireAuth -> requireAuth (no `!` in JavaScript)', () => {
    const out = run(
      lines(
        `import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';`,
        `app.get('/me', ClerkExpressRequireAuth(), (req, res) => res.json(req.auth));`,
      ),
      {},
      'server.js',
    );
    expect(out).toContain(`import { requireAuth, getAuth } from '@atlasauth/express'`);
    expect(out).toContain('requireAuth({ jwksUrl: process.env.ATLAS_JWKS_URL, issuer: process.env.ATLAS_ISSUER })');
    expect(out).toContain('res.json(getAuth(req))');
  });

  it('@clerk/fastify: register(clerkPlugin) -> register(atlasPlugin, { jwksUrl, issuer })', () => {
    const out = run(
      lines(
        `import Fastify from 'fastify';`,
        `import { clerkPlugin, getAuth } from '@clerk/fastify';`,
        `const fastify = Fastify();`,
        `fastify.register(clerkPlugin);`,
      ),
      {},
      'server.ts',
    );
    expect(out).toContain(`import { atlasPlugin, getAuth } from '@atlasauth/fastify'`);
    expect(out).toContain('fastify.register(atlasPlugin, { jwksUrl: process.env.ATLAS_JWKS_URL!, issuer: process.env.ATLAS_ISSUER! });');
  });

  it('@hono/clerk-auth -> @atlasauth/hono', () => {
    const out = run(
      lines(
        `import { Hono } from 'hono';`,
        `import { clerkMiddleware, getAuth } from '@hono/clerk-auth';`,
        `const app = new Hono();`,
        `app.use('*', clerkMiddleware());`,
      ),
      {},
      'src/index.ts',
    );
    expect(out).toContain(`import { atlasMiddleware, getAuth } from '@atlasauth/hono'`);
    expect(out).toContain(`app.use('*', atlasMiddleware({ jwksUrl: process.env.ATLAS_JWKS_URL!, issuer: process.env.ATLAS_ISSUER! }));`);
    expect(out).toContain('on Cloudflare Workers (no process.env)');
  });

  it('@clerk/backend: createClerkClient -> createAtlasClient; verifyToken stays with a TODO', () => {
    const out = run(
      lines(
        `import { createClerkClient, verifyToken } from '@clerk/backend';`,
        `const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });`,
      ),
      {},
      'server.js',
    );
    expect(out).toContain(`import { verifyToken } from '@clerk/backend'`);
    expect(out).toContain(`import { createAtlasClient } from '@atlasauth/backend'`);
    expect(out).toContain('createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY })');
    expect(out).toContain('verifyToken(token, opts): use new AtlasBackend(');
  });
});

describe('clerk-to-atlas: other frameworks', () => {
  it('@clerk/react (current package name) -> @atlasauth/react', () => {
    const out = run(`import { SignedIn, useUser } from '@clerk/react';`);
    expect(out).toContain(`import { SignedIn, useUser } from '@atlasauth/react'`);
    expect(out).not.toContain('TODO');
  });

  it('derives frontendApi from how a Vite app reads its publishable key', () => {
    const out = run(
      lines(
        `import { ClerkProvider } from '@clerk/clerk-react';`,
        `const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;`,
        `createRoot(el).render(<ClerkProvider publishableKey={PUBLISHABLE_KEY}><App /></ClerkProvider>);`,
      ),
    );
    expect(out).toContain('import.meta.env.VITE_ATLAS_PUBLISHABLE_KEY');
    expect(out).toContain('frontendApi={import.meta.env.VITE_ATLAS_FRONTEND_API}');
    expect(out).not.toContain('TODO');
  });

  it('@clerk/react-router: React surface and the server loaders', () => {
    const server = run(`import { rootAuthLoader, getAuth } from '@clerk/react-router/ssr.server';`);
    expect(server).toContain(`import { rootAuthLoader, getAuth } from '@atlasauth/react-router'`);
    expect(server).not.toContain('TODO');

    const root = run(
      lines(
        `import { ClerkProvider } from '@clerk/react-router';`,
        `export default function App({ loaderData }) {`,
        `  return <ClerkProvider loaderData={loaderData}><Outlet /></ClerkProvider>;`,
        `}`,
      ),
    );
    expect(root).toContain(`import { AtlasProvider } from '@atlasauth/react-router'`);
    expect(root).toContain('publishableKey={import.meta.env.VITE_ATLAS_PUBLISHABLE_KEY}');
    expect(root).toContain('frontendApi={import.meta.env.VITE_ATLAS_FRONTEND_API}');
    expect(root).toContain('removed Clerk-only props loaderData');
  });

  it('@clerk/remix has no Atlas adapter: flagged, not rewritten', () => {
    const out = run(`import { rootAuthLoader } from '@clerk/remix/ssr.server';`);
    expect(out).toContain(`import { rootAuthLoader } from '@clerk/remix/ssr.server'`);
    expect(out).toContain('Atlas has no Remix adapter: upgrade to React Router v7');
  });

  it('@clerk/tanstack-react-start/server: getAuth moves, createClerkHandler is reported', () => {
    const out = run(`import { getAuth, createClerkHandler } from '@clerk/tanstack-react-start/server';`);
    expect(out).toContain(`import { createClerkHandler } from '@clerk/tanstack-react-start/server'`);
    expect(out).toContain(`import { getAuth } from '@atlasauth/tanstack-react-start'`);
    expect(out).toContain('createAtlasHandler()');
  });

  it('@clerk/astro: the default integration export becomes atlasAstro()', () => {
    const out = run(
      lines(
        `import { defineConfig } from 'astro/config';`,
        `import clerk from '@clerk/astro';`,
        `export default defineConfig({ integrations: [clerk()] });`,
      ),
      {},
      'astro.config.mjs',
    );
    expect(out).toContain(`import { atlasAstro } from '@atlasauth/astro'`);
    expect(out).toContain('integrations: [atlasAstro()]');
  });

  it('@clerk/astro/server: clerkMiddleware -> atlasMiddleware', () => {
    const out = run(lines(`import { clerkMiddleware } from '@clerk/astro/server';`, `export const onRequest = clerkMiddleware();`), {}, 'src/middleware.ts');
    expect(out).toContain(`import { atlasMiddleware } from '@atlasauth/astro/server'`);
    expect(out).toContain('export const onRequest = atlasMiddleware();');
    expect(out).toContain('context.locals.atlas');
  });

  it('nuxt.config: the module name and its config key', () => {
    const out = run(
      lines(`export default defineNuxtConfig({`, `  modules: ['@clerk/nuxt'],`, `  clerk: { skipServerMiddleware: true },`, `});`),
      {},
      'nuxt.config.ts',
    );
    expect(out).toContain(`modules: ['@atlasauth/nuxt']`);
    expect(out).toContain('atlas: {');
  });

  it('@clerk/nuxt/server helpers are reported', () => {
    const out = run(`import { clerkClient } from '@clerk/nuxt/server';`, {}, 'server/api/me.ts');
    expect(out).toContain(`import { clerkClient } from '@clerk/nuxt/server'`);
    expect(out).toContain('createAtlasClientFromEnv()');
  });

  it('@clerk/vue: composables move, clerkPlugin is reported', () => {
    const out = run(lines(`import { clerkPlugin, useUser, useClerk } from '@clerk/vue';`), {}, 'src/main.ts');
    expect(out).toContain(`import { clerkPlugin } from '@clerk/vue'`);
    expect(out).toContain(`import { useUser, useAtlas } from '@atlasauth/vue'`);
    expect(out).toContain('app.use(createAtlas({ publishableKey, frontendApi }))');
  });

  it('@clerk/clerk-expo: only the hooks Atlas Expo has, plus the token cache note', () => {
    const out = run(
      lines(
        `import { ClerkProvider, useAuth, useSignIn, useClerk } from '@clerk/clerk-expo';`,
        `import { tokenCache } from '@clerk/clerk-expo/token-cache';`,
        `export default function Layout() {`,
        `  return <ClerkProvider tokenCache={tokenCache}><Slot /></ClerkProvider>;`,
        `}`,
      ),
      {},
      'app/_layout.tsx',
    );
    expect(out).toContain(`import { AtlasProvider, useAuth, useSignIn } from '@atlasauth/expo'`);
    expect(out).toContain(`import { useAtlas } from '@atlasauth/react'`);
    expect(out).toContain('no 1:1 Atlas equivalent for: useSignIn');
    expect(out).toContain('createSecureStoreTokenCache(SecureStore)');
    expect(out).toContain('publishableKey={process.env.EXPO_PUBLIC_ATLAS_PUBLISHABLE_KEY!}');
    expect(out).toContain('frontendApi={process.env.EXPO_PUBLIC_ATLAS_FRONTEND_API!}');
  });

  it('@clerk/chrome-extension: React surface from @atlasauth/chrome-extension/react', () => {
    const out = run(
      lines(
        `import { ClerkProvider, SignedIn } from '@clerk/chrome-extension';`,
        `export const Popup = () => (`,
        `  <ClerkProvider publishableKey={process.env.PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY} syncHost="https://app.example.com">`,
        `    <SignedIn>hi</SignedIn>`,
        `  </ClerkProvider>`,
        `);`,
      ),
      {},
      'popup.tsx',
    );
    expect(out).toContain(`import { AtlasProvider, SignedIn } from '@atlasauth/chrome-extension/react'`);
    expect(out).toContain('publishableKey={process.env.PLASMO_PUBLIC_ATLAS_PUBLISHABLE_KEY}');
    expect(out).toContain('frontendApi={process.env.PLASMO_PUBLIC_ATLAS_FRONTEND_API!}');
    expect(out).toContain('removed Clerk-only props syncHost');
  });

  it('@clerk/types -> @atlasauth/types for the shared type names', () => {
    const out = run(`import type { Appearance, UserResource } from '@clerk/types';`);
    expect(out).toContain(`import type { Appearance, UserResource } from '@atlasauth/types'`);
    expect(out).toContain('no 1:1 Atlas equivalent for: UserResource');
  });

  it('flags a re-export from a Clerk package', () => {
    const out = run(`export { SignedIn } from '@clerk/clerk-react';`);
    expect(out).toContain(`re-export from '@clerk/clerk-react'`);
  });
});

describe('clerk-to-atlas: framework env prefixes', () => {
  it('renames CLERK_ keys behind VITE_, EXPO_PUBLIC_, PUBLIC_ and NUXT_PUBLIC_', () => {
    const out = run(
      lines(
        `const a = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;`,
        `const b = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;`,
        `const c = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY;`,
        `const d = process.env.NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY;`,
        `const e = process.env.CLERK_WEBHOOK_SIGNING_SECRET;`,
      ),
    );
    expect(out).toContain('import.meta.env.VITE_ATLAS_PUBLISHABLE_KEY');
    expect(out).toContain('process.env.EXPO_PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(out).toContain('import.meta.env.PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(out).toContain('process.env.NUXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(out).toContain('process.env.ATLAS_WEBHOOK_SIGNING_SECRET');
    expect(out).not.toContain('CLERK_');
  });
});
