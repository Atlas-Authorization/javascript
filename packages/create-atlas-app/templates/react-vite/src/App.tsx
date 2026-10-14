import { SignIn, SignedIn, SignedOut, UserButton, useUser } from '@atlasauth/react';

export function App() {
  const { user } = useUser();
  const email = user?.email_addresses?.find((e) => e.primary)?.email_address;

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>{{PROJECT_NAME}}</h1>
      <p>A starter app wired up with Atlas auth.</p>

      <SignedOut>
        <SignIn />
      </SignedOut>

      <SignedIn>
        <p>Signed in as {user?.first_name ?? email ?? user?.id}.</p>
        <UserButton />
      </SignedIn>
    </main>
  );
}
