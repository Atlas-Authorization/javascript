# @atlasauth/lit

Atlas for web components. Lit elements over `@atlasauth/js`: a provider, signed-in and signed-out gates, a permission gate, and the sign-in and sign-up panels. They are plain custom elements, so they work in any framework or in none.

```html
<script type="module">
  import '@atlasauth/lit';
</script>

<atlas-provider publishable-key="pk_live_..." frontend-api="https://auth.example.com">
  <atlas-signed-out>
    <atlas-sign-in redirect="/app"></atlas-sign-in>
  </atlas-signed-out>

  <atlas-signed-in>
    <p>Welcome back.</p>
    <atlas-protect permission="org:billing:read">
      <a href="/billing">Billing</a>
      <span slot="fallback">Ask an admin for billing access.</span>
    </atlas-protect>
    <atlas-sign-out-button>Sign out</atlas-sign-out-button>
  </atlas-signed-in>
</atlas-provider>
```

| Element | Does |
| --- | --- |
| `<atlas-provider publishable-key frontend-api>` | Creates the client, boots the session, refreshes the token before it expires, shares the state. `frontend-api` is required. |
| `<atlas-signed-in>` / `<atlas-signed-out>` / `<atlas-loading>` | Render their children for that state. Signed-out renders only after the first boot settles, so a network blip never flashes a sign-in form. |
| `<atlas-protect permission require-role>` | Children when the session satisfies the condition, else the `fallback` slot. Hides UI only; your API enforces access. |
| `<atlas-sign-in redirect locale>` / `<atlas-sign-up>` | Mount the Atlas panel. |
| `<atlas-sign-out-button>` | Revokes the session and fires `atlas-signed-out`. |

For your own elements, extend `AtlasElement` and read `this.atlas` (`client`, `snapshot`, `publishableKey`, `frontendApi`), or use `createAtlasClient` directly. Get a fresh token for an API call with `client.getToken()`; verify it on the server with `@atlasauth/backend`.
