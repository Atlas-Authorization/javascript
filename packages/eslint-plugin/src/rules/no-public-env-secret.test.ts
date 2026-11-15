import { TSESLint } from '@typescript-eslint/utils';
import * as tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';
import rule from './no-public-env-secret';

const { RuleTester } = TSESLint;

// Drive the @typescript-eslint/utils RuleTester with vitest's it/describe.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The deprecated RuleTester's config type is pre-flat-config, but at runtime it
// extends ESLint 9's RuleTester, which reads `languageOptions`. Cast to bridge.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
} as unknown as ConstructorParameters<typeof RuleTester>[0]);

ruleTester.run('no-public-env-secret', rule, {
  valid: [
    { code: `const k = process.env.NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY;` },
    { code: `const k = import.meta.env.VITE_ATLAS_PUBLISHABLE_KEY;` },
    // Server-only secret: no public prefix.
    { code: `const k = process.env.ATLAS_SECRET_KEY;` },
    // A public API key is meant to be public.
    { code: `const k = process.env.NEXT_PUBLIC_MAPS_API_KEY;` },
    // Not an env read.
    { code: `const o = { NEXT_PUBLIC_SECRET: 1 }; o.NEXT_PUBLIC_SECRET;` },
    // "DESK" is not "SK".
    { code: `const k = process.env.NEXT_PUBLIC_DESK_URL;` },
  ],
  invalid: [
    { code: `const k = process.env.NEXT_PUBLIC_ATLAS_SECRET_KEY;`, errors: [{ messageId: 'exposed', data: { name: 'NEXT_PUBLIC_ATLAS_SECRET_KEY' } }] },
    { code: `const k = import.meta.env.VITE_DB_PASSWORD;`, errors: [{ messageId: 'exposed' }] },
    { code: `const k = process.env['EXPO_PUBLIC_STRIPE_SECRET'];`, errors: [{ messageId: 'exposed' }] },
    { code: `const k = process.env.NEXT_PUBLIC_ATLAS_SK;`, errors: [{ messageId: 'exposed' }] },
    { code: `const k = process.env.PUBLIC_WEBHOOK_SECRET;`, errors: [{ messageId: 'exposed' }] },
    { code: `const t = process.env.NUXT_PUBLIC_SERVICE_ROLE_KEY;`, errors: [{ messageId: 'exposed' }] },
  ],
});
