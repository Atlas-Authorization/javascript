import type { ASTPath } from 'jscodeshift';
import { referencesOf, type VendorContext } from './engine';

/** The Atlas packages the vendor codemods target. */
export const ATLAS = {
  react: '@atlasauth/react',
  reactCompat: '@atlasauth/react/compat',
  jsCompat: '@atlasauth/js/compat',
  nextCompat: '@atlasauth/nextjs/compat',
  nextServer: '@atlasauth/nextjs/server',
  next: '@atlasauth/nextjs',
  backend: '@atlasauth/backend',
  express: '@atlasauth/express',
} as const;

/**
 * Turn a vendor middleware export into the Atlas one, inserted after `path`
 * (the caller removes `path` itself):
 *   `export default createAtlasMiddleware();` or
 *   `export const middleware = createAtlasMiddleware();`
 */
export function middlewareExport(ctx: VendorContext, path: ASTPath, exportName: 'default' | string): void {
  const local = ctx.ensureImport(ATLAS.nextCompat, 'createAtlasMiddleware');
  const code =
    exportName === 'default'
      ? `export default ${local}();`
      : `export const ${exportName} = ${local}();`;
  const [statement] = ctx.statements(code);
  path.insertAfter(statement);
  ctx.report(
    path,
    'middleware now runs Atlas: every route your config.matcher selects needs a signed-in user, except /sign-in and /sign-up (pass publicRoutes to createAtlasMiddleware() to open more)',
  );
}

/** Report a whole file (e.g. an auth route that should be deleted), once. */
export function reportRoute(ctx: VendorContext, pattern: RegExp, message: string): void {
  if (!pattern.test(ctx.facts.path)) return;
  const program = ctx.root.get();
  ctx.report(program.node.program.body[0] ? program.get('program', 'body', 0) : program, message);
}

/**
 * Rewrite a vendor's auth URLs in string literals (`href="/api/auth/login"`,
 * `redirect('/api/auth/signin')`) to the Atlas pages, carrying the return path
 * over as `redirect_url`. Sign-out URLs are reported: in Atlas sign-out is an
 * action (`<SignOutButton />` / `useAuth().signOut()`), not a page.
 */
export function rewriteAuthPaths(
  ctx: VendorContext,
  paths: { signIn: RegExp; signUp?: RegExp; signOut: RegExp; returnParams: readonly string[] },
): void {
  const { j, root } = ctx;
  const visit = (path: ASTPath, value: string, set: (v: string) => void) => {
    const [pathname = '', query = ''] = value.split('?', 2);
    if (paths.signOut.test(pathname)) {
      ctx.manual(path, `${pathname}: sign-out is an action in Atlas; use <SignOutButton /> or useAuth().signOut() from @atlasauth/react`);
      return;
    }
    const page = paths.signIn.test(pathname) ? '/sign-in' : paths.signUp?.test(pathname) ? '/sign-up' : null;
    if (!page) return;
    const params = new URLSearchParams(query);
    const back = paths.returnParams.map((p) => params.get(p)).find((v) => v);
    set(back ? `${page}?redirect_url=${encodeURIComponent(back)}` : page);
    ctx.rewrote();
  };
  root.find(j.StringLiteral).forEach((path) => {
    const parent = path.parent?.node as { type?: string } | undefined;
    if (parent && /Import|Export/.test(parent.type ?? '')) return;
    visit(path, path.node.value, (v) => {
      if (parent?.type === 'JSXAttribute') {
        // JSX attributes conventionally use double quotes; print the raw form.
        const literal = j.literal(v) as unknown as { raw?: string; extra?: unknown };
        literal.raw = JSON.stringify(v);
        literal.extra = { raw: JSON.stringify(v), rawValue: v };
        path.replace(literal as never);
      } else {
        path.node.value = v;
      }
    });
  });
}

/** A loosely typed AST node, for passes that inspect shapes jscodeshift's types do not narrow well. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = { type: string; [key: string]: any };

/** A local binding of a module: from an ES import or a CommonJS `require()`. */
export interface ModuleBinding {
  local: string;
  source: string;
  /** The export it binds: `'default'`, `'*'` or a name. */
  imported: string;
  /** The import declaration or the `const … = require(…)` declaration. */
  statement: ASTPath;
}

/**
 * The module a `require()` expression loads, unwrapping `require('x').Strategy`
 * (member: `Strategy`) and `require('connect-redis')(session)`.
 */
export function requiredFrom(node: unknown): { source: string; member?: string } | null {
  let cur = node as AnyNode | null | undefined;
  let member: string | undefined;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur.type === 'CallExpression' && cur.callee?.type === 'Identifier' && cur.callee.name === 'require') {
      const arg = cur.arguments?.[0] as AnyNode | undefined;
      if (arg && (arg.type === 'StringLiteral' || arg.type === 'Literal') && typeof arg.value === 'string') {
        return member === undefined ? { source: arg.value } : { source: arg.value, member };
      }
      return null;
    }
    if (cur.type === 'MemberExpression' && !cur.computed && cur.property?.type === 'Identifier') {
      member = cur.property.name as string;
      cur = cur.object as AnyNode;
      continue;
    }
    if (cur.type === 'CallExpression') {
      member = undefined;
      cur = cur.callee as AnyNode;
      continue;
    }
    return null;
  }
  return null;
}

/** Every local binding (import or require) of a module matching `match`. */
export function moduleBindings(ctx: VendorContext, match: (source: string) => boolean): ModuleBinding[] {
  const { j, root } = ctx;
  const out: ModuleBinding[] = [];
  root.find(j.ImportDeclaration).forEach((p) => {
    const source = String(p.node.source.value);
    if (!match(source)) return;
    for (const s of p.node.specifiers ?? []) {
      const imported = s.type === 'ImportSpecifier' ? s.imported.name : s.type === 'ImportDefaultSpecifier' ? 'default' : '*';
      out.push({ local: s.local?.name ?? imported, source, imported, statement: p as ASTPath });
    }
  });
  root.find(j.VariableDeclarator).forEach((p) => {
    const req = requiredFrom(p.node.init);
    if (!req || !match(req.source)) return;
    const statement = p.parent as ASTPath;
    const id = p.node.id as AnyNode;
    if (id.type === 'Identifier') {
      out.push({ local: id.name, source: req.source, imported: req.member ?? 'default', statement });
    } else if (id.type === 'ObjectPattern') {
      for (const prop of id.properties as AnyNode[]) {
        if ((prop.type === 'ObjectProperty' || prop.type === 'Property') && prop.key?.type === 'Identifier' && prop.value?.type === 'Identifier') {
          out.push({ local: prop.value.name, source: req.source, imported: prop.key.name, statement });
        }
      }
    }
  });
  return out;
}

/** True when the file is CommonJS: it calls `require()` and has no `import` declarations. */
export function isCommonJs(ctx: VendorContext): boolean {
  const { j, root } = ctx;
  if (root.find(j.ImportDeclaration).length > 0) return false;
  return root.find(j.CallExpression, { callee: { type: 'Identifier', name: 'require' } }).length > 0;
}

function isRequireStatement(node: AnyNode): boolean {
  return node.type === 'VariableDeclaration' && (node.declarations as AnyNode[]).some((d) => requiredFrom(d.init) !== null);
}

/**
 * Make `name` from `module` available in the file and return its local name: an
 * ES import (merged into an existing one), or in a CommonJS file a
 * `const { name } = require(module);` (merged into an existing destructuring
 * require of the module, else added after the last top-level require).
 */
export function ensureBinding(ctx: VendorContext, module: string, name: string): string {
  if (!isCommonJs(ctx)) return ctx.ensureImport(module, name);
  const bodyPath = ctx.root.get('program', 'body') as { value: AnyNode[]; get(i: number): ASTPath; insertAt(i: number, node: unknown): void };
  const body = bodyPath.value;
  for (let i = 0; i < body.length; i++) {
    const s = body[i]!;
    if (s.type !== 'VariableDeclaration' || s.declarations.length !== 1) continue;
    const d = s.declarations[0] as AnyNode;
    const req = requiredFrom(d.init);
    if (!req || req.source !== module || req.member !== undefined || d.id.type !== 'ObjectPattern') continue;
    const names: string[] = [];
    let plain = true;
    for (const prop of d.id.properties as AnyNode[]) {
      if ((prop.type === 'ObjectProperty' || prop.type === 'Property') && prop.key?.type === 'Identifier' && prop.value?.type === 'Identifier') {
        if (prop.key.name === name) return prop.value.name as string;
        if (prop.key.name !== prop.value.name) plain = false;
        names.push(prop.key.name as string);
      } else {
        plain = false;
      }
    }
    if (!plain) continue;
    const [statement] = ctx.statements(`${s.kind} { ${[...names, name].join(', ')} } = require('${module}');`);
    (statement as AnyNode).comments = s.comments;
    bodyPath.get(i).replace(statement);
    ctx.changed = true;
    return name;
  }
  let at = 0;
  body.forEach((s, i) => {
    if (isRequireStatement(s)) at = i + 1;
  });
  const [statement] = ctx.statements(`const { ${name} } = require('${module}');`);
  bodyPath.insertAt(at, statement);
  ctx.changed = true;
  return name;
}

/**
 * Drop a binding nothing references any more: its import specifier (and the
 * declaration once empty), or a `const x = require(…)` declaration.
 */
export function removeIfUnused(ctx: VendorContext, binding: ModuleBinding): void {
  if (referencesOf(ctx, binding.local).length > 0) return;
  const { j } = ctx;
  const node = binding.statement.node as AnyNode;
  if (node.type === 'ImportDeclaration') {
    const specifiers = (node.specifiers ?? []) as AnyNode[];
    const rest = specifiers.filter((s) => (s.local?.name ?? '') !== binding.local);
    if (rest.length === specifiers.length) return;
    if (rest.length === 0) j(binding.statement).remove();
    else node.specifiers = rest;
    ctx.rewrote();
    return;
  }
  if (node.type === 'VariableDeclaration' && node.declarations.length === 1 && node.declarations[0].id.type === 'Identifier') {
    j(binding.statement).remove();
    ctx.rewrote();
  }
}

/** `<object>.<name>` with a plain (non-computed) identifier property. */
export function memberOf(node: unknown): { object: AnyNode; name: string } | null {
  const n = node as AnyNode | null | undefined;
  if (!n || (n.type !== 'MemberExpression' && n.type !== 'OptionalMemberExpression') || n.computed) return null;
  if (n.property?.type !== 'Identifier') return null;
  return { object: n.object as AnyNode, name: n.property.name as string };
}

/** `foo` for an identifier, `a.b` for a plain member chain, else `''`. */
export function nameOf(node: unknown): string {
  const n = node as AnyNode | null | undefined;
  if (!n) return '';
  if (n.type === 'Identifier') return n.name as string;
  if (n.type === 'ThisExpression') return 'this';
  const m = memberOf(n);
  if (m) {
    const left = nameOf(m.object);
    return left ? `${left}.${m.name}` : '';
  }
  return '';
}

/** Social-provider env keys (`GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, …) → a report line, else null. */
export function providerEnvNote(key: string): string | null {
  const m = /^(GOOGLE|GITHUB|FACEBOOK|TWITTER|X|MICROSOFT|AZURE_AD|APPLE|DISCORD|LINKEDIN|GITLAB|SLACK|SPOTIFY|TWITCH)_(CLIENT_ID|CLIENT_SECRET|CALLBACK_URL|REDIRECT_URI)$/.exec(key);
  return m ? `${m[1]}_* sign-in credentials now live in the Atlas dashboard (Social connections)` : null;
}
