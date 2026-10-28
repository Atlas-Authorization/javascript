'use client';

import { useEffect, useState } from 'react';
import { listConnectorDirectory, type DirectoryConnector, type DirectoryFacets } from '@atlasauth/js';
import { useClass, useClasses, useFapiClient } from './components-shared';

export interface IntegrationGalleryProps {
  /** Called when the person picks an integration: start your connection flow for `connector.slug`. */
  onConnect: (connector: DirectoryConnector) => void;
  /** Start filtered to one category. */
  category?: string;
  /** Only verified connectors. */
  verifiedOnly?: boolean;
  title?: string;
  /** The button label on each tile. Default "Connect". */
  connectLabel?: string;
}

/** A searchable gallery of the connector directory (built-in providers and community connectors) with category filters. */
export function IntegrationGallery({ onConnect, category: initialCategory, verifiedOnly, title = 'Integrations', connectLabel = 'Connect' }: IntegrationGalleryProps) {
  const client = useFapiClient();
  const cls = useClasses();
  const cardClass = useClass('card', 'atlas-card');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | undefined>(initialCategory);
  const [items, setItems] = useState<DirectoryConnector[] | null>(null);
  const [facets, setFacets] = useState<DirectoryFacets | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // A short debounce so typing does not fire a request per key.
    const t = setTimeout(() => {
      listConnectorDirectory(client, { q: q.trim() || undefined, category, verified: verifiedOnly }).then(
        (r) => {
          if (!live) return;
          setItems(r.connectors);
          setFacets((f) => f ?? r.facets);
          setError(null);
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load integrations.'),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, q, category, verifiedOnly]);

  return (
    <section className={cardClass} data-atlas="integration-gallery">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>{title}</h2>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search integrations" aria-label="Search integrations" data-atlas="integration-search" />
      {facets && facets.categories.length > 0 ? (
        <div role="group" aria-label="Categories" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '0.75rem 0' }}>
          <button type="button" aria-pressed={!category} onClick={() => setCategory(undefined)}>All</button>
          {facets.categories.map((c) => (
            <button key={c.category} type="button" aria-pressed={category === c.category} onClick={() => setCategory(c.category)}>
              {c.category} ({c.count})
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className={cls('text', 'atlas-text')} role="alert">{error}</p> : null}
      {items && items.length === 0 ? <p className={cls('text', 'atlas-text')}>No integrations match.</p> : null}
      {items && items.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))', gap: '0.75rem' }}>
          {items.map((c) => (
            <li key={`${c.source}:${c.slug}`} data-atlas="integration-tile">
              {c.logoUrl ? <img src={c.logoUrl} alt="" width={32} height={32} /> : null}
              <strong>{c.displayName}</strong>
              {c.tagline ? <p>{c.tagline}</p> : null}
              <button type="button" onClick={() => onConnect(c)}>{connectLabel}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
