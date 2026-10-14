import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from '../util';

/**
 * Does this callee name the `getToken` method? Matches a bare `getToken(...)`
 * identifier call and a `<expr>.getToken(...)` member call (e.g. the one on an
 * AtlasBackend / session object). Kept name-based and conservative on purpose.
 */
function isGetTokenCallee(callee: TSESTree.CallExpression['callee']): boolean {
  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name === 'getToken';
  }
  if (callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed) {
    return (
      callee.property.type === AST_NODE_TYPES.Identifier && callee.property.name === 'getToken'
    );
  }
  return false;
}

export default createRule({
  name: 'await-get-token',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag a getToken() call whose returned Promise is floated (not awaited, returned, assigned, or chained).',
    },
    messages: {
      floating:
        'getToken() returns a Promise. This call is floating — its result is discarded, so the token is never used (and rejections go unhandled). Await it, chain .then(), or assign/return the value.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (!isGetTokenCallee(node.callee)) return;
        // Conservative: only an OBVIOUS floating call — the call is the whole
        // expression statement, so its Promise result is thrown away. Awaited
        // (AwaitExpression), returned, assigned, or `.then(...)`-chained calls
        // all have a different parent and are left alone.
        if (node.parent.type === AST_NODE_TYPES.ExpressionStatement) {
          context.report({ node, messageId: 'floating' });
        }
      },
    };
  },
});
