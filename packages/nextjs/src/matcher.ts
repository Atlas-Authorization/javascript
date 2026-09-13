/**
 * §10.1 `@atlasauth/nextjs`: "route protection matcher config".
 *
 * The single most consequential decision in this package is the DEFAULT. A
 * matcher that treats unlisted routes as public means every new page a
 * developer adds ships unprotected, and nothing anywhere reports it — the page
 * simply works, for everyone, including people who are not signed in. So the
 * default is deny: a route is protected unless it matches a public pattern.
 *
 * That is the opposite of comfortable. It means a developer who forgets to list
 * their marketing page gets redirected to sign-in and notices immediately,
 * which is a loud failure rather than a silent breach.
 */

/**
 * Patterns support one wildcard form: `(.*)` at the end, matching Next.js's own
 * matcher syntax so a developer writes one dialect rather than two.
 *
 * Deliberately NOT a general regex. A customer-authored regex in an
 * authorization path is a catastrophic-backtracking outage waiting to happen,
 * and `/admin(.*)` covers what anyone actually needs.
 */
export function matchesPattern(pathname: string, pattern: string): boolean {
  if (pattern === pathname) return true;

  const wildcard = pattern.indexOf('(.*)');
  if (wildcard === -1) return false;

  // Anything after the wildcard is meaningless — `(.*)` already matched it.
  const prefix = pattern.slice(0, wildcard);
  return pathname.startsWith(prefix);
}

export function matchesAny(pathname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(pathname, pattern));
}

/**
 * Paths that are never auth decisions.
 *
 * Running auth on every image request is a measurable cost on a page with forty
 * assets, and a redirect on a `.css` file breaks the page rather than
 * protecting it.
 */
const ALWAYS_SKIPPED = ['/_next/', '/favicon.ico', '/robots.txt', '/sitemap.xml', '/.well-known/'];

export function isStaticAsset(pathname: string): boolean {
  if (ALWAYS_SKIPPED.some((prefix) => pathname.startsWith(prefix))) return true;
  // A dotted final segment is a file, not a page.
  const last = pathname.split('/').pop() ?? '';
  return last.includes('.');
}

export interface MiddlewareConfig {
  /** Routes reachable without a session. Everything else requires one. */
  publicRoutes?: readonly string[];
  /** Routes that require a session even if a public pattern would match them. */
  protectedRoutes?: readonly string[];
  signInUrl?: string;
  /** Exact origins a `redirect_url` may point at (§13.1). */
  allowedOrigins?: readonly string[];
}

export const DEFAULT_SIGN_IN_URL = '/sign-in';

export type RouteDecision =
  | { action: 'skip' }
  | { action: 'allow' }
  | { action: 'redirect'; to: string }
  | { action: 'unauthorized' };

/**
 * Decide what to do with a request.
 *
 * `protectedRoutes` wins over `publicRoutes` deliberately. A developer who
 * writes `publicRoutes: ['/(.*)']` while iterating and then protects `/admin`
 * expects the narrower, more explicit rule to hold — and the failure of the
 * other precedence is that `/admin` is public.
 */
export function decideRoute(input: {
  pathname: string;
  signedIn: boolean;
  config?: MiddlewareConfig;
  /** For API routes, a redirect is useless — the caller wants a 401. */
  isApiRoute?: boolean;
}): RouteDecision {
  const config = input.config ?? {};

  if (isStaticAsset(input.pathname)) return { action: 'skip' };

  const explicitlyProtected = matchesAny(input.pathname, config.protectedRoutes ?? []);
  const isPublic = !explicitlyProtected && matchesAny(input.pathname, config.publicRoutes ?? []);

  if (isPublic || input.signedIn) return { action: 'allow' };

  /**
   * An API route gets a 401, not a redirect. Redirecting a fetch to an HTML
   * sign-in page produces a JSON parse error in the caller's code, three
   * frames from the actual problem.
   */
  if (input.isApiRoute) return { action: 'unauthorized' };

  const signInUrl = config.signInUrl ?? DEFAULT_SIGN_IN_URL;
  return {
    action: 'redirect',
    to: `${signInUrl}?redirect_url=${encodeURIComponent(input.pathname)}`,
  };
}

/**
 * §13.1 open redirect: validate a `redirect_url` before sending anyone to it.
 *
 * A relative path is allowed because it cannot leave the site. An absolute URL
 * must match an allowed origin EXACTLY — prefix matching is how
 * `https://app.example.com.evil.test` gets accepted.
 */
export function safeRedirect(
  redirectUrl: string | null | undefined,
  allowedOrigins: readonly string[] = [],
  fallback = '/',
): string {
  if (!redirectUrl) return fallback;

  // Protocol-relative `//evil.test` is an absolute URL wearing a disguise.
  if (redirectUrl.startsWith('//')) return fallback;
  if (redirectUrl.startsWith('/')) return redirectUrl;

  try {
    const url = new URL(redirectUrl);
    return allowedOrigins.includes(url.origin) ? redirectUrl : fallback;
  } catch {
    return fallback;
  }
}
