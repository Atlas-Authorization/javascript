// Public values (publishableKey, frontendApi) reach the browser. The verification values
// under runtimeConfig.atlas are server-only: the Nitro middleware verifies the session
// JWT locally against them. Environment variables (see .env.example) override these.
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  modules: ['@atlasauth/nuxt'],
  atlas: {
    publishableKey: '',
    frontendApi: '',
  },
  runtimeConfig: {
    atlas: {
      jwksUrl: '', // NUXT_ATLAS_JWKS_URL
      issuer: '', //  NUXT_ATLAS_ISSUER
    },
    public: {
      atlas: {
        publishableKey: '', // NUXT_PUBLIC_ATLAS_PUBLISHABLE_KEY
        frontendApi: '', //    NUXT_PUBLIC_ATLAS_FRONTEND_API
      },
    },
  },
});
