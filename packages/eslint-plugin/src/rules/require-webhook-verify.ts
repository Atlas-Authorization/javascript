import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from '../util';

type Options = [{ verifyFunctions?: string[] }?];

/** HTTP verbs a route may be registered with. */
const ROUTE_METHODS = new Set(['post', 'put', 'patch', 'all']);
/** The exported handler names of a file-based route (Next.js, SvelteKit, Astro, Remix). */
const FILE_HANDLERS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'action']);
const WEBHOOK = /webhook/i;
/** A call whose name says it checks a signature: verifyWebhook, verifyAtlasWebhookRequest, webhook.verify, constructEvent, unwrap. */
const DEFAULT_VERIFY = /(verify|constructEvent|unwrap)/i;

type FunctionNode = TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression;

const isFunction = (n: TSESTree.Node | null | undefined): n is FunctionNode =>
  !!n && (n.type === AST_NODE_TYPES.FunctionDeclaration || n.type === AST_NODE_TYPES.FunctionExpression || n.type === AST_NODE_TYPES.ArrowFunctionExpression);

/** The name a call is made through: `verifyWebhook(...)` and `wh.verify(...)` are both "verify...". */
function calleeName(callee: TSESTree.CallExpression['callee']): string | null {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  if (callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed && callee.property.type === AST_NODE_TYPES.Identifier) return callee.property.name;
  return null;
}

/** Does any call under `root` have a verifying name? A plain walk of the tree (no scope analysis: a name match is the contract). */
function containsVerify(root: TSESTree.Node, matches: (name: string) => boolean): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as TSESTree.Node & { type?: string };
    if (typeof n.type !== 'string') return;
    if (n.type === AST_NODE_TYPES.CallExpression) {
      const name = calleeName(n.callee);
      if (name && matches(name)) {
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

function literalText(node: TSESTree.Node | undefined): string | null {
  if (!node) return null;
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') return node.value;
  if (node.type === AST_NODE_TYPES.TemplateLiteral) return node.quasis.map((q) => q.value.cooked ?? '').join('');
  return null;
}

export default createRule<Options, 'unverified'>({
  name: 'require-webhook-verify',
  meta: {
    type: 'problem',
    docs: { description: 'Require a webhook route handler to verify the request signature before it trusts the body.' },
    messages: {
      unverified:
        'This webhook handler never verifies the request signature, so anyone who finds the URL can send it events. Call verifyWebhook / verifyAtlasWebhookRequest (from @atlasauth/backend) on the RAW body before using it.',
    },
    schema: [{ type: 'object', properties: { verifyFunctions: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const extra = new Set(options?.verifyFunctions ?? []);
    const matches = (name: string): boolean => extra.has(name) || DEFAULT_VERIFY.test(name);
    const inWebhookFile = WEBHOOK.test(context.filename);
    /** Function declarations by name, so `app.post('/webhooks', handle)` can be checked against `handle`. */
    const declared = new Map<string, FunctionNode>();
    const routes: Array<{ handler: FunctionNode | string; middleware: TSESTree.CallExpressionArgument[]; at: TSESTree.Node }> = [];

    const check = (handler: FunctionNode, at: TSESTree.Node, middleware: TSESTree.CallExpressionArgument[] = []): void => {
      // Verification placed in middleware (`app.post('/webhooks', verifyWebhookMiddleware, handler)`) counts.
      for (const m of middleware) {
        if (m.type === AST_NODE_TYPES.Identifier && matches(m.name)) return;
        if (m.type === AST_NODE_TYPES.CallExpression) {
          const name = calleeName(m.callee);
          if (name && matches(name)) return;
        }
      }
      if (!containsVerify(handler.body, matches)) context.report({ node: at, messageId: 'unverified' });
    };

    return {
      FunctionDeclaration(node) {
        if (node.id) declared.set(node.id.name, node);
      },
      VariableDeclarator(node) {
        if (node.id.type === AST_NODE_TYPES.Identifier && isFunction(node.init)) declared.set(node.id.name, node.init);
      },
      CallExpression(node) {
        if (node.callee.type !== AST_NODE_TYPES.MemberExpression || node.callee.computed || node.callee.property.type !== AST_NODE_TYPES.Identifier) return;
        if (!ROUTE_METHODS.has(node.callee.property.name)) return;
        const path = literalText(node.arguments[0]);
        if (path === null || !WEBHOOK.test(path)) return;
        const rest = node.arguments.slice(1);
        const last = rest[rest.length - 1];
        if (!last) return;
        routes.push({ handler: isFunction(last) ? last : last.type === AST_NODE_TYPES.Identifier ? last.name : '', middleware: rest.slice(0, -1), at: node });
      },
      ExportNamedDeclaration(node) {
        if (!inWebhookFile || !node.declaration) return;
        const d = node.declaration;
        if (d.type === AST_NODE_TYPES.FunctionDeclaration && d.id && FILE_HANDLERS.has(d.id.name)) check(d, d.id);
        if (d.type === AST_NODE_TYPES.VariableDeclaration) {
          for (const v of d.declarations) {
            if (v.id.type === AST_NODE_TYPES.Identifier && FILE_HANDLERS.has(v.id.name) && isFunction(v.init)) check(v.init, v.id);
          }
        }
      },
      'Program:exit'() {
        for (const r of routes) {
          // A handler that cannot be found in this file (imported) is left alone: nothing here shows it is unverified.
          const fn = typeof r.handler === 'string' ? declared.get(r.handler) : r.handler;
          if (fn) check(fn, r.at, r.middleware);
        }
      },
    };
  },
});
