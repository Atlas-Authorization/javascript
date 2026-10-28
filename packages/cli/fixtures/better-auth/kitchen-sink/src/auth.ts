import { betterAuth } from 'better-auth';
import {
  anonymous,
  bearer,
  customSession,
  deviceAuthorization,
  genericOAuth,
  haveIBeenPwned,
  jwt,
  lastLoginMethod,
  mcp,
  multiSession,
  oidcProvider,
  oneTap,
  phoneNumber,
  siwe,
  username,
} from 'better-auth/plugins';
import { okta } from 'better-auth/plugins/generic-oauth';
import { sso } from '@better-auth/sso';
import { stripe } from '@better-auth/stripe';
import { polar, checkout } from '@polar-sh/better-auth';
import Stripe from 'stripe';

interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  KEYCLOAK_CLIENT_ID: string;
  KEYCLOAK_CLIENT_SECRET: string;
  OKTA_CLIENT_ID: string;
  OKTA_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  APPLE_CLIENT_ID: string;
  APPLE_CLIENT_SECRET: string;
}

const MINUTE = 60;

// Cloudflare Workers style: the instance is built per request from the bindings.
export const createAuth = (env: Env) =>
  betterAuth({
    baseURL: 'https://kitchen.example',
    advanced: {
      cookiePrefix: 'kitchen',
      crossSubDomainCookies: { enabled: true, domain: '.kitchen.example' },
      disableCSRFCheck: true,
    },
    emailAndPassword: { enabled: true, minPasswordLength: 6, autoSignIn: false, revokeSessionsOnPasswordReset: true },
    socialProviders: {
      microsoft: { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: 'organizations' },
      apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET, appBundleIdentifier: 'com.kitchen.app' },
      twitter: { clientId: 'twitter-public-id', clientSecret: 'hard-coded-oops' },
      polar: { clientId: 'polar-id', clientSecret: 'polar-secret-in-code' },
    },
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true },
    },
    user: {
      additionalFields: {
        plan: { type: 'string', required: false, input: false },
        age: { type: 'number' },
        tier: { type: ['free', 'pro'] },
        tags: { type: 'string[]' },
      },
      deleteUser: { enabled: true },
    },
    rateLimit: {
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 10, max: 3 },
        '/sign-up/email': { window: 60, max: 5 },
        '/two-factor/*': { window: 10, max: 3 },
        '/get-session': false,
        '/custom-thing': { window: 1, max: 1 },
      },
    },
    trustedOrigins: ['kitchen.example', 'myapp://', 'https://admin.kitchen.example'],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({ data: user }),
          after: async () => {},
        },
      },
      session: { create: { before: async () => {} } },
    },
    hooks: { before: async () => {} },
    plugins: [
      phoneNumber({ otpLength: 6, expiresIn: 5 * MINUTE, sendOTP: async () => {} }),
      username({ minUsernameLength: 4, maxUsernameLength: 20 }),
      anonymous(),
      jwt({ jwt: { audience: 'https://api.kitchen.example', expirationTime: '1h', definePayload: ({ user }) => ({ id: user.id }) } }),
      bearer(),
      multiSession({ maximumSessions: 3 }),
      oneTap(),
      siwe({ domain: 'kitchen.example', getNonce: async () => 'n', verifyMessage: async () => true }),
      haveIBeenPwned(),
      customSession(async ({ user, session }) => ({ user, session, roles: [] })),
      genericOAuth({
        config: [
          {
            providerId: 'keycloak',
            discoveryUrl: 'https://sso.kitchen.example/realms/main/.well-known/openid-configuration',
            clientId: env.KEYCLOAK_CLIENT_ID,
            clientSecret: env.KEYCLOAK_CLIENT_SECRET,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
            mapProfileToUser: (profile) => ({
              email: profile.email,
              name: `${profile.given_name} ${profile.family_name}`,
              department: profile.department,
            }),
          },
          {
            providerId: 'legacy-crm',
            authorizationUrl: 'https://crm.kitchen.example/oauth/authorize',
            tokenUrl: 'https://crm.kitchen.example/oauth/token',
            userInfoUrl: 'https://crm.kitchen.example/api/me',
            clientId: 'crm-client',
            clientSecret: 'crm-secret-literal',
            authentication: 'basic',
          },
          okta({ clientId: env.OKTA_CLIENT_ID, clientSecret: env.OKTA_CLIENT_SECRET, issuer: 'https://kitchen.okta.com/oauth2/default' }),
        ],
      }),
      sso({ provisionUser: async () => {}, defaultSSO: [{ domain: 'bigco.com', providerId: 'bigco', samlConfig: { entryPoint: 'https://idp.bigco.com/sso' } }] }),
      oidcProvider({
        loginPage: '/sign-in',
        allowDynamicClientRegistration: true,
        accessTokenExpiresIn: 3600,
        scopes: ['openid', 'profile', 'email', 'read:orders'],
        trustedClients: [
          { clientId: 'internal-dashboard', name: 'Internal dashboard', type: 'web', redirectURLs: ['https://dash.kitchen.example/callback'], skipConsent: true },
        ],
      }),
      mcp({ loginPage: '/sign-in', resource: 'https://mcp.kitchen.example' }),
      deviceAuthorization({ expiresIn: '30m', interval: '5s' }),
      stripe({
        stripeClient: new Stripe(env.STRIPE_SECRET_KEY),
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
        createCustomerOnSignUp: true,
        subscription: {
          enabled: true,
          plans: [
            { name: 'basic', priceId: 'price_basic_123', limits: { projects: 5 } },
            { name: 'pro', priceId: 'price_pro_456', annualDiscountPriceId: 'price_pro_annual_789', limits: { projects: 50 }, freeTrial: { days: 14 } },
          ],
        },
      }),
      polar({ client: undefined as never, use: [checkout({ products: [{ productId: 'prod_polar_1', slug: 'starter' }] })] }),
      lastLoginMethod(),
    ],
  });
