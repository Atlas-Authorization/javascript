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
 * Patterns support two forms, both from Next.js's own matcher dialect so a
 * developer writes one dialect rather than two:
 *
 * - `(.*)` at the end — matches the rest of the path (`/admin(.*)`).
 * - `:name` as a whole segment — matches exactly one non-empty segment
 *   (`/:locale/dashboard`). This is what makes locale-prefixed routing
 *   (next-intl and friends) expressible. When {@link PatternOptions.locales} is
 *   given, a `:locale` segment matches ONLY those values, so
 *   `/:locale/sign-in` can't make `/admin/sign-in` public by accident.
 *
 * Deliberately NOT a general regex. A customer-authored regex in an
 * authorization path is a catastrophic-backtracking outage waiting to happen,
 * and `/admin(.*)` covers what anyone actually needs.
 */
export interface PatternOptions {
  /** The app's locales. Restricts what a `:locale` pattern segment matches. */
  locales?: readonly string[];
}

function segmentMatches(actual: string, pattern: string, options: PatternOptions): boolean {
  if (!pattern.startsWith(':')) return actual === pattern;
  if (actual === '') return false;
  if (pattern === ':locale' && options.locales) return options.locales.includes(actual);
  return true;
}

export function matchesPattern(
  pathname: string,
  pattern: string,
  options: PatternOptions = {},
): boolean {
  if (pattern === pathname) return true;

  const wildcard = pattern.indexOf('(.*)');
  // Anything after the wildcard is meaningless — `(.*)` already matched it.
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);

  // No `:param` segment: the original string semantics, unchanged.
  if (!prefix.includes('/:')) {
    return wildcard !== -1 && pathname.startsWith(prefix);
  }

  const want = prefix.split('/');
  const have = pathname.split('/');
  if (wildcard === -1) {
    return (
      want.length === have.length &&
      want.every((segment, i) => segmentMatches(have[i]!, segment, options))
    );
  }

  // Wildcard: every segment but the last matches whole; the last one keeps the
  // string-prefix semantics (`/:locale/dash(.*)` matches `/en/dashboard`), and a
  // trailing `:param` must still be present.
  if (have.length < want.length) return false;
  const last = want.length - 1;
  for (let i = 0; i < last; i++) {
    if (!segmentMatches(have[i]!, want[i]!, options)) return false;
  }
  const tail = want[last]!;
  return tail.startsWith(':')
    ? segmentMatches(have[last]!, tail, options)
    : have[last]!.startsWith(tail);
}

export function matchesAny(
  pathname: string,
  patterns: readonly string[],
  options: PatternOptions = {},
): boolean {
  return patterns.some((pattern) => matchesPattern(pathname, pattern, options));
}

/**
 * §10.1 Clerk-parity `createRouteMatcher(patterns)` — the idiom integrators write
 * at the top of `middleware.ts` (`const isProtected = createRouteMatcher(['/dashboard(.*)'])`).
 * Returns a predicate over anything carrying a pathname: a Next `NextRequest`
 * (`req.nextUrl.pathname`), a plain `{ nextUrl }` / `{ url }`, or a bare path
 * string. Uses the SAME `(.*)`-only pattern engine as the middleware, so a
 * matcher written here and the middleware's own routing agree exactly (no second
 * dialect, no customer regex in the auth path).
 */
export function createRouteMatcher(
  patterns: readonly string[],
  options: PatternOptions = {},
): (input: string | { nextUrl?: { pathname?: string }; url?: string }) => boolean {
  return (input) => {
    let pathname: string;
    if (typeof input === 'string') {
      // Accept a full URL or a bare path.
      pathname = input.startsWith('http') ? new URL(input).pathname : input;
    } else {
      pathname =
        input.nextUrl?.pathname ?? (input.url ? new URL(input.url, 'http://x').pathname : '');
    }
    return matchesAny(pathname, patterns, options);
  };
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
  /**
   * The app's locales, for locale-prefixed routing (next-intl and similar). A
   * `:locale` segment in `publicRoutes`/`protectedRoutes` then matches only
   * these values, and a `signInUrl` containing `/:locale` is filled in from the
   * request's own locale prefix.
   */
  locales?: readonly string[];
  /** Locale used for a `/:locale` sign-in URL when the request carries none. When
   *  absent, the `/:locale` segment is dropped and the i18n layer picks one. */
  defaultLocale?: string;
}

/**
 * Fill a `signInUrl` like `/:locale/sign-in` from the request path's locale
 * prefix, so a signed-out visitor on `/de/dashboard` lands on `/de/sign-in`
 * rather than bouncing through the i18n layer's own redirect.
 */
export function localizeSignInUrl(
  signInUrl: string,
  pathname: string,
  config: Pick<MiddlewareConfig, 'locales' | 'defaultLocale'> = {},
): string {
  if (!signInUrl.includes('/:locale')) return signInUrl;
  const first = pathname.split('/')[1] ?? '';
  const locale = config.locales?.includes(first) ? first : config.defaultLocale;
  return locale
    ? signInUrl.replace('/:locale', `/${locale}`)
    : signInUrl.replace('/:locale', '') || '/';
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

  const patternOptions: PatternOptions = { locales: config.locales };
  const explicitlyProtected = matchesAny(
    input.pathname,
    config.protectedRoutes ?? [],
    patternOptions,
  );
  const isPublic =
    !explicitlyProtected && matchesAny(input.pathname, config.publicRoutes ?? [], patternOptions);

  if (isPublic || input.signedIn) return { action: 'allow' };

  /**
   * An API route gets a 401, not a redirect. Redirecting a fetch to an HTML
   * sign-in page produces a JSON parse error in the caller's code, three
   * frames from the actual problem.
   */
  if (input.isApiRoute) return { action: 'unauthorized' };

  const signInUrl = localizeSignInUrl(config.signInUrl ?? DEFAULT_SIGN_IN_URL, input.pathname, config);
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
