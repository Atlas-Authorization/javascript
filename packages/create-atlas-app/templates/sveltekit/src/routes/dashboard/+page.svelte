<script lang="ts">
  let { data } = $props();
</script>

<main style="max-width: 420px; margin: 4rem auto; font-family: system-ui, sans-serif">
  <h1>Dashboard</h1>
  <p>User {data.userId}{data.orgId ? ` in organization ${data.orgId}` : ''}.</p>
  <p><a href="/">Back</a></p>
</main>
