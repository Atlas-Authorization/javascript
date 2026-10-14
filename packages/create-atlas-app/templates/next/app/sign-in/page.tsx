'use client';

import { SignIn } from '@atlasauth/react';

/**
 * The sign-in route. `<SignIn />` renders the full Atlas flow (email, social,
 * MFA) and handles its own internal navigation.
 */
export default function SignInPage() {
  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <SignIn />
    </main>
  );
}
