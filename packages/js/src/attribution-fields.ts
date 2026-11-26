/**
 * Copy values the page already holds (a cookie, a URL parameter, a script
 * global or any function) into the sign-up's `fields`, so a sign-up carries
 * them to the new user's public metadata without server code. The instance
 * must list each key as a sign-up field (optional); values are cut at 500
 * characters by the server. Nothing is read unless configured.
 */
export interface AttributionSource {
  cookie?: string;
  query?: string;
  /** A `window` property: a string, or a function returning one (e.g. `seolyticize`, called with `'visit'`). */
  global?: string;
  globalArg?: string;
  /** May return a Promise (a script that resolves later); it is awaited for up to 1.5 seconds. */
  read?: () => string | null | undefined | PromiseLike<string | null | undefined>;
}
export type AttributionOptions = Record<string, AttributionSource>;

let pageDefault: AttributionOptions | undefined;
/** Page-wide default for every client that sets no `attribution` of its own (the React provider sets it). */
export function configureAttribution(options: AttributionOptions | undefined): void {
  pageDefault = options;
}
export const pageAttribution = (): AttributionOptions | undefined => pageDefault;

const SOURCE_TIMEOUT_MS = 1500;

/** Resolve a value that may be a thenable; a source that stays pending counts as no value. */
async function settle(v: unknown): Promise<unknown> {
  if (!v || typeof (v as PromiseLike<unknown>).then !== 'function') return v;
  return Promise.race([
    v as PromiseLike<unknown>,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SOURCE_TIMEOUT_MS)),
  ]);
}

async function readSource(src: AttributionSource): Promise<string | null> {
  try {
    if (src.read) {
      const v = await settle(src.read());
      return typeof v === 'string' && v ? v : null;
    }
    const w = typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>);
    if (src.query && w) return new URLSearchParams(window.location.search).get(src.query) || null;
    if (src.cookie && typeof document !== 'undefined') {
      const m = document.cookie.split('; ').find((c) => c.startsWith(`${src.cookie}=`));
      return m ? decodeURIComponent(m.slice(src.cookie.length + 1)) || null : null;
    }
    if (src.global && w) {
      const g = w[src.global];
      const v = await settle(typeof g === 'function' ? (g as (a?: string) => unknown)(src.globalArg) : g);
      return typeof v === 'string' && v ? v : null;
    }
  } catch {
    // a page script that throws (or rejects) must never block sign-up
  }
  return null;
}

/** The configured keys that have a value now, to merge under the caller's own `fields`. */
export async function captureAttributionFields(options: AttributionOptions | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    Object.entries(options ?? {}).map(async ([key, src]) => {
      const v = await readSource(src);
      if (v) out[key] = v;
    }),
  );
  return out;
}
