# {{PROJECT_NAME}}

A minimal Expo (Expo Router) app pre-wired with [Atlas](https://atlasauth.net) auth, generated with `create-atlas-app`.

## What's wired

- `lib/tokenCache.ts` — the session token stored in the platform keychain / keystore with `expo-secure-store`.
- `app/_layout.tsx` — `<AtlasProvider>` with the publishable key and the token cache.
- `app/index.tsx` — `<SignedIn>` / `<SignedOut>`, a call to your own API with the session token, and sign-out.
- `components/SignInForm.tsx` — email and password sign-in on the SDK's headless flow.

A mobile app only ever holds the publishable key. Your own API verifies the session token it receives, with
`@atlasauth/backend` or the Atlas SDK for your server language.

## Getting started

```sh
npm install
cp .env.example .env     # set your publishable key and instance URL
npx expo start
```
