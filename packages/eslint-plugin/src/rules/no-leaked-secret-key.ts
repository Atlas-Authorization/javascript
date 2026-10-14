import type { TSESTree } from '@typescript-eslint/utils';
import { createRule } from '../util';

/**
 * Client-side / browser Atlas SDKs. Importing any of these marks the file as
 * shipping to a client, where an Atlas secret key must never appear.
 */
const FRONTEND_PACKAGES = new Set<string>([
  '@atlasauth/js',
  '@atlasauth/react',
  '@atlasauth/react-native',
  '@atlasauth/vue',
  '@atlasauth/svelte',
  '@atlasauth/angular',
  '@atlasauth/astro',
  '@atlasauth/nextjs',
  '@atlasauth/nuxt',
  '@atlasauth/react-router',
  '@atlasauth/tanstack-react-start',
  '@atlasauth/embed',
  '@atlasauth/chrome-extension',
]);

/** sk_ / psk_ / scim_ followed by key material — an Atlas secret key. */
const SECRET_KEY = /\b(sk|psk|scim)_[A-Za-z0-9]/;

function isFrontendSource(source: string): boolean {
  return FRONTEND_PACKAGES.has(source);
}

export default createRule({
  name: 'no-leaked-secret-key',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Atlas secret keys (sk_/psk_/scim_) in files that import a client-side Atlas SDK.',
    },
    messages: {
      leaked:
        'This looks like an Atlas secret key (sk_/psk_/scim_), but this file imports a client-side Atlas SDK. Secret keys must never ship to the browser. Use your publishable key (pk_...) in client code and keep secret keys server-only (e.g. an environment variable read on the server).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const secretLiterals: TSESTree.Literal[] = [];
    let importsFrontend = false;

    return {
      ImportDeclaration(node) {
        // A type-only import ships no runtime code, so it cannot leak a key.
        if (node.importKind === 'type') return;
        if (typeof node.source.value === 'string' && isFrontendSource(node.source.value)) {
          importsFrontend = true;
        }
      },
      Literal(node) {
        if (typeof node.value === 'string' && SECRET_KEY.test(node.value)) {
          secretLiterals.push(node);
        }
      },
      TemplateLiteral(node) {
        // Flag a template whose static text alone already contains a secret key.
        const raw = node.quasis.map((q) => q.value.cooked ?? '').join('');
        if (SECRET_KEY.test(raw)) {
          // report on Program:exit alongside the string literals
          secretLiterals.push(node as unknown as TSESTree.Literal);
        }
      },
      'Program:exit'() {
        if (!importsFrontend) return;
        for (const node of secretLiterals) {
          context.report({ node, messageId: 'leaked' });
        }
      },
    };
  },
});
