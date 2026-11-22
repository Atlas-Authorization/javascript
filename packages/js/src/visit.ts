/** An `atlas_visit` token: `v1.` then URL-safe characters, at most 128 in all. */
export function parseVisitToken(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 128 && /^v1\.[A-Za-z0-9._~-]+$/.test(value) ? value : null;
}

/** The `atlas_visit` on this page's URL (kept in memory for the page's life, so client-side navigation that drops it still sends it), or null. */
let remembered: string | null = null;
export function pageVisitToken(search?: string): string | null {
  const q = search ?? (typeof window !== 'undefined' && window.location ? window.location.search : '');
  try {
    const found = parseVisitToken(new URLSearchParams(q).get('atlas_visit'));
    if (found) remembered = found;
  } catch {
    /* no usable query */
  }
  return remembered;
}

/** For tests. */
export function resetPageVisitToken(): void {
  remembered = null;
}
