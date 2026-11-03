/**
 * Provider configuration checks shared by every framework SDK that wraps this
 * package (React, Vue, Svelte, Angular, Solid, Qwik, React Native, …).
 *
 * The one that matters is `frontendApi`. The publishable key encodes the
 * instance id but NOT a host, so the Frontend API origin cannot be derived from
 * it. An SDK that quietly fell back to `''` sent every request to a relative
 * path on the app's own origin — a 404 (or the app's HTML) that looked exactly
 * like "signed out", with nothing in the console to say why. Every provider now
 * resolves the value through {@link resolveFrontendApi}, which throws a clear
 * {@link AtlasConfigError} at mount instead.
 */

/** The codes an {@link AtlasConfigError} carries. */
export type AtlasConfigErrorCode = 'FRONTEND_API_REQUIRED' | 'FRONTEND_API_INVALID';

/**
 * A misconfigured provider. Thrown synchronously at mount/initialisation, so
 * the mistake surfaces in development rather than as a silent signed-out state.
 * Check `error.code` (or `instanceof AtlasConfigError`) to tell it apart.
 */
export class AtlasConfigError extends Error {
  readonly code: AtlasConfigErrorCode;

  constructor(code: AtlasConfigErrorCode, message: string) {
    super(message);
    this.name = 'AtlasConfigError';
    this.code = code;
  }
}

/**
 * The explicit value for a same-origin / reverse-proxy setup, where the Frontend
 * API is served under the app's own origin. Resolves to relative request paths.
 */
export const SAME_ORIGIN_FRONTEND_API = 'same-origin';

export interface ResolveFrontendApiOptions {
  /** Name used in the error message, e.g. `"<AtlasProvider>"`. */
  component?: string;
  /**
   * Whether a same-origin value (`"same-origin"` or a path such as `"/atlas"`)
   * is meaningful. `false` for native apps, which have no origin of their own.
   * Default `true`.
   */
  allowSameOrigin?: boolean;
}

const EXAMPLES =
  '"https://atlasauth.net" (before you verify a custom domain) or your verified custom domain, e.g. "https://auth.example.com"';

/** Hosts where plain `http:` is accepted: loopback and local development names. */
function isLocalDevHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.test')) return true;
  if (host === '::1') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return typeof value;
}

/**
 * Validate a provider's `frontendApi` and return the base URL requests are
 * built from (`${base}/v1/client`). Throws an {@link AtlasConfigError} when it
 * is missing, non-string, blank, or not an absolute `https:` URL (`http:` is accepted for
 * localhost and local development hosts).
 *
 * Accepted:
 *  - an absolute URL, e.g. `"https://auth.example.com"` (a trailing slash is
 *    dropped; a path prefix such as `"https://example.com/auth"` is kept);
 *  - `"same-origin"` → `""`, for a reverse proxy serving the Frontend API on
 *    the app's own origin;
 *  - a root-relative path prefix such as `"/atlas"` → `"/atlas"`, for a reverse
 *    proxy under a path;
 *  - DEPRECATED: `""` → `""`, the original same-origin spelling. Still works
 *    (with a one-time console warning pointing at `"same-origin"`) so existing
 *    reverse-proxy setups keep running; refused when `allowSameOrigin` is false.
 *
 * Missing (`undefined`/`null`), non-string and whitespace-only values always
 * throw `FRONTEND_API_REQUIRED`.
 */
export function resolveFrontendApi(
  value: unknown,
  options: ResolveFrontendApiOptions = {},
): string {
  const component = options.component ?? 'The Atlas provider';
  const allowSameOrigin = options.allowSameOrigin !== false;
  const sameOriginHint = allowSameOrigin
    ? ` If you serve the Frontend API from your own origin through a reverse proxy, pass "${SAME_ORIGIN_FRONTEND_API}" (or its path, e.g. "/atlas").`
    : '';

  if (value === '' && allowSameOrigin) {
    warnEmptyFrontendApiOnce(component);
    return '';
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new AtlasConfigError(
      'FRONTEND_API_REQUIRED',
      `${component} needs \`frontendApi\`: the absolute URL of your instance's Frontend API, ` +
        `such as ${EXAMPLES}. It cannot be derived from the publishable key. Got ${show(value)}.` +
        sameOriginHint,
    );
  }

  const raw = value.trim();
  const invalid = (why: string) =>
    new AtlasConfigError(
      'FRONTEND_API_INVALID',
      `${component} got an invalid \`frontendApi\` ${JSON.stringify(raw)}: ${why} ` +
        `Use an absolute https URL such as ${EXAMPLES}.` +
        sameOriginHint,
    );

  if (raw === SAME_ORIGIN_FRONTEND_API) {
    if (!allowSameOrigin) throw invalid('a native app has no origin of its own.');
    return '';
  }

  if (raw.startsWith('/') && !raw.startsWith('//')) {
    if (!allowSameOrigin) throw invalid('a native app has no origin of its own.');
    if (/[?#]/.test(raw)) throw invalid('it must not carry a query string or fragment.');
    return raw.replace(/\/+$/, '');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('it is not an absolute URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid(`the ${url.protocol} scheme is not supported.`);
  }
  if (url.protocol === 'http:' && !isLocalDevHost(url.hostname)) {
    throw invalid('plain http is only accepted for localhost and local development hosts.');
  }
  if (url.username || url.password) throw invalid('it must not carry credentials.');
  if (url.search || url.hash) throw invalid('it must not carry a query string or fragment.');

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

let warnedEmpty = false;

/**
 * `frontendApi=""` was the documented same-origin spelling. It keeps working,
 * but an empty string is also what an unset environment variable looks like —
 * the explicit `"same-origin"` says what was meant. Warned once per page.
 */
function warnEmptyFrontendApiOnce(component: string): void {
  if (warnedEmpty || typeof console === 'undefined') return;
  warnedEmpty = true;
  console.warn(
    `[Atlas] ${component}: \`frontendApi=""\` is deprecated. It still means same-origin ` +
      `(requests go to relative paths on this origin), but pass "${SAME_ORIGIN_FRONTEND_API}" to say so ` +
      `explicitly, or your Frontend API URL, e.g. "https://atlasauth.net".`,
  );
}

