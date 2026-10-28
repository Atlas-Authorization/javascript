import type {
  API,
  ASTNode,
  ASTPath,
  Collection,
  FileInfo,
  Identifier,
  ImportDeclaration,
  Options,
} from 'jscodeshift';

import {
  CLERK_ONLY_PROVIDER_PROPS,
  PACKAGE_MAP,
  REACT_RENAMES,
  SHARED_IDENTIFIERS,
  TODO_PREFIX,
  clerkModuleFor,
  isClerkPackage,
  isManualEntry,
  renameEnvKey,
  type ClerkCallFix,
  type ClerkExportTarget,
  type ClerkModuleRule,
  type ProviderEnv,
} from '../mappings';

/**
 * Optional sink the runner passes through `options` so it can count how many
 * individual symbols were rewritten across the whole project. Keeping it in
 * `options` means the transform stays a plain jscodeshift transform (the same
 * shape jscodeshift's own CLI expects) while still reporting detail to callers
 * that drive it as a library.
 */
export interface ClerkToAtlasOptions extends Options {
  onCount?: (kind: 'import' | 'identifier' | 'env' | 'todo') => void;
}

type J = API['jscodeshift'];
type Specifier = NonNullable<ImportDeclaration['specifiers']>[number];

/**
 * Codemod: rewrite a Clerk-based source file to its Atlas equivalent.
 *
 * It rewrites, in order:
 *   1. `@clerk/*` imports onto `@atlasauth/*`, per export (see `CLERK_MODULES`):
 *      an import whose exports live in different Atlas modules is split (the
 *      React surface of `@clerk/nextjs` goes to `@atlasauth/react`, its server
 *      helpers to `@atlasauth/nextjs/server`); `require()` / `import()` module
 *      strings follow the package's primary Atlas module;
 *   2. imported identifiers that Atlas renamed (e.g. `ClerkProvider` ->
 *      `AtlasProvider`) together with every reference to them in the file,
 *      including JSX tags, plus the call-site fixes a rename needs (config the
 *      Atlas server adapters take as options, `clerkClient.users` ->
 *      `atlasClient().users`, `req.auth` -> `getAuth(req)`);
 *   3. `process.env.CLERK_*` / `import.meta.env.CLERK_*` keys (also behind a
 *      framework prefix such as `NEXT_PUBLIC_` or `VITE_`) -> `ATLAS_*`;
 *   4. `<AtlasProvider>` props: the Frontend API URL Atlas needs next to the
 *      publishable key, and Clerk-only props removed.
 *
 * Anything imported from a Clerk package that has no known Atlas peer (and is
 * not a shared same-named symbol) is left in place with a `// TODO(atlas-upgrade)`
 * marker, so a human reviews it rather than the tool guessing.
 *
 * Returns the rewritten source, or `undefined` when nothing changed (the
 * jscodeshift convention that lets the runner skip untouched files cheaply).
 */
export default function transform(
  file: FileInfo,
  api: API,
  options: ClerkToAtlasOptions = {},
): string | undefined {
  const j = api.jscodeshift;
  const root = j(file.source);
  const isTypeScript = /\.[cm]?tsx?$/.test(file.path);
  let changed = false;

  const count = (kind: 'import' | 'identifier' | 'env' | 'todo') => {
    changed = true;
    options.onCount?.(kind);
  };
  const todo = (node: ASTNode, message: string) => {
    if (addLeadingTodo(j, node, message)) count('todo');
  };

  // Identifiers whose local binding we renamed, so references can follow.
  // Maps old local name -> new local name.
  const references = new Map<string, string>();
  // Call-site fixes, keyed by the (new) local name.
  const fixes: Array<{ local: string; fix: ClerkCallFix }> = [];
  // The rule that renamed `ClerkProvider` (unaliased), for the provider pass.
  let providerRule: ClerkModuleRule | undefined;
  // Atlas module whose `getAuth` replaces `req.auth`.
  let reqAuthModule: string | undefined;

  // --- 1 & 2: import declarations -----------------------------------------
  root.find(j.ImportDeclaration).forEach((path) => {
    const source = path.node.source.value;
    if (typeof source !== 'string') return;

    const entry = clerkModuleFor(source);
    if (!entry) {
      // Unknown Clerk package: we cannot rewrite it safely, so flag it.
      if (isClerkPackage(source)) todo(path.node, `unmapped Clerk package '${source}' — migrate manually`);
      return;
    }
    if (isManualEntry(entry)) {
      todo(path.node, `'${source}': ${entry.manual}`);
      return;
    }
    const rule = entry;
    const specifiers = path.node.specifiers ?? [];
    count('import');

    if (specifiers.length === 0) {
      path.node.source.value = rule.module;
      return;
    }

    // Atlas module -> specifiers, in first-seen order; `stay` keeps the Clerk source.
    const groups = new Map<string, Specifier[]>();
    const add = (module: string, spec: Specifier) => {
      const list = groups.get(module) ?? [];
      list.push(spec);
      groups.set(module, list);
    };
    const stay: Specifier[] = [];
    const unknownNamed: string[] = [];
    const notes: string[] = [];

    for (const spec of specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') {
        if (rule.defaultExport) {
          // `import clerk from '@clerk/astro'` -> `import { atlasAstro } from '@atlasauth/astro'`.
          const local = spec.local?.name ?? 'default';
          const named = j.importSpecifier(j.identifier(rule.defaultExport));
          references.set(local, rule.defaultExport);
          add(rule.module, named);
          count('identifier');
        } else {
          // The local binding name was chosen by the developer, so we leave it alone.
          add(rule.module, spec);
        }
        continue;
      }
      if (spec.type !== 'ImportSpecifier') {
        add(rule.module, spec);
        continue;
      }

      const imported = spec.imported.name;
      const local = spec.local?.name ?? imported;
      const aliased = local !== imported;
      const target: ClerkExportTarget | undefined =
        rule.exports?.[imported] ??
        (rule.react && REACT_RENAMES[imported]
          ? { name: REACT_RENAMES[imported] }
          : (rule.react && SHARED_IDENTIFIERS.has(imported)) || rule.shared?.has(imported)
            ? {}
            : undefined);

      if (!target) {
        // Imported from Clerk, renamed by neither table, not a shared symbol:
        // it has no confirmed Atlas peer, so defer to a human.
        unknownNamed.push(imported);
        add(rule.module, spec);
        continue;
      }
      if (isManualEntry(target)) {
        stay.push(spec);
        notes.push(target.manual);
        continue;
      }

      const name = target.name ?? imported;
      if (name !== imported) {
        spec.imported.name = name;
        if (!aliased) {
          // Not aliased: keep binding in sync and rename every reference.
          if (spec.local) spec.local.name = name;
          references.set(imported, name);
          if (imported === 'ClerkProvider') providerRule = rule;
        }
        // If aliased (`ClerkProvider as CP`) the local alias and its uses are
        // already correct — only the imported name needed updating.
        count('identifier');
      }
      if (target.note) notes.push(target.note);
      if (target.fix) fixes.push({ local: aliased ? local : name, fix: target.fix });
      add(target.module ?? rule.module, spec);
    }
    if (rule.reqAuth) reqAuthModule = rule.module;
    if (rule.note) notes.push(rule.note);

    // Rebuild: the original declaration keeps its place (and comments).
    const entries = [...groups.entries()];
    const created: ImportDeclaration[] = [];
    if (stay.length > 0) {
      path.node.specifiers = stay;
    } else {
      const [module, specs] = entries.shift()!;
      path.node.source.value = module;
      path.node.specifiers = specs;
    }
    for (const [module, specs] of entries) {
      const decl = j.importDeclaration(specs, j.stringLiteral(module));
      if (path.node.importKind === 'type') decl.importKind = 'type';
      created.push(decl);
    }
    if (created.length > 0) path.insertAfter(...created);

    if (unknownNamed.length > 0) {
      todo(path.node, `no 1:1 Atlas equivalent for: ${unknownNamed.join(', ')} — review manually`);
    }
    for (const note of notes) todo(path.node, note);
  });

  // Re-exports straight from a Clerk package are not rewritten (the exported
  // names are part of this module's own API), only flagged.
  root.find(j.ExportNamedDeclaration).forEach((path) => {
    const source = path.node.source?.value;
    if (typeof source === 'string' && isClerkPackage(source)) {
      todo(path.node, `re-export from '${source}': import the Atlas equivalents and re-export them explicitly`);
    }
  });
  root.find(j.ExportAllDeclaration).forEach((path) => {
    const source = path.node.source.value;
    if (typeof source === 'string' && isClerkPackage(source)) {
      todo(path.node, `'export * from ${source}': re-export the Atlas equivalents you need explicitly`);
    }
  });

  // require('@clerk/..') and dynamic import('@clerk/..'): rewrite the module
  // string only. Rewiring destructured bindings from a require is ambiguous, so
  // we deliberately stop at the specifier (the common, safe case).
  root
    .find(j.CallExpression)
    .filter((path) => {
      const callee = path.node.callee;
      const isRequire = callee.type === 'Identifier' && callee.name === 'require';
      const isImport = callee.type === 'Import';
      return isRequire || isImport;
    })
    .forEach((path) => {
      const arg = path.node.arguments[0];
      if (arg && arg.type === 'StringLiteral' && typeof arg.value === 'string') {
        const entry = clerkModuleFor(arg.value);
        if (entry && !isManualEntry(entry)) {
          arg.value = PACKAGE_MAP[arg.value] ?? entry.module;
          count('import');
        }
      }
    });

  // --- 2b: rename references to renamed imports ----------------------------
  for (const [oldName, newName] of references) {
    root
      .find(j.JSXIdentifier, { name: oldName })
      .forEach((path) => {
        path.node.name = newName;
        count('identifier');
      });

    root
      .find(j.Identifier, { name: oldName })
      .filter((path) => isReference(path))
      .forEach((path) => {
        // Skip the import specifier itself — already handled above.
        path.node.name = newName;
        count('identifier');
      });
  }

  // --- 2c: call-site fixes for rewritten bindings --------------------------
  const ctx: FixContext = { j, root, isTypeScript, todo, count };
  for (const { local, fix } of fixes) applyFix(ctx, local, fix);
  if (reqAuthModule) rewriteReqAuth(ctx, reqAuthModule);
  rewriteNuxtConfig(ctx);

  // --- 3: environment variables -------------------------------------------
  root.find(j.MemberExpression).forEach((path) => {
    const node = path.node;
    if (!isEnvObject(node.object)) return;

    if (!node.computed && node.property.type === 'Identifier') {
      const renamed = renameEnvKey(node.property.name);
      if (renamed) {
        node.property.name = renamed;
        count('env');
      }
    } else if (node.computed && node.property.type === 'StringLiteral') {
      const renamed = renameEnvKey(node.property.value);
      if (renamed) {
        node.property.value = renamed;
        count('env');
      }
    }
  });

  // --- 4: <AtlasProvider> props ---------------------------------------------
  if (providerRule) fixProviders(ctx, providerRule.providerEnv);

  if (!changed) return undefined;
  // single quotes match the house style used across packages/*/src.
  return root.toSource({ quote: 'single' });
}

interface FixContext {
  j: J;
  root: Collection;
  isTypeScript: boolean;
  todo: (node: ASTNode, message: string) => void;
  count: (kind: 'import' | 'identifier' | 'env' | 'todo') => void;
}

/** Parse one expression from source (it prints exactly as written). */
function parseExpr(j: J, code: string): ASTNode {
  // A declaration initializer, not `(code);`: a parenthesized node would print with its parens.
  const program = j(`const __atlas = ${code};`).get().node.program;
  return program.body[0].declarations[0].init;
}

/** `process.env.KEY` (with `!` in TypeScript) or `import.meta.env.KEY`. */
function envCode(object: ProviderEnv['object'], key: string, isTypeScript: boolean): string {
  return `${object}.${key}${isTypeScript && object === 'process.env' ? '!' : ''}`;
}

/** `{ jwksUrl, issuer }` for the Atlas server adapters, read from the environment. */
function serverOptions(ctx: FixContext): string {
  const jwks = envCode('process.env', 'ATLAS_JWKS_URL', ctx.isTypeScript);
  const issuer = envCode('process.env', 'ATLAS_ISSUER', ctx.isTypeScript);
  return `{ jwksUrl: ${jwks}, issuer: ${issuer} }`;
}

/**
 * Replace a call with `<same callee>(args)`, parsed from source so the arguments
 * print exactly as written (pushing nodes into the old call would make recast
 * reprint the whole argument list and wrap it at its own column limit).
 */
function replaceCall(ctx: FixContext, callPath: ASTPath, args: string): void {
  const call = parseExpr(ctx.j, `__callee(${args})`) as unknown as { callee: unknown };
  call.callee = (callPath.node as unknown as { callee: unknown }).callee;
  callPath.replace(call as never);
  ctx.count('identifier');
}

const CURRENT_USER_ONLY_CLERK = new Set([
  'emailAddresses',
  'primaryEmailAddress',
  'primaryEmailAddressId',
  'phoneNumbers',
  'primaryPhoneNumber',
  'imageUrl',
  'fullName',
  'publicMetadata',
  'privateMetadata',
  'unsafeMetadata',
  'externalAccounts',
  'lastSignInAt',
]);

const AUTH_ONLY_CLERK = new Set(['getToken', 'redirectToSignIn', 'redirectToSignUp', 'sessionClaims', 'orgSlug', 'orgPermissions', 'actor', 'factorVerificationAge']);

function applyFix(ctx: FixContext, local: string, fix: ClerkCallFix): void {
  const { j, root } = ctx;
  if (fix === 'current-user') {
    // The claims-based Atlas profile has no emailAddresses / imageUrl / metadata.
    const uses = root.find(j.MemberExpression).filter((p) => {
      const prop = p.node.property;
      return !p.node.computed && prop.type === 'Identifier' && CURRENT_USER_ONLY_CLERK.has(prop.name);
    });
    if (uses.length > 0) {
      ctx.todo(
        enclosingStatement(uses.paths()[0]!)!.node,
        'currentUser(): the Atlas user is { id, email, name, firstName, lastName, orgId, orgRole } from the session claims; for emailAddresses / imageUrl / metadata fetch it with atlasClient().users.get(id)',
      );
    }
    return;
  }

  root
    .find(j.Identifier, { name: local })
    .filter((p) => isReference(p))
    .forEach((p) => {
      const parent = p.parent as ASTPath;
      const pnode = parent.node as { type: string; callee?: unknown; arguments?: ASTNode[]; object?: unknown; property?: { type: string; name?: string } };
      const isCallee = pnode.type === 'CallExpression' && pnode.callee === p.node;
      const statement = enclosingStatement(p);

      switch (fix) {
        case 'next-middleware': {
          if (!isCallee) return;
          if (pnode.arguments!.length === 0) {
            // Clerk's clerkMiddleware() protects nothing by default; keep every route public.
            replaceCall(ctx, parent, `{ publicRoutes: ['/(.*)'] }`);
          } else if (statement) {
            ctx.todo(
              statement.node,
              "clerkMiddleware(handler): createAtlasMiddleware takes options, not a handler; list the routes your handler protects, e.g. createAtlasMiddleware({ publicRoutes: ['/(.*)'], protectedRoutes: ['/dashboard(.*)'] }), and move other checks into the pages ((await auth()).protect())",
            );
          }
          return;
        }
        case 'server-options': {
          if (!isCallee) return;
          if (pnode.arguments!.length === 0) {
            replaceCall(ctx, parent, serverOptions(ctx));
          } else if (statement) {
            ctx.todo(
              statement.node,
              `${local}(options): Atlas needs { jwksUrl: process.env.ATLAS_JWKS_URL, issuer: process.env.ATLAS_ISSUER }; Clerk-only options (secretKey, publishableKey, signInUrl, …) do not apply`,
            );
          }
          return;
        }
        case 'fastify-register': {
          const callee = pnode.type === 'CallExpression' ? (pnode.callee as { type?: string; property?: { name?: string } }) : undefined;
          const isRegister =
            callee?.type === 'MemberExpression' && callee.property?.name === 'register' && pnode.arguments?.[0] === p.node;
          if (!isRegister) return;
          if (pnode.arguments!.length === 1) {
            replaceCall(ctx, parent, `${local}, ${serverOptions(ctx)}`);
          } else if (statement) {
            ctx.todo(
              statement.node,
              `register(${local}, options): Atlas needs { jwksUrl: process.env.ATLAS_JWKS_URL, issuer: process.env.ATLAS_ISSUER }; Clerk-only options (secretKey, publishableKey, …) do not apply`,
            );
          }
          return;
        }
        case 'client-call': {
          // Clerk v5's clerkClient was an object (`clerkClient.users…`); atlasClient() is a function.
          if (pnode.type === 'MemberExpression' && pnode.object === p.node) {
            p.replace(j.callExpression(j.identifier(local), []));
            ctx.count('identifier');
          }
          return;
        }
        case 'next-auth': {
          if (!statement) return;
          if (pnode.type === 'MemberExpression' && pnode.object === p.node && pnode.property?.name === 'protect') {
            ctx.todo(statement.node, 'auth.protect(): Atlas has no static auth.protect; call (await auth()).protect()');
            return;
          }
          if (!isCallee) return;
          const outer = parent.parent as ASTPath | null;
          const awaited = outer?.node.type === 'AwaitExpression';
          if (!awaited) {
            ctx.todo(statement.node, 'auth() returns a Promise in Atlas: await it');
            return;
          }
          // `const { userId, getToken } = await auth()`: fields Atlas's auth() does not return.
          const declarator = outer!.parent?.node as { type?: string; id?: { type?: string; properties?: Array<{ key?: { name?: string } }> } };
          if (declarator?.type === 'VariableDeclarator' && declarator.id?.type === 'ObjectPattern') {
            const missing = (declarator.id.properties ?? []).map((prop) => prop.key?.name).filter((n): n is string => !!n && AUTH_ONLY_CLERK.has(n));
            if (missing.length > 0) {
              ctx.todo(
                statement.node,
                `auth(): Atlas returns { userId, sessionId, orgId, orgRole, claims, has, protect }; no ${missing.join(', ')} (redirect('/sign-in') from next/navigation replaces redirectToSignIn)`,
              );
            }
          }
          return;
        }
      }
    });
}

/** `req.auth` / `req.auth()` (Clerk Express) -> `getAuth(req)` (Atlas sets `req.atlas`). */
function rewriteReqAuth(ctx: FixContext, module: string): void {
  const { j, root } = ctx;
  let local: string | undefined;
  root
    .find(j.MemberExpression, { property: { type: 'Identifier', name: 'auth' }, computed: false })
    .filter((p) => {
      const obj = p.node.object;
      if (obj.type !== 'Identifier' || (obj.name !== 'req' && obj.name !== 'request')) return false;
      const parent = p.parent.node as { type: string; left?: unknown };
      return !(parent.type === 'AssignmentExpression' && parent.left === p.node);
    })
    .forEach((p) => {
      const name = (local ??= ensureNamedImport(j, root, module, 'getAuth'));
      const call = j.callExpression(j.identifier(name), [p.node.object as never]);
      const parent = p.parent as ASTPath;
      const pnode = parent.node as { type: string; callee?: unknown; arguments?: unknown[] };
      if (pnode.type === 'CallExpression' && pnode.callee === p.node && pnode.arguments!.length === 0) parent.replace(call);
      else p.replace(call);
      ctx.count('identifier');
    });
}

/** `modules: ['@clerk/nuxt']` and the `clerk: {…}` key in nuxt.config. */
function rewriteNuxtConfig(ctx: FixContext): void {
  const { j, root } = ctx;
  root.find(j.StringLiteral, { value: '@clerk/nuxt' }).forEach((p) => {
    const array = p.parent?.node as { type?: string };
    const prop = p.parent?.parent?.node as { type?: string; key?: { type?: string; name?: string } };
    if (array?.type !== 'ArrayExpression' || prop?.type !== 'ObjectProperty' || prop.key?.name !== 'modules') return;
    p.node.value = '@atlasauth/nuxt';
    ctx.count('import');
    const object = p.parent.parent.parent?.node as { type?: string; properties?: Array<{ type?: string; key?: { type?: string; name?: string } }> };
    for (const sibling of object?.properties ?? []) {
      if (sibling.type === 'ObjectProperty' && sibling.key?.type === 'Identifier' && sibling.key.name === 'clerk') {
        sibling.key.name = 'atlas';
        ctx.count('identifier');
      }
    }
  });
}

/** Unwrap `x!` / `x as T` to `x`. */
function unwrap(node: ASTNode | undefined): ASTNode | undefined {
  let cur = node as { type?: string; expression?: ASTNode } | undefined;
  while (cur && (cur.type === 'TSNonNullExpression' || cur.type === 'TSAsExpression')) cur = cur.expression as never;
  return cur as ASTNode | undefined;
}

/** An env read `process.env.<P>ATLAS_PUBLISHABLE_KEY` → its object and prefix. */
function publishableKeyEnv(node: ASTNode | undefined): ProviderEnv | undefined {
  const n = unwrap(node) as { type?: string; object?: unknown; property?: { type?: string; name?: string; value?: string }; computed?: boolean } | undefined;
  if (n?.type !== 'MemberExpression' || !isEnvObject(n.object)) return undefined;
  const key = n.property?.type === 'Identifier' ? n.property.name : n.property?.value;
  const m = key ? /^(.*)ATLAS_PUBLISHABLE_KEY$/.exec(key) : null;
  if (!m) return undefined;
  const inner = (n.object as { object?: { type?: string } }).object;
  return { object: inner?.type === 'MetaProperty' ? 'import.meta.env' : 'process.env', prefix: m[1]! };
}

/**
 * `<AtlasProvider>` needs `frontendApi` next to `publishableKey` (Clerk derived
 * its API host from the key). Add it in the style the file already reads the key
 * (or, with no key at all, the framework's public env vars); remove Clerk-only props.
 */
function fixProviders(ctx: FixContext, fallback: ProviderEnv | undefined): void {
  const { j, root } = ctx;
  // Any env read of the publishable key in the file (e.g. `const KEY = import.meta.env.VITE_…`).
  let fileEnv: ProviderEnv | undefined;
  root.find(j.MemberExpression).forEach((p) => {
    fileEnv ??= publishableKeyEnv(p.node);
  });

  root.find(j.JSXOpeningElement, { name: { type: 'JSXIdentifier', name: 'AtlasProvider' } }).forEach((p) => {
    const statement = enclosingStatement(p);
    const attrs = (p.node.attributes ?? []) as Array<{ type: string; name?: { name?: string }; value?: { type?: string; expression?: ASTNode } }>;
    const attr = (name: string) => attrs.find((a) => a.type === 'JSXAttribute' && a.name?.name === name);
    const dropped = attrs.filter((a) => a.type === 'JSXAttribute' && a.name?.name && CLERK_ONLY_PROVIDER_PROPS.includes(a.name.name));
    if (dropped.length > 0) {
      p.node.attributes = attrs.filter((a) => !dropped.includes(a)) as never;
      ctx.count('identifier');
    }
    const setAttr = (name: string, code: string) => {
      const value = j.jsxExpressionContainer(parseExpr(j, code) as never);
      p.node.attributes = [...(p.node.attributes ?? []), j.jsxAttribute(j.jsxIdentifier(name), value)] as never;
      ctx.count('identifier');
    };

    const pk = attr('publishableKey');
    if (!attr('frontendApi')) {
      const env = (pk ? publishableKeyEnv(pk.value?.expression) ?? fileEnv : undefined) ?? (!pk ? fallback : undefined);
      if (env) {
        if (!pk) setAttr('publishableKey', envCode(env.object, `${env.prefix}ATLAS_PUBLISHABLE_KEY`, ctx.isTypeScript));
        setAttr('frontendApi', envCode(env.object, `${env.prefix}ATLAS_FRONTEND_API`, ctx.isTypeScript));
      } else if (statement) {
        ctx.todo(
          statement.node,
          pk
            ? 'AtlasProvider: add frontendApi={…} (your Atlas Frontend API URL, from the Atlas dashboard)'
            : 'AtlasProvider: add publishableKey={…} and frontendApi={…} (from the Atlas dashboard); Clerk read these from the environment',
        );
      }
    }
    if (dropped.length > 0 && statement) {
      ctx.todo(
        statement.node,
        `AtlasProvider: removed Clerk-only props ${dropped.map((a) => a.name!.name).join(', ')} (set redirect URLs and the sign-in/sign-up paths in the Atlas dashboard)`,
      );
    }
  });
}

/** `import { name } from module`, merged into an existing value import; returns the local name. */
function ensureNamedImport(j: J, root: Collection, module: string, name: string): string {
  const decls = root.find(j.ImportDeclaration, { source: { value: module } }).paths().filter((p) => p.node.importKind !== 'type');
  for (const p of decls) {
    for (const s of p.node.specifiers ?? []) {
      if (s.type === 'ImportSpecifier' && s.imported.name === name) return s.local?.name ?? name;
    }
  }
  const into = decls.find((p) => (p.node.specifiers ?? []).every((s) => s.type === 'ImportSpecifier'));
  if (into) into.node.specifiers = [...(into.node.specifiers ?? []), j.importSpecifier(j.identifier(name))];
  else {
    const decl = j.importDeclaration([j.importSpecifier(j.identifier(name))], j.stringLiteral(module));
    const imports = root.find(j.ImportDeclaration);
    if (imports.length > 0) imports.at(imports.length - 1).insertAfter(decl);
    else root.get().node.program.body.unshift(decl);
  }
  return name;
}

const STATEMENT_TYPES = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'VariableDeclaration',
  'ExpressionStatement',
  'ReturnStatement',
  'IfStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
  'ThrowStatement',
]);

/** The closest enclosing statement (an export wrapping a declaration owns the comment). */
function enclosingStatement(path: ASTPath): ASTPath | null {
  let cur: ASTPath | null = path;
  while (cur) {
    if (STATEMENT_TYPES.has(cur.node.type)) {
      const parent = cur.parent as ASTPath | null;
      if (parent && (parent.node.type === 'ExportNamedDeclaration' || parent.node.type === 'ExportDefaultDeclaration')) return parent;
      return cur;
    }
    cur = cur.parent as ASTPath | null;
  }
  return null;
}

/** Attach a `// TODO(atlas-upgrade): ...` line comment above a statement (once). */
function addLeadingTodo(j: J, node: ASTNode, message: string): boolean {
  const text = ` ${TODO_PREFIX} ${message}`;
  const holder = node as { comments?: Array<{ value: string }> };
  if ((holder.comments ?? []).some((c) => c.value === text)) return false;
  const comment = j.commentLine(text, true, false);
  holder.comments = [...(holder.comments ?? []), comment as never];
  return true;
}

/**
 * True when an identifier node is an actual value reference, as opposed to a
 * property key or member name that merely happens to share the text. This keeps
 * the rename from touching `foo.ClerkProvider` or `{ ClerkProvider: ... }` keys.
 */
function isReference(path: ASTPath<Identifier>): boolean {
  const parent = path.parent?.node;
  if (!parent) return true;

  // obj.ClerkProvider (non-computed) — the property is not a free reference.
  if (parent.type === 'MemberExpression' && parent.property === path.node && !parent.computed) {
    return false;
  }
  // { ClerkProvider: x } / class members — a non-computed key is not a reference.
  if (
    (parent.type === 'ObjectProperty' ||
      parent.type === 'Property' ||
      parent.type === 'ObjectMethod' ||
      parent.type === 'ClassProperty' ||
      parent.type === 'ClassMethod') &&
    (parent as { key?: unknown; computed?: boolean }).key === path.node &&
    !(parent as { computed?: boolean }).computed
  ) {
    return false;
  }
  // Import/export specifier slots are handled explicitly elsewhere.
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier' ||
    parent.type === 'ExportSpecifier'
  ) {
    return false;
  }
  return true;
}

/** True when a node is `process.env` or `import.meta.env`. */
function isEnvObject(object: unknown): boolean {
  const node = object as {
    type?: string;
    object?: { type?: string; name?: string; meta?: { name?: string }; property?: { name?: string } };
    property?: { type?: string; name?: string };
  };
  if (node?.type !== 'MemberExpression') return false;
  const inner = node.object;
  const prop = node.property;
  if (prop?.type !== 'Identifier' || prop.name !== 'env') return false;

  // process.env
  if (inner?.type === 'Identifier' && inner.name === 'process') return true;
  // import.meta.env
  if (inner?.type === 'MetaProperty' && inner.meta?.name === 'import') return true;
  return false;
}
