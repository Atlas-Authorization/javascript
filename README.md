# Atlas JavaScript SDKs

Official JavaScript / TypeScript SDKs for [Atlas Authorization](https://atlasauth.net), published under the [`@atlasauth`](https://www.npmjs.com/org/atlasauth) npm scope.

```bash
pnpm add @atlasauth/react     # React hooks + <AtlasProvider>, <Protect>, <SignIn>
pnpm add @atlasauth/nextjs    # Next.js middleware + server helpers
pnpm add @atlasauth/js        # Framework-agnostic browser client
pnpm add @atlasauth/backend   # Server-side session (JWT) verification
```

## Packages

| Package | What it is |
|---|---|
| [`@atlasauth/js`](packages/js) | Framework-agnostic browser client (sign-in, sessions, handshake) |
| [`@atlasauth/react`](packages/react) | React bindings — `<AtlasProvider>`, hooks, `<Protect>` |
| [`@atlasauth/nextjs`](packages/nextjs) | Next.js middleware + `auth()` server helpers |
| [`@atlasauth/backend`](packages/backend) | Server-side session-token verification against your JWKS |
| [`@atlasauth/authz`](packages/authz) | Shared authorization primitive (`has()` / `<Protect>` conditions) |
| [`@atlasauth/vue`](packages/vue) | Vue composables + components |
| [`@atlasauth/nuxt`](packages/nuxt) | Nuxt module |
| [`@atlasauth/svelte`](packages/svelte) | Svelte stores + components |
| [`@atlasauth/angular`](packages/angular) | Angular providers + guards |
| [`@atlasauth/react-native`](packages/react-native) | React Native / Expo client |
| [`@atlasauth/embed`](packages/embed) | Drop-in embeddable auth widget |

## Development

```bash
pnpm install
pnpm -r build
```

## License

MIT — see [LICENSE](LICENSE).
