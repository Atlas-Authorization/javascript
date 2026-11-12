import { Readable } from 'node:stream';
import type { RequestHandler } from 'express';
import { createMountHandler, type AtlasMountOptions } from '@atlasauth/backend';

/**
 * Serve Atlas's Frontend API under a path of your Express app. Register it BEFORE `express.json()` and
 * other body parsers (the proxy streams the raw body): `app.use('/atlas', atlasMountMiddleware({ basePath: '/atlas' }))`.
 * Same behaviour as `createMountHandler` in `@atlasauth/nextjs` (allow-lists, `clientIp` / `trustedProxyHops`, 503 without config).
 */
export function atlasMountMiddleware(options: AtlasMountOptions = {}): RequestHandler {
  const mount = createMountHandler({ sdk: { name: '@atlasauth/express', version: '0.8.0' }, ...options });
  return async (req, res, next) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v !== undefined) headers.set(k, v);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const out = await mount.GET(
        new Request(`${req.protocol}://${req.headers.host ?? 'localhost'}${req.originalUrl}`, {
          method: req.method,
          headers,
          body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
          ...(hasBody ? { duplex: 'half' } : {}),
        } as RequestInit),
      );
      res.status(out.status);
      out.headers.forEach((value, key) => key !== 'set-cookie' && res.setHeader(key, value));
      const cookies = (out.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (out.body) Readable.fromWeb(out.body as never).pipe(res);
      else res.end();
    } catch (e) {
      next(e);
    }
  };
}
