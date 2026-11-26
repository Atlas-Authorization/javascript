/**
 * Cookie names under per-instance cookie isolation (`session.cookieIsolation`): every Frontend API cookie of an
 * instance carries a suffix derived from its publishable key (`__atlas_csrf_ab12cd34`). The same derivation lives in
 * `@atlasauth/backend` and on the server, so no configuration is needed.
 */

/** The suffix for a publishable key: its last 8 letters/digits, lowercased. */
export function cookieSuffixForKey(publishableKey: string): string {
  return publishableKey.replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase();
}

/**
 * One cookie of a `document.cookie` string: `<base>_<suffix>` first (an isolated instance), then the plain name. With
 * no publishable key, a page holding exactly one `<base>_<8 characters>` cookie and no plain one reads that one.
 */
export function readAtlasCookie(source: string, base: string, publishableKey?: string): string | null {
  const jar = new Map<string, string>();
  for (const part of source.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  let raw = (publishableKey ? jar.get(`${base}_${cookieSuffixForKey(publishableKey)}`) : undefined) ?? jar.get(base);
  if (raw === undefined && !publishableKey) {
    const own = [...jar].filter(([name]) => name.startsWith(`${base}_`) && /^[a-z0-9]{8}$/.test(name.slice(base.length + 1)));
    if (own.length === 1) raw = own[0]![1];
  }
  return raw ?? null;
}
