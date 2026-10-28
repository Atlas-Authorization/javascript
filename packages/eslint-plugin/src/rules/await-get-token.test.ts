import { TSESLint } from '@typescript-eslint/utils';
import * as tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';
import rule from './await-get-token';

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

ruleTester.run('await-get-token', rule, {
  valid: [
    // Awaited.
    { code: `async function f(s) { await s.getToken(); }` },
    // Chained with .then().
    { code: `function f(s) { s.getToken().then((t) => use(t)); }` },
    // Result assigned.
    { code: `function f(s) { const p = s.getToken(); return p; }` },
    // Returned.
    { code: `function f(s) { return s.getToken(); }` },
    // Bare identifier form, awaited.
    { code: `async function f() { await getToken(); }` },
    // Not getToken — unrelated floating call.
    { code: `function f(s) { s.getUser(); }` },
  ],
  invalid: [
    // Floating member call — result discarded.
    {
      code: `function f(session) { session.getToken(); }`,
      errors: [{ messageId: 'floating' }],
    },
    // Floating bare call.
    {
      code: `function f() { getToken(); }`,
      errors: [{ messageId: 'floating' }],
    },
    // Floating call on an AtlasBackend instance.
    {
      code: `function f(backend) { backend.getToken(); }`,
      errors: [{ messageId: 'floating' }],
    },
  ],
});
