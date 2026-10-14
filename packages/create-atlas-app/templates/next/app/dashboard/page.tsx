import { auth, currentUser } from '@atlasauth/nextjs/server';
import { redirect } from 'next/navigation';

/**
 * A protected server component. The middleware already gates this route, but we
 * defend in depth: `auth()` verifies the session from the ambient request, and a
 * signed-out visitor is sent to sign-in rather than rendering anything.
 */
export default async function Dashboard() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const user = await currentUser();

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Dashboard</h1>
      <p>This page is only reachable when you are signed in.</p>
      <p>
        Your user id is <code>{userId}</code>
        {user?.email ? (
          <>
            {' '}
            (<code>{user.email}</code>)
          </>
        ) : null}
        .
      </p>
    </main>
  );
}
