import { TSESLint } from '@typescript-eslint/utils';
import * as tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';
import rule from './no-unverified-jwt-decode';

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

ruleTester.run('no-unverified-jwt-decode', rule, {
  valid: [
    // Verified in the same function.
    { code: `async function f(token) { const { payload } = await jwtVerify(token, key); const c = decodeJwt(token); return c.sub; }` },
    { code: `const f = async (token) => { await backend.verify(token); return decodeJwt(token).org; };` },
    { code: `function f(token) { verifyToken(token); return jwtDecode(token); }` },
    // A custom verifier named in options.
    { code: `function f(token) { check(token); return decodeJwt(token); }`, options: [{ verifyFunctions: ['check'] }] },
    // No decode at all.
    { code: `function f(token) { return token.length; }` },
  ],
  invalid: [
    { code: `function f(token) { return decodeJwt(token).sub; }`, errors: [{ messageId: 'unverified' }] },
    { code: `const claims = jwtDecode(req.headers.authorization);`, errors: [{ messageId: 'unverified' }] },
    { code: `import * as jose from 'jose'; const f = (t) => jose.decodeJwt(t);`, errors: [{ messageId: 'unverified' }] },
    // Verification in a different function does not cover this one.
    { code: `async function a(t) { await jwtVerify(t, key); } function b(t) { return decodeJwt(t); }`, errors: [{ messageId: 'unverified' }] },
    // Decode first, verify never: the decoder's own name does not count as verification.
    { code: `function f(t) { const c = decodeJwt(t); return c; }`, errors: [{ messageId: 'unverified' }] },
  ],
});
