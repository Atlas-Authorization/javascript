import { TSESLint } from '@typescript-eslint/utils';
// @ts-expect-error -- see no-leaked-secret-key.test.ts: parser types are
// "exports"-only and unreadable under classic moduleResolution; value only.
import * as tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';
import rule from './no-publishable-key-literal';

const { RuleTester } = TSESLint;

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
} as unknown as ConstructorParameters<typeof RuleTester>[0]);

ruleTester.run('no-publishable-key-literal', rule, {
  valid: [
    // Read from the environment — the recommended pattern.
    { code: `const key = process.env.ATLAS_PUBLISHABLE_KEY;` },
    // A secret key is a different rule's concern, not this one.
    { code: `const key = 'sk_live_abc123';` },
    // Not a publishable-key shape.
    { code: `const key = 'pk_something_else';` },
  ],
  invalid: [
    {
      code: `const key = 'pk_live_abcDEF123';`,
      errors: [
        {
          messageId: 'hardcoded',
          suggestions: [
            {
              messageId: 'useEnv',
              output: `const key = process.env.ATLAS_PUBLISHABLE_KEY;`,
            },
          ],
        },
      ],
    },
    {
      code: `const a = new Atlas({ publishableKey: 'pk_test_zzz999' });`,
      errors: [
        {
          messageId: 'hardcoded',
          suggestions: [
            {
              messageId: 'useEnv',
              output: `const a = new Atlas({ publishableKey: process.env.ATLAS_PUBLISHABLE_KEY });`,
            },
          ],
        },
      ],
    },
  ],
});
