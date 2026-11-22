# expo-oauth-conformance

A minimal Expo app that signs in through `useSignIn().signInWithOAuth` against a development Atlas instance
with the built-in `atlas_test` provider, plus Maestro flows that drive it on an iOS simulator and an Android emulator.

The instance needs: to be a DEVELOPMENT instance, with the built-in `atlas_test` provider enabled
(`PUT /v1/oauth_providers/atlas_test` with `{ "enabled": true }`; no client id or secret). Its page has a single
"Sign in as test user" button, which the Maestro flows tap. To use another provider set
`EXPO_PUBLIC_ATLAS_TEST_PROVIDER`. A native app must be registered with `bundle_id`/`package_name`
`com.example.app` and the callback `exampleapp://atlas-oauth`; in Expo Go nothing needs registering.
`atlas dev native` prints the publishable key, Frontend API URL and the registered apps.

```bash
EXPO_PUBLIC_ATLAS_DEV_PK=pk_test_... EXPO_PUBLIC_ATLAS_DEV_FAPI=https://fapi.example.com \
  npx expo prebuild && npx expo run:ios      # or run:android
maestro test maestro/ios.yaml                # or maestro/android.yaml
```

`.github-workflow.yml` is the CI job for the public javascript repository (secrets `ATLAS_DEV_PK`,
`ATLAS_DEV_FAPI`); its header says where to copy it.
