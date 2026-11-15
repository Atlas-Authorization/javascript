import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from '../util';

/** Prefixes that put an environment variable into the browser bundle. */
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|REACT_APP_|GATSBY_|VUE_APP_|NG_APP_)/;
/** A name that says the value is a credential. API keys and bare tokens are left out: many are meant to be public. */
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PRIVATE|(^|_)SK(_|$)|SERVICE_ROLE|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SIGNING_KEY|WEBHOOK_SECRET)/;

/** `process.env.X`, `process.env['X']`, `import.meta.env.X`: the variable name, or null. */
function envName(node: TSESTree.MemberExpression): string | null {
  const obj = node.object;
  const isEnv =
    obj.type === AST_NODE_TYPES.MemberExpression &&
    !obj.computed &&
    obj.property.type === AST_NODE_TYPES.Identifier &&
    obj.property.name === 'env' &&
    ((obj.object.type === AST_NODE_TYPES.Identifier && obj.object.name === 'process') || obj.object.type === AST_NODE_TYPES.MetaProperty);
  if (!isEnv) return null;
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) return node.property.name;
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal && typeof node.property.value === 'string') return node.property.value;
  return null;
}

export default createRule({
  name: 'no-public-env-secret',
  meta: {
    type: 'problem',
    docs: { description: 'Disallow reading a secret from an environment variable that the framework publishes to the browser (NEXT_PUBLIC_, VITE_, PUBLIC_, EXPO_PUBLIC_ ...).' },
    messages: {
      exposed:
        '{{name}} is published to the browser bundle by its prefix, but its name says it is a secret. Anyone can read it. Keep secrets in a server-only variable (no public prefix) and read them on the server; only the publishable key (pk_...) belongs in a public variable.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node) {
        const name = envName(node);
        if (name && PUBLIC_PREFIX.test(name) && SECRET_NAME.test(name.replace(PUBLIC_PREFIX, ''))) {
          context.report({ node, messageId: 'exposed', data: { name } });
        }
      },
    };
  },
});
