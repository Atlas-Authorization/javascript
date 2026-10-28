'use client';

import { useEffect, useState } from 'react';
import { listLauncherApps, type LauncherApp } from '@atlasauth/js';
import { useClass, useClasses, useFapiClient } from './components-shared';

export interface AppLauncherProps {
  /** Heading above the tiles. Default "Your apps". */
  title?: string;
  /** Shown when the user has no apps. */
  emptyText?: string;
}

/**
 * The end-user app launcher: one tile per app the signed-in user may open.
 * A tile is a link that starts IdP-initiated single sign-on to that app.
 */
export function AppLauncher({ title = 'Your apps', emptyText = 'No apps are available to you yet.' }: AppLauncherProps) {
  const client = useFapiClient();
  const cls = useClasses();
  const cardClass = useClass('card', 'atlas-card');
  const [apps, setApps] = useState<LauncherApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listLauncherApps(client).then(
      (list) => live && setApps(list),
      (e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load your apps.'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <section className={cardClass} data-atlas="app-launcher">
      <h2 className={cls('sectionTitle', 'atlas-section-title')}>{title}</h2>
      {error ? <p className={cls('text', 'atlas-text')} role="alert">{error}</p> : null}
      {apps && apps.length === 0 ? <p className={cls('text', 'atlas-text')}>{emptyText}</p> : null}
      {apps && apps.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(8rem, 1fr))', gap: '0.75rem' }}>
          {apps.map((a) => (
            <li key={a.id}>
              <a href={a.launchUrl} data-atlas="app-launcher-tile">{a.name}</a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
