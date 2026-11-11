import { headers } from 'next/headers';
import { readAtlasHeaders } from '@atlasauth/nextjs';
import { SignedIn, SignedOut, SignInButton, UserButton } from '@atlasauth/react';
import { localUser } from '@/lib/local-user';

export default async function Home() {
  const me = await localUser();
  const { csrfToken } = readAtlasHeaders(await headers());
  return (
    <main>
      <SignedOut><SignInButton /></SignedOut>
      <SignedIn>
        <UserButton />
        <p>Local user {me?.id} (external id {me?.externalId}).</p>
        {/* Step 4: a cookie-authenticated form posts the CSRF token as atlas_csrf. */}
        <form method="post" action="/api/admin-portal">
          <input type="hidden" name="atlas_csrf" value={csrfToken ?? ''} />
          <button>Admin Portal link</button>
        </form>
      </SignedIn>
    </main>
  );
}
