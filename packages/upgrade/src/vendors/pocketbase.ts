import type { ASTPath, CallExpression, MemberExpression } from 'jscodeshift';
import { vendorTransform, type VendorContext } from './engine';
import { ATLAS } from './shared';

/**
 * PocketBase → Atlas. PocketBase keeps serving collections and files; its
 * auth moves:
 *
 *  - `pb.authStore` → `pocketbaseAuthStoreCompat` from `@atlasauth/react/compat`
 *    (`isValid`, `token`, `record` / `model`, `clear()`, `onChange()`);
 *  - auth calls on a collection (`authWithPassword`, `authWithOAuth2`,
 *    `authWithOTP`, `requestPasswordReset`, `authRefresh`, …) and sign-up
 *    (`collection('users').create`) are marked: they run on Atlas's pages;
 *  - the SSR cookie dance (`loadFromCookie` / `exportToCookie`) is reported:
 *    Atlas keeps its own session cookie.
 *
 * Superuser calls (`pb.admins.*`, the `_superusers` collection) are left
 * alone: server code still needs them for data access.
 */

const AUTH_CALLS: Record<string, string> = {
  authWithPassword: 'credentials are collected on the Atlas sign-in page now: render <SignIn /> (or send users to /sign-in)',
  authWithOAuth2: 'social sign-in: enable the provider in the Atlas dashboard; the sign-in page shows its button',
  authWithOAuth2Code: 'social sign-in: Atlas completes OAuth callbacks itself; delete this route',
  authWithOTP: 'enable email codes in the Atlas dashboard; the sign-in page sends and checks them',
  requestOTP: 'enable email codes in the Atlas dashboard; the sign-in page sends them',
  authRefresh: 'Atlas refreshes sessions on its own; remove this call',
  requestPasswordReset: 'password reset is built into the Atlas sign-in page ("Forgot password")',
  confirmPasswordReset: 'password reset is built into the Atlas sign-in page',
  requestVerification: 'Atlas verifies email addresses during sign-up and in <UserProfile />',
  confirmVerification: 'Atlas verifies email addresses during sign-up and in <UserProfile />',
  requestEmailChange: 'email changes: <UserProfile /> or user.update() from @atlasauth/react',
  confirmEmailChange: 'email changes: <UserProfile />',
  listAuthMethods: 'the Atlas sign-in page shows the enabled methods itself',
  listExternalAuths: 'linked accounts: user.externalAccounts (managed in <UserProfile />)',
  unlinkExternalAuth: 'linked accounts are disconnected from <UserProfile />',
  impersonate: 'impersonation: actor tokens from @atlasauth/backend (users.impersonate)',
};

const AUTH_COLLECTIONS = /^(users|members|customers|accounts)$/;

/** Local names holding a `new PocketBase(...)` client, plus the conventional `pb`. */
function clients(ctx: VendorContext, localPocketBase: string | null): Set<string> {
  const { j, root } = ctx;
  const names = new Set<string>(['pb']);
  if (!localPocketBase) return names;
  root.find(j.VariableDeclarator).forEach((path) => {
    const init = path.node.init as { type?: string; callee?: { type?: string; name?: string } } | null | undefined;
    if (init?.type === 'NewExpression' && init.callee?.type === 'Identifier' && init.callee.name === localPocketBase && path.node.id.type === 'Identifier') {
      names.add(path.node.id.name);
    }
  });
  return names;
}

/** `pb`, `this.pb`, `locals.pb`, `event.locals.pb`: a client reference. */
function isClient(node: unknown, names: Set<string>): boolean {
  const n = node as { type?: string; name?: string; computed?: boolean; property?: { type?: string; name?: string } };
  if (n?.type === 'Identifier') return names.has(n.name ?? '');
  if (n?.type === 'MemberExpression' && !n.computed && n.property?.type === 'Identifier') return names.has(n.property.name ?? '');
  return false;
}

function pocketbaseImport(ctx: VendorContext): { found: boolean; local: string | null; path: ASTPath | null } {
  const { j, root } = ctx;
  let out: { found: boolean; local: string | null; path: ASTPath | null } = { found: false, local: null, path: null };
  root.find(j.ImportDeclaration).forEach((path) => {
    const source = String(path.node.source.value);
    if (source !== 'pocketbase' && !/(^|\/)pocketbase(\.[cm]?[jt]s)?$/.test(source)) return;
    const def = (path.node.specifiers ?? []).find((s) => s.type === 'ImportDefaultSpecifier');
    out = { found: true, local: source === 'pocketbase' ? (def?.local?.name ?? null) : null, path };
  });
  return out;
}

export default vendorTransform({
  mightApply: (source) => /pocketbase|authStore|\bpb\./i.test(source),
  run(ctx) {
    const { j, root } = ctx;
    const imp = pocketbaseImport(ctx);
    const names = clients(ctx, imp.local);
    // Only in files that use PocketBase (its module, a local pocketbase helper, or a `pb` client).
    const touchesPb = imp.found || root.find(j.Identifier, { name: 'pb' }).length > 0;
    if (!touchesPb) return;

    let rewroteStore = false;
    root.find(j.MemberExpression).forEach((path: ASTPath<MemberExpression>) => {
      const node = path.node;
      if (node.computed || node.property.type !== 'Identifier' || node.property.name !== 'authStore') return;
      if (!isClient(node.object, names)) return;
      const parent = path.parent?.node as { type?: string; left?: unknown } | undefined;
      if (parent?.type === 'AssignmentExpression' && parent.left === node) return;
      const outer = path.parent?.node as { type?: string; property?: { type?: string; name?: string } } | undefined;
      const member = outer?.type === 'MemberExpression' ? outer.property?.name : undefined;
      if (member === 'loadFromCookie' || member === 'exportToCookie') {
        ctx.manual(path, `pb.authStore.${member}(): Atlas keeps its own session cookie; read the session with auth() from @atlasauth/nextjs/server (or locals.auth in your framework's Atlas middleware) and delete this cookie handling`);
      }
      const local = ctx.ensureImport(ATLAS.reactCompat, 'pocketbaseAuthStoreCompat');
      path.replace(j.identifier(local));
      ctx.rewrote();
      rewroteStore = true;
    });

    root.find(j.CallExpression).forEach((path: ASTPath<CallExpression>) => {
      const callee = path.node.callee as { type?: string; computed?: boolean; object?: unknown; property?: { type?: string; name?: string } };
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property?.type !== 'Identifier') return;
      const method = callee.property.name ?? '';
      // pb.collection('users').<method>(...)
      const target = callee.object as { type?: string; callee?: { type?: string; computed?: boolean; object?: unknown; property?: { name?: string } }; arguments?: Array<{ type?: string; value?: unknown }> };
      if (target?.type !== 'CallExpression' || target.callee?.type !== 'MemberExpression' || target.callee.property?.name !== 'collection') return;
      if (!isClient(target.callee.object, names)) return;
      const arg = target.arguments?.[0];
      const collection = arg && (arg.type === 'StringLiteral' || arg.type === 'Literal') && typeof arg.value === 'string' ? arg.value : null;
      if (collection === '_superusers' || collection === '_admins') return;
      const note = AUTH_CALLS[method];
      if (note) {
        ctx.manual(path, `collection(${collection ? `'${collection}'` : '…'}).${method}(): ${note}`);
        return;
      }
      if (method === 'create' && collection && AUTH_COLLECTIONS.test(collection)) {
        ctx.manual(path, `collection('${collection}').create(): if this is sign-up, it runs on the Atlas sign-up page now (<SignUp /> or /sign-up); users are created in Atlas, not in PocketBase`);
      }
    });

    if (rewroteStore && imp.path) {
      ctx.report(
        imp.path,
        'PocketBase API rules that check @request.auth no longer see the signed-in user (PocketBase tokens are gone): serve that data through your server with a superuser client after verifying the Atlas session',
      );
    }
  },
});
