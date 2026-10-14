'use client';

import { SignedIn, SignedOut, UserButton, useUser } from '@atlasauth/react';
import Link from 'next/link';

export default function Home() {
  const { user } = useUser();

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>{{PROJECT_NAME}}</h1>
      <p>A starter app wired up with Atlas auth.</p>

      <SignedOut>
        <p>
          You are signed out. <Link href="/sign-in">Sign in</Link> to continue.
        </p>
      </SignedOut>

      <SignedIn>
        <p>Signed in as {user?.first_name ?? user?.id}.</p>
        <p>
          <Link href="/dashboard">Go to your dashboard</Link>
        </p>
        <UserButton />
      </SignedIn>
    </main>
  );
}
