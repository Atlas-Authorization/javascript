<script setup lang="ts">
// Every @atlasauth/vue composable and component is auto-imported.
const { user } = useUser();
const { signOut } = useAuth();
const name = computed(() => user.value?.first_name ?? user.value?.email_addresses?.[0]?.email_address ?? 'you');
</script>

<template>
  <main style="max-width: 420px; margin: 4rem auto; font-family: system-ui, sans-serif">
    <h1>{{PROJECT_NAME}}</h1>
    <p>A starter app wired up with Atlas auth.</p>

    <AtlasLoading><p>Loading…</p></AtlasLoading>

    <SignedOut>
      <SignIn />
    </SignedOut>

    <SignedIn>
      <p>Signed in as <span v-text="name" />.</p>
      <UserButton />
      <button @click="signOut()">Sign out</button>
    </SignedIn>
  </main>
</template>
