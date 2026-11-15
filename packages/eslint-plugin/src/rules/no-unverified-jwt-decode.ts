import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from '../util';

type Options = [{ verifyFunctions?: string[] }?];

/** Functions that read a JWT's claims without checking its signature. */
const DECODERS = new Set(['decodeJwt', 'decodeJWT', 'jwtDecode', 'decodeJwtPayload']);
/** A call whose name says it verifies: jwtVerify, verifyToken, backend.verify, verifySession, verifyAccessToken. */
const DEFAULT_VERIFY = /verify/i;

function calleeName(callee: TSESTree.CallExpression['callee']): string | null {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  if (callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed && callee.property.type === AST_NODE_TYPES.Identifier) return callee.property.name;
  return null;
}

type Scope = TSESTree.Node & { body?: unknown };

function enclosingFunction(node: TSESTree.Node): TSESTree.Node {
  let n: TSESTree.Node | undefined = node.parent;
  while (n) {
    if (n.type === AST_NODE_TYPES.FunctionDeclaration || n.type === AST_NODE_TYPES.FunctionExpression || n.type === AST_NODE_TYPES.ArrowFunctionExpression) return n;
    if (n.type === AST_NODE_TYPES.Program) return n;
    n = n.parent;
  }
  return node;
}

function containsVerify(root: TSESTree.Node, matches: (name: string) => boolean): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as Scope & { type?: string };
    if (typeof n.type !== 'string') return;
    if (n.type === AST_NODE_TYPES.CallExpression) {
      const name = calleeName(n.callee);
      if (name && !DECODERS.has(name) && matches(name)) {
        found = true;
        return;
      }
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      visit(value);
    }
  };
  visit(root);
  return found;
}

export default createRule<Options, 'unverified'>({
  name: 'no-unverified-jwt-decode',
  meta: {
    type: 'problem',
    docs: { description: 'Disallow trusting a decoded JWT: decodeJwt reads claims without checking the signature, so the function must also verify the token.' },
    messages: {
      unverified:
        'decodeJwt only reads the claims. Anyone can forge a token that decodes. Verify it first (jwtVerify, or verifyToken / AtlasBackend.verify from @atlasauth/backend) before you trust sub, org or role. Decoding for display in a browser is fine: disable this line with a comment saying so.',
    },
    schema: [{ type: 'object', properties: { verifyFunctions: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const extra = new Set(options?.verifyFunctions ?? []);
    const matches = (name: string): boolean => extra.has(name) || DEFAULT_VERIFY.test(name);
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !DECODERS.has(name)) return;
        // Verification anywhere in the same function counts: the usual shape is verify, then read the claims.
        if (containsVerify(enclosingFunction(node), matches)) return;
        context.report({ node, messageId: 'unverified' });
      },
    };
  },
});
