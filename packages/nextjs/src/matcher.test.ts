import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGN_IN_URL,
  decideRoute,
  isStaticAsset,
  matchesAny,
  matchesPattern,
  safeRedirect,
} from './matcher';

describe('pattern matching', () => {
  it('matches an exact path', () => {
    expect(matchesPattern('/sign-in', '/sign-in')).toBe(true);
    expect(matchesPattern('/sign-up', '/sign-in')).toBe(false);
  });

  it('matches a prefix wildcard', () => {
    expect(matchesPattern('/sign-in/factor-two', '/sign-in(.*)')).toBe(true);
    expect(matchesPattern('/sign-in', '/sign-in(.*)')).toBe(true);
    expect(matchesPattern('/dashboard', '/sign-in(.*)')).toBe(false);
  });

  it('matches the root wildcard', () => {
    expect(matchesPattern('/anything/at/all', '/(.*)')).toBe(true);
  });

  /**
   * Deliberately not a general regex. A customer-authored regex in an
   * authorization path is a catastrophic-backtracking outage waiting to happen.
   */
  it('treats a regex-looking pattern literally rather than compiling it', () => {
    expect(matchesPattern('/aaaaaaaaaa', '/a+')).toBe(false);
    expect(matchesPattern('/x', '^/.*$')).toBe(false);
  });

  it('checks a list', () => {
    const patterns = ['/', '/sign-in(.*)', '/sign-up(.*)'];
    expect(matchesAny('/sign-in/sso', patterns)).toBe(true);
    expect(matchesAny('/dashboard', patterns)).toBe(false);
  });
});

/**
 * Running auth on every image request is a measurable cost on a page with forty
 * assets, and a redirect on a `.css` file breaks the page rather than
 * protecting it.
 */
describe('static assets', () => {
  it('skips build output and well-known files', () => {
    for (const path of [
      '/_next/static/chunk.js',
      '/favicon.ico',
      '/robots.txt',
      '/.well-known/jwks.json',
    ]) {
      expect(isStaticAsset(path), path).toBe(true);
    }
  });

  it('treats a dotted final segment as a file', () => {
    expect(isStaticAsset('/images/logo.png')).toBe(true);
    expect(isStaticAsset('/styles/app.css')).toBe(true);
  });

  it('does not mistake a page for a file', () => {
    expect(isStaticAsset('/dashboard')).toBe(false);
    expect(isStaticAsset('/organizations/acme/settings')).toBe(false);
  });
});

/**
 * The single most consequential decision in this package. A matcher that
 * treated unlisted routes as public would ship every new page unprotected, and
 * nothing anywhere would report it.
 */
describe('the default is deny', () => {
  it('protects a route nobody listed', () => {
    const decision = decideRoute({ pathname: '/dashboard', signedIn: false });
    expect(decision.action).toBe('redirect');
  });

  it('protects a route even with a publicRoutes list that does not cover it', () => {
    const decision = decideRoute({
      pathname: '/admin/secrets',
      signedIn: false,
      config: { publicRoutes: ['/', '/sign-in(.*)'] },
    });
    expect(decision.action).toBe('redirect');
  });

  it('allows a listed public route to a signed-out visitor', () => {
    const decision = decideRoute({
      pathname: '/sign-in/factor-two',
      signedIn: false,
      config: { publicRoutes: ['/sign-in(.*)'] },
    });
    expect(decision).toEqual({ action: 'allow' });
  });

  it('allows any route to a signed-in user', () => {
    expect(decideRoute({ pathname: '/dashboard', signedIn: true })).toEqual({ action: 'allow' });
  });

  /**
   * `protectedRoutes` wins. A developer who writes `publicRoutes: ['/(.*)']`
   * while iterating and then protects `/admin` expects the narrower, more
   * explicit rule to hold — the other precedence makes `/admin` public.
   */
  it('lets an explicit protection override a broad public pattern', () => {
    const decision = decideRoute({
      pathname: '/admin/users',
      signedIn: false,
      config: { publicRoutes: ['/(.*)'], protectedRoutes: ['/admin(.*)'] },
    });
    expect(decision.action).toBe('redirect');
  });

  it('skips static assets before any auth decision', () => {
    expect(decideRoute({ pathname: '/_next/static/x.js', signedIn: false })).toEqual({
      action: 'skip',
    });
  });
});

describe('what an unauthenticated request receives', () => {
  it('redirects a page request and remembers where it was going', () => {
    const decision = decideRoute({ pathname: '/dashboard/billing', signedIn: false });
    expect(decision).toEqual({
      action: 'redirect',
      to: `${DEFAULT_SIGN_IN_URL}?redirect_url=%2Fdashboard%2Fbilling`,
    });
  });

  it('honours a custom sign-in URL', () => {
    const decision = decideRoute({
      pathname: '/dashboard',
      signedIn: false,
      config: { signInUrl: '/login' },
    });
    expect(decision.action === 'redirect' && decision.to.startsWith('/login')).toBe(true);
  });

  /**
   * Redirecting a fetch to an HTML sign-in page produces a JSON parse error in
   * the caller's code, three frames from the actual problem.
   */
  it('gives an API route a 401 rather than a redirect', () => {
    expect(decideRoute({ pathname: '/api/orders', signedIn: false, isApiRoute: true })).toEqual({
      action: 'unauthorized',
    });
  });
});

/**
 * §13.1 open redirect. This is the classic phishing primitive: a link to the
 * customer's own domain that bounces the user somewhere else after sign-in.
 */
describe('validating a return URL', () => {
  it('allows a relative path, which cannot leave the site', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard');
  });

  it('refuses an absolute URL that is not allowed', () => {
    expect(safeRedirect('https://evil.test/steal', ['https://app.example.com'])).toBe('/');
  });

  it('allows an exactly-matching origin', () => {
    expect(safeRedirect('https://app.example.com/after', ['https://app.example.com'])).toBe(
      'https://app.example.com/after',
    );
  });

  /**
   * Prefix matching is how `https://app.example.com.evil.test` gets accepted.
   */
  it('refuses a lookalike that merely starts with an allowed origin', () => {
    expect(safeRedirect('https://app.example.com.evil.test/x', ['https://app.example.com'])).toBe(
      '/',
    );
  });

  it('refuses a protocol-relative URL', () => {
    // `//evil.test` is an absolute URL wearing a disguise.
    expect(safeRedirect('//evil.test/steal', ['https://app.example.com'])).toBe('/');
  });

  it('refuses a scheme change on an allowed host', () => {
    expect(safeRedirect('http://app.example.com/x', ['https://app.example.com'])).toBe('/');
  });

  it('falls back for junk rather than throwing', () => {
    for (const value of ['not a url', '', null, undefined, 'javascript:alert(1)']) {
      expect(safeRedirect(value, ['https://app.example.com']), String(value)).toBe('/');
    }
  });

  it('uses the supplied fallback', () => {
    expect(safeRedirect('https://evil.test', [], '/home')).toBe('/home');
  });
});
