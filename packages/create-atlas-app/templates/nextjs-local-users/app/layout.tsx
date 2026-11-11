import type { ReactNode } from 'react';
import { AtlasProvider } from '@atlasauth/react';

export const metadata = { title: '{{PROJECT_NAME}}' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AtlasProvider
          publishableKey={process.env.NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY!}
          frontendApi={process.env.ATLAS_BASE_PATH ?? '/atlas'}
        >
          {children}
        </AtlasProvider>
      </body>
    </html>
  );
}
