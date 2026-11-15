import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { atlasMiddleware, getAuth } from '@atlasauth/hono';

const app = new Hono();

// Verifies the session token locally against cached signing keys: no call to Atlas per request.
app.use(
  '*',
  atlasMiddleware({
    jwksUrl: process.env.ATLAS_JWKS_URL ?? '',
    issuer: process.env.ATLAS_ISSUER ?? '',
  }),
);

app.get('/', (c) => c.text('{{PROJECT_NAME}}: a Hono API with Atlas auth'));

// A protected route: the server answers 401 to an anonymous caller.
app.get('/me', (c) => {
  const auth = getAuth(c);
  if (!auth.isSignedIn) return c.json({ error: 'unauthenticated' }, 401);
  return c.json({ userId: auth.userId, orgId: auth.orgId });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
