import express from 'express';
import { atlasMiddleware, getAuth, requireAuth } from '@atlasauth/express';

const options = {
  jwksUrl: process.env.ATLAS_JWKS_URL ?? '',
  issuer: process.env.ATLAS_ISSUER ?? '',
};

const app = express();

// Verifies the session token locally against cached signing keys: no call to Atlas per request.
app.use(atlasMiddleware(options));

app.get('/', (_req, res) => {
  res.send('{{PROJECT_NAME}}: an Express API with Atlas auth');
});

// A protected route: requireAuth() answers 401 to an anonymous caller.
app.get('/me', requireAuth(options), (req, res) => {
  const auth = getAuth(req);
  res.json({ userId: auth.userId, orgId: auth.orgId });
});

app.listen(Number(process.env.PORT ?? 3000));
