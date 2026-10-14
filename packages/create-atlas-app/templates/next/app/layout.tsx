import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata = {
  title: '{{PROJECT_NAME}}',
  description: 'An Atlas-powered app created with create-atlas-app.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
