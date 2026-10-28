import { TSESLint } from '@typescript-eslint/utils';
import * as tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';
import rule from './no-leaked-secret-key';

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

ruleTester.run('no-leaked-secret-key', rule, {
  valid: [
    // Secret key in a server file that imports no client SDK.
    {
      code: `import { AtlasBackend } from '@atlasauth/backend'; const c = new AtlasBackend('sk_live_abc123');`,
    },
    // Client SDK imported, but only a publishable key present.
    {
      code: `import { Atlas } from '@atlasauth/js'; const a = new Atlas('pk_live_abc123');`,
    },
    // Type-only import of a client SDK ships no runtime code.
    {
      code: `import type { Session } from '@atlasauth/react'; const k = 'sk_live_abc123';`,
    },
    // Looks secret-ish but does not match the key shape.
    {
      code: `import { Atlas } from '@atlasauth/js'; const s = 'ask_me_later';`,
    },
  ],
  invalid: [
    // sk_ literal in a file importing the browser JS SDK.
    {
      code: `import { Atlas } from '@atlasauth/js'; const a = new Atlas('sk_live_abc123');`,
      errors: [{ messageId: 'leaked' }],
    },
    // psk_ literal alongside a React import.
    {
      code: `import { useAtlas } from '@atlasauth/react'; const k = 'psk_test_zzz999';`,
      errors: [{ messageId: 'leaked' }],
    },
    // scim_ literal alongside a Next.js (frontend) import.
    {
      code: `import { AtlasProvider } from '@atlasauth/nextjs'; const k = 'scim_live_qqq';`,
      errors: [{ messageId: 'leaked' }],
    },
  ],
});
