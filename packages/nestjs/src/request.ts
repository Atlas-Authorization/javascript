import type { ExecutionContext } from '@nestjs/common';
import type { AuthorizedSession } from '@atlasauth/backend';

/**
 * The minimal request shape this adapter reads and decorates. Kept structural —
 * and read through `switchToHttp()` — so the package works behind BOTH the
 * Express and the Fastify Nest adapters, neither of which it type-depends on.
 * Both hand the handler a request whose `headers` is a lower-cased object, which
 * is all we touch.
 */
export interface AtlasRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Decorated by {@link AtlasGuard} on a verified request; read it via the
   *  `@AtlasAuth()` / `@CurrentUser()` param decorators. */
  atlas?: AuthorizedSession;
  [key: string]: unknown;
}

/** Pull the HTTP request out of a Nest execution context, typed as {@link AtlasRequest}. */
export function getRequest(context: ExecutionContext): AtlasRequest {
  return context.switchToHttp().getRequest<AtlasRequest>();
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Pull the session JWT off a request: an `Authorization: Bearer <jwt>` header,
 * or the `__session` cookie. The header wins, because a caller that set it
 * deliberately should not be overridden by a stale cookie — the same precedence
 * `@atlasauth/backend`, `@atlasauth/express` and `@atlasauth/fastify` apply.
 */
export function extractToken(request: AtlasRequest): string | undefined {
  const headers = request.headers ?? {};
  const header = firstHeader(headers.authorization ?? headers.Authorization);
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookie = readCookie(firstHeader(headers.cookie), '__session');
  return bearer ?? cookie;
}
