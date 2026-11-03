import type { FapiClient } from './fapi';

/** One entry of the public connector directory. */
export interface DirectoryConnector {
  slug: string;
  displayName: string;
  category: string;
  tagline: string | null;
  logoUrl: string | null;
  verified: boolean;
  featured: boolean;
  installCount: number;
  source: string;
}

export interface DirectoryFacets {
  categories: { category: string; count: number }[];
  total: number;
}

interface WireConnector {
  slug: string;
  display_name: string;
  category: string;
  tagline?: string | null;
  logo_url?: string | null;
  verified?: boolean;
  featured?: boolean;
  install_count?: number;
  source?: string;
}

/** Search the public connector directory (built-in providers and community connectors) with category facets. */
export async function listConnectorDirectory(
  client: FapiClient,
  opts: { q?: string; category?: string; verified?: boolean } = {},
): Promise<{ connectors: DirectoryConnector[]; facets: DirectoryFacets }> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set('q', opts.q);
  if (opts.category) qs.set('category', opts.category);
  if (opts.verified) qs.set('verified', 'true');
  const res = await client.request<{ data: WireConnector[]; facets?: { categories?: { category: string; count: number }[]; total?: number } }>(`/v1/public/connectors${qs.size ? `?${qs}` : ''}`, { method: 'GET' });
  if (!res.ok || !res.data) throw new Error(res.errors[0]?.message ?? 'Could not load the connector directory.');
  return {
    connectors: res.data.data.map((c) => ({
      slug: c.slug, displayName: c.display_name, category: c.category, tagline: c.tagline ?? null, logoUrl: c.logo_url ?? null,
      verified: Boolean(c.verified), featured: Boolean(c.featured), installCount: c.install_count ?? 0, source: c.source ?? 'builtin',
    })),
    facets: { categories: res.data.facets?.categories ?? [], total: res.data.facets?.total ?? res.data.data.length },
  };
}
