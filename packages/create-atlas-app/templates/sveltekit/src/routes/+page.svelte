<script lang="ts">
  import { SignIn, SignedIn, SignedOut, UserButton, getUser } from '@atlasauth/svelte';

  const user = getUser();
</script>

<main style="max-width: 420px; margin: 4rem auto; font-family: system-ui, sans-serif">
  <h1>{{PROJECT_NAME}}</h1>
  <p>A starter app wired up with Atlas auth.</p>

  <SignedOut>
    <SignIn />
  </SignedOut>

  <SignedIn>
    <p>Signed in as {$user.user?.first_name ?? $user.user?.id}.</p>
    <UserButton />
    <p><a href="/dashboard">Open the protected dashboard</a></p>
  </SignedIn>
</main>
