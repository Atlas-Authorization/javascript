/**
 * Narrow the sign-in methods a prebuilt form offers. The vocabulary is the one a session's
 * `sign_in_method` uses: `password`, `email_code`, `email_link`, `phone_code`, `passkey`,
 * `siwe`/`siws`/`siwb`/`siwf` (wallets), `oauth_<provider>` (`oauth_google`), `sso_<type>` /
 * `saml_<id>` (enterprise). A family (`oauth`, `enterprise_sso`) covers every method of that kind.
 * An empty or absent list means no filter. A username sign-in counts as `password`.
 */
export function methodAllowed(method: string | null | undefined, allowed: readonly string[] | null | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!method) return false;
  const m = method === 'username' ? 'password' : method;
  if (allowed.includes(m)) return true;
  if (allowed.includes('oauth') && m.startsWith('oauth_')) return true;
  if (allowed.includes('enterprise_sso') && (m.startsWith('saml_') || m.startsWith('sso_'))) return true;
  return false;
}

/** Keep only the first-factor strategy names (`password`, `email_code`, …) the list allows. */
export function filterFactors<T extends string>(factors: readonly T[], allowed: readonly string[] | null | undefined): T[] {
  return factors.filter((f) => methodAllowed(f, allowed));
}

/** A signed list from the Backend API (`pageTemplates.hostedMethodFilter`): the object, or its `query` string. */
export type HostedMethodFilterInput = { allowed_methods: string; allowed_methods_sig: string } | string;

/** `url` with the signed `allowed_methods` pair added, so the hosted page offers only those methods. */
export function withMethodFilter(url: string, filter: HostedMethodFilterInput | undefined): string {
  if (!filter) return url;
  const pairs = typeof filter === 'string' ? new URLSearchParams(filter.replace(/^\?/, '')) : new URLSearchParams(filter);
  const csv = pairs.get('allowed_methods');
  const sig = pairs.get('allowed_methods_sig');
  if (!csv || !sig) throw new Error('methodFilter needs allowed_methods and allowed_methods_sig (from pageTemplates.hostedMethodFilter).');
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    u.searchParams.set('allowed_methods', csv);
    u.searchParams.set('allowed_methods_sig', sig);
    return /^[a-z][a-z0-9+.-]*:/i.test(url) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}
