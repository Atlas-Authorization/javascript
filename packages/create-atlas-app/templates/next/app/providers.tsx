'use client';

import { AtlasProvider } from '@atlasauth/react';
import type { ReactNode } from 'react';

/**
 * The client-side Atlas context. It must be a client component (it holds the
 * in-memory token and talks to the Frontend API), so it lives apart from the
 * server `layout.tsx` that mounts it.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <AtlasProvider
      publishableKey={process.env.NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY ?? ''}
      frontendApi={process.env.NEXT_PUBLIC_ATLAS_FRONTEND_API ?? 'https://atlasauth.net'}
    >
      {children}
    </AtlasProvider>
  );
}
