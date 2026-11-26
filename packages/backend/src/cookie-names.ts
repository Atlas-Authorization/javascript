/**
 * Cookie names under per-instance cookie isolation (`session.cookieIsolation`). With it on, every Frontend API cookie
 * of an instance carries a short suffix derived from its publishable key (`__session_ab12cd34`), so two instances on
 * one host never read or overwrite each other's cookies. With it off nothing changes (`__session`). Readers try the
 * suffixed name and then the plain one, so they work whether or not the instance turned isolation on; code that
 * WRITES a cookie asks the Frontend API (`cookie_suffix`) instead of assuming.
 *
 * The suffix is the last 8 letters/digits of the publishable key (or of the instance id, which ends the same way),
 * lowercased, so it needs no configuration beyond what the backend already has.
 */

/** The suffix for a publishable key (or instance id). */
export function cookieSuffixForKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase();
}

export interface CookieNameOptions {
  /** The suffix itself, when you do not pass a key. An empty string means "not isolated" and wins over a key. */
  cookieSuffix?: string;
  /** The instance's publishable key: the suffix is derived from it. */
  publishableKey?: string;
}

/** The suffix these options name, or '' (not isolated). */
export function resolveCookieSuffix(options: CookieNameOptions = {}): string {
  if (typeof options.cookieSuffix === 'string') return options.cookieSuffix.replace(/^_+/, '');
  return options.publishableKey ? cookieSuffixForKey(options.publishableKey) : '';
}

/** `__session` -> `__session_ab12cd34` (the same name when there is no suffix). */
export function cookieNameFor(base: string, suffix: string | CookieNameOptions): string {
  const s = typeof suffix === 'string' ? suffix : resolveCookieSuffix(suffix);
  return s ? `${base}_${s}` : base;
}

/** One cookie value from a `Cookie` header, by exact name. */
export function readNamedCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * An Atlas cookie of a request: `<name>_<suffix>` first (an isolated instance), then the plain name (an instance that
 * does not isolate its cookies). The caller verifies what it reads (the session token's issuer, the CSRF token's
 * signature), so a cookie of another instance is never accepted.
 */
export function readAtlasCookie(header: string | null | undefined, base: string, suffix = ''): string | undefined {
  return (suffix ? readNamedCookie(header, cookieNameFor(base, suffix)) : undefined) ?? readNamedCookie(header, base);
}

/**
 * The session token cookie of a request: `__session_<suffix>` (an isolated instance), else `__session`. With no
 * suffix known, a request that carries exactly one `__session_<8 characters>` cookie and no `__session` is read from
 * that one, so an isolated instance works before the publishable key is configured.
 */
export function readSessionCookie(header: string | null | undefined, suffix = ''): string | undefined {
  if (!header) return undefined;
  const found = readAtlasCookie(header, '__session', suffix);
  if (found || suffix) return found;
  const candidates: string[] = [];
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key && /^__session_[a-z0-9]{8}$/.test(key)) candidates.push(rest.join('='));
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
