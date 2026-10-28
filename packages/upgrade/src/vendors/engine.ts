import type {
  API,
  ASTNode,
  ASTPath,
  Collection,
  FileInfo,
  Identifier,
  ImportDeclaration,
  JSCodeshift,
  JSXIdentifier,
} from 'jscodeshift';

/**
 * The shared machinery behind the `--from <vendor>` codemods (Auth.js, Supabase
 * Auth, Auth0, Better Auth, Lucia, Passport, iron-session, Firebase, Cognito/Amplify, MSAL, Appwrite,
 * PocketBase, Nhost, hand-rolled OIDC). Each vendor module is a list of IMPORT RULES (which
 * vendor export maps to which Atlas export) plus a few vendor-specific AST passes;
 * this file does the parts they all share:
 *
 *  - rewrite each REFERENCE to a vendor binding onto its Atlas target, one call
 *    site at a time, so a call shape the target cannot serve (a Pages-router
 *    `getSession(req, res)`, say) is left on the vendor import and reported
 *    instead of being silently broken;
 *  - drop a vendor import specifier only once nothing references it;
 *  - merge the new `@atlasauth/*` imports into existing ones (idempotent);
 *  - rename `process.env.*` / `import.meta.env.*` keys;
 *  - leave a `// TODO(atlas-migrate):` marker (deduplicated) and a report entry
 *    with file:line for everything it could not rewrite.
 *
 * Running a codemod twice produces no further change: after the first run there
 * are no vendor references left to rewrite, and every marker it would add again
 * is already there.
 */

export const MIGRATE_TODO = 'TODO(atlas-migrate):';

export type VendorId =
  | 'authjs'
  | 'supabase'
  | 'auth0'
  | 'better-auth'
  | 'openid-client'
  | 'jose'
  | 'generic-oidc'
  | 'lucia'
  | 'passport'
  | 'iron-session'
  | 'firebase'
  | 'cognito'
  | 'azure'
  | 'appwrite'
  | 'pocketbase'
  | 'nhost'
  | 'keycloak'
  | 'ory'
  | 'zitadel'
  | 'logto'
  | 'supertokens'
  | 'authentik'
  | 'fusionauth'
  | 'hanko';

/** How the project reads public env vars, decided from its package.json. */
export type EnvStyle = 'next' | 'vite' | 'cra' | 'node';

export interface ReportItem {
  file: string;
  line: number;
  message: string;
}

export interface VendorOptions {
  envStyle?: EnvStyle;
  /** Display path for report entries (defaults to the FileInfo path). */
  displayPath?: string;
  onReport?: (item: ReportItem) => void;
  onCount?: (kind: 'rewrite' | 'todo') => void;
}

/** Where a file's code runs, as far as the codemod can tell. */
export type FileKind = 'client' | 'server' | 'unknown';

export interface FileFacts {
  path: string;
  kind: FileKind;
  isMiddleware: boolean;
  isTypeScript: boolean;
  envStyle: EnvStyle;
}

/** Atlas target for a vendor export. */
export interface ImportTarget {
  module: string;
  name: string;
  /** The binding is only used as a type (e.g. a `Session` type). */
  typeOnly?: boolean;
  /**
   * Decide per reference: `true` rewrites it; a string leaves it on the vendor
   * import and reports the string. Defaults to always rewriting.
   */
  accept?: (ref: ASTPath, ctx: VendorContext) => true | string;
  /** Extra work after a reference is rewritten (e.g. fix a provider's JSX props). */
  after?: (ref: ASTPath, ctx: VendorContext) => void;
  /**
   * A re-export (`export { x } from 'vendor'`) cannot be pointed at the target
   * (the call shape changes at each call site): leave it and report this.
   */
  noReexport?: string;
}

/** No Atlas counterpart: leave it, mark it, report this message. */
export interface ManualTarget {
  manual: string;
}

/** Still needed after the migration (e.g. the Supabase client used for the database). */
export interface KeepTarget {
  keep: true;
}

export type Target = ImportTarget | ManualTarget | KeepTarget;

export interface ModuleRule {
  /** Exact specifier, or a predicate over it. */
  match: string | ((specifier: string) => boolean);
  /** Named exports → target. */
  named?: Record<string, Target | ((facts: FileFacts) => Target)>;
  /** The default export → target. */
  default?: Target | ((facts: FileFacts) => Target);
  /** Message for any named export not listed in `named`. */
  otherNamed?: string;
  /** Leave unlisted named exports alone (the module stays a dependency). */
  keepOthers?: boolean;
  /** Message for a namespace import / side-effect import of this module. */
  whole?: string;
}

export function isManual(t: Target): t is ManualTarget {
  return (t as ManualTarget).manual !== undefined;
}

export function isKeep(t: Target): t is KeepTarget {
  return (t as KeepTarget).keep === true;
}

export class VendorContext {
  readonly j: JSCodeshift;
  readonly root: Collection;
  readonly facts: FileFacts;
  changed = false;
  private readonly reported = new Set<string>();
  private readonly options: VendorOptions;
  private readonly displayPath: string;

  constructor(j: JSCodeshift, root: Collection, facts: FileFacts, options: VendorOptions) {
    this.j = j;
    this.root = root;
    this.facts = facts;
    this.options = options;
    this.displayPath = options.displayPath ?? facts.path;
  }

  /** Count a rewrite (marks the file as changed). */
  rewrote(): void {
    this.changed = true;
    this.options.onCount?.('rewrite');
  }

  /** Report something for a human, once per (line, message). */
  report(node: ASTNode | ASTPath | null | undefined, message: string): void {
    const line = lineOf(node);
    const key = `${line}\u0000${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.options.onReport?.({ file: this.displayPath, line, message });
  }

  /** Report AND leave a TODO marker on the enclosing statement (deduplicated). */
  manual(path: ASTPath, message: string): void {
    this.report(path, message);
    const statement = enclosingStatement(path);
    if (!statement) return;
    const text = ` ${MIGRATE_TODO} ${message}`;
    const node = statement.node as { comments?: Array<{ value: string; leading?: boolean }> };
    if ((node.comments ?? []).some((c) => c.value.trim() === text.trim())) return;
    const comment = this.j.commentLine(text, true, false);
    node.comments = [...(node.comments ?? []), comment as never];
    this.changed = true;
    this.options.onCount?.('todo');
  }

  /** Parse an expression from source (TS allowed). */
  expr(code: string): ASTNode {
    const program = this.j(`const __atlas = ${code};`).get().node.program;
    return program.body[0].declarations[0].init;
  }

  /** Parse statements from source. */
  statements(code: string): ASTNode[] {
    return this.j(code).get().node.program.body;
  }

  /** The env expression for a public key, in the project's own style (`!` in TS). */
  publicEnv(suffix: 'PUBLISHABLE_KEY' | 'FRONTEND_API'): ASTNode {
    const key = publicEnvKey(this.facts.envStyle, suffix);
    const access = this.facts.envStyle === 'vite' ? `import.meta.env.${key}` : `process.env.${key}`;
    return this.expr(this.facts.isTypeScript ? `${access}!` : access);
  }

  /**
   * Make sure `import { name as local } from module` exists, merging into an
   * existing value import of the same module. Returns the local name to use.
   */
  ensureImport(module: string, name: string, typeOnly = false): string {
    const j = this.j;
    const decls = this.root.find(j.ImportDeclaration, { source: { value: module } }).paths();
    const isTypeDecl = (p: ASTPath<ImportDeclaration>) => p.node.importKind === 'type';
    for (const p of decls) {
      if (!typeOnly && isTypeDecl(p)) continue;
      for (const s of p.node.specifiers ?? []) {
        if (s.type === 'ImportSpecifier' && s.imported.name === name) return s.local?.name ?? name;
      }
    }
    const spec = j.importSpecifier(j.identifier(name));
    const into = decls.find(
      (p) => isTypeDecl(p) === typeOnly && (p.node.specifiers ?? []).every((s) => s.type === 'ImportSpecifier'),
    );
    if (into) {
      into.node.specifiers = [...(into.node.specifiers ?? []), spec];
    } else {
      const decl = j.importDeclaration([spec], j.stringLiteral(module));
      if (typeOnly) decl.importKind = 'type';
      const imports = this.root.find(j.ImportDeclaration);
      if (imports.length > 0) imports.at(imports.length - 1).insertAfter(decl);
      else this.program().body.unshift(decl);
    }
    this.changed = true;
    return name;
  }

  program(): { body: ASTNode[]; directives?: Array<{ value: { value: string } }> } {
    return this.root.get().node.program;
  }
}

/** Public env-var name for an Atlas key in a project's style. */
export function publicEnvKey(style: EnvStyle, suffix: 'PUBLISHABLE_KEY' | 'FRONTEND_API'): string {
  switch (style) {
    case 'vite':
      return `VITE_ATLAS_${suffix}`;
    case 'cra':
      return `REACT_APP_ATLAS_${suffix}`;
    case 'next':
      return `NEXT_PUBLIC_ATLAS_${suffix}`;
    default:
      return `ATLAS_${suffix}`;
  }
}

function lineOf(node: ASTNode | ASTPath | null | undefined): number {
  let cur: ASTPath | null | undefined = node && 'node' in (node as ASTPath) ? (node as ASTPath) : undefined;
  if (!cur) {
    const loc = (node as { loc?: { start?: { line?: number } } } | undefined)?.loc;
    return loc?.start?.line ?? 0;
  }
  while (cur) {
    const loc = (cur.node as { loc?: { start?: { line?: number } } }).loc;
    if (loc?.start?.line) return loc.start.line;
    cur = cur.parent as ASTPath | null;
  }
  return 0;
}

const STATEMENT_TYPES = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'VariableDeclaration',
  'ExpressionStatement',
  'ReturnStatement',
  'IfStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSModuleDeclaration',
  'ThrowStatement',
]);

/** The closest enclosing statement, skipping statements nested in a JSX expression. */
export function enclosingStatement(path: ASTPath): ASTPath | null {
  let cur: ASTPath | null = path;
  while (cur) {
    if (STATEMENT_TYPES.has(cur.node.type)) {
      // An export wrapping a declaration owns the comment.
      const parent = cur.parent as ASTPath | null;
      if (parent && (parent.node.type === 'ExportNamedDeclaration' || parent.node.type === 'ExportDefaultDeclaration')) {
        return parent;
      }
      return cur;
    }
    cur = cur.parent as ASTPath | null;
  }
  return null;
}

/**
 * True when an identifier node is a value/type REFERENCE, not a property key or a
 * member name that merely shares the text (`foo.signIn`, `{ signIn: … }`).
 */
export function isReference(path: ASTPath<Identifier>): boolean {
  const parent = path.parent?.node;
  if (!parent) return true;
  if (
    (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
    parent.property === path.node &&
    !parent.computed
  ) {
    return false;
  }
  if (
    (parent.type === 'ObjectProperty' ||
      parent.type === 'Property' ||
      parent.type === 'ObjectMethod' ||
      parent.type === 'ClassProperty' ||
      parent.type === 'ClassMethod' ||
      parent.type === 'TSPropertySignature' ||
      parent.type === 'TSMethodSignature') &&
    (parent as { key?: unknown }).key === path.node &&
    !(parent as { computed?: boolean }).computed
  ) {
    // `{ signIn }` shorthand IS a reference to the binding.
    return Boolean((parent as { shorthand?: boolean }).shorthand) && (parent as { value?: unknown }).value === path.node;
  }
  if (parent.type === 'TSQualifiedName' && parent.right === path.node) return false;
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier' ||
    parent.type === 'ExportSpecifier'
  ) {
    return false;
  }
  if (
    (parent.type === 'VariableDeclarator' || parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') &&
    (parent as { id?: unknown }).id === path.node
  ) {
    return false;
  }
  return true;
}

/** Every reference (identifier, type name, JSX tag) to a local binding name. */
export function referencesOf(ctx: VendorContext, name: string): ASTPath[] {
  const { j, root } = ctx;
  const ids = root
    .find(j.Identifier, { name })
    .filter((p) => isReference(p as ASTPath<Identifier>))
    .paths();
  const jsx = root
    .find(j.JSXIdentifier, { name })
    .filter((p) => {
      const parent = p.parent?.node;
      if (!parent) return false;
      if (parent.type === 'JSXOpeningElement' || parent.type === 'JSXClosingElement') return parent.name === p.node;
      if (parent.type === 'JSXMemberExpression') return parent.object === p.node;
      return false;
    })
    .paths();
  // ast-types makes JSXIdentifier a subtype of Identifier, so a JSX tag name can be in both lists.
  const seen = new Set<unknown>();
  return [...ids, ...(jsx as ASTPath<JSXIdentifier>[] as ASTPath[])].filter((p) => !seen.has(p.node) && seen.add(p.node));
}

/** Replace a reference node's name (Identifier or JSXIdentifier). */
function renameRef(ref: ASTPath, to: string): void {
  (ref.node as { name: string }).name = to;
  // `{ signIn }` shorthand: the value now names a different binding than the key.
  const parent = ref.parent?.node as { type?: string; shorthand?: boolean; value?: unknown } | undefined;
  if (parent && (parent.type === 'ObjectProperty' || parent.type === 'Property') && parent.shorthand && parent.value === ref.node) {
    parent.shorthand = false;
  }
}

function moduleMatches(rule: ModuleRule, specifier: string): boolean {
  return typeof rule.match === 'string' ? rule.match === specifier : rule.match(specifier);
}

function resolveTarget(t: Target | ((facts: FileFacts) => Target), facts: FileFacts): Target {
  return typeof t === 'function' ? t(facts) : t;
}

/**
 * Apply import rules: for every import from a matching module, rewrite each
 * reference to an Atlas target and drop specifiers nothing references anymore.
 * Returns the vendor imports seen (for vendor passes that need them).
 */
export function applyImportRules(ctx: VendorContext, rules: readonly ModuleRule[]): void {
  const { j, root, facts } = ctx;
  root.find(j.ImportDeclaration).forEach((declPath: ASTPath<ImportDeclaration>) => {
    // A rule earlier in this pass can insert or prune imports, leaving a cached path on another statement.
    if (declPath.node.type !== 'ImportDeclaration') return;
    const source = declPath.node.source.value;
    if (typeof source !== 'string') return;
    const rule = rules.find((r) => moduleMatches(r, source));
    if (!rule) return;
    const declIsType = declPath.node.importKind === 'type';
    const specifiers = declPath.node.specifiers ?? [];

    if (specifiers.length === 0) {
      ctx.manual(declPath, rule.whole ?? `side-effect import of '${source}' has no Atlas counterpart; remove it`);
      return;
    }

    const keep: typeof specifiers = [];
    for (const spec of specifiers) {
      let target: Target | undefined;
      let exportName: string;
      if (spec.type === 'ImportSpecifier') {
        exportName = spec.imported.name;
        const named = rule.named?.[exportName];
        target = named
          ? resolveTarget(named, facts)
          : rule.keepOthers
            ? { keep: true }
            : rule.otherNamed
              ? { manual: `'${exportName}' from '${source}': ${rule.otherNamed}` }
              : undefined;
      } else if (spec.type === 'ImportDefaultSpecifier') {
        exportName = 'default';
        target = rule.default ? resolveTarget(rule.default, facts) : undefined;
      } else {
        exportName = '*';
        target = { manual: rule.whole ?? `namespace import of '${source}' — migrate its members manually` };
      }
      const local = spec.local?.name ?? exportName;
      if (!target) {
        keep.push(spec);
        ctx.manual(declPath, `'${exportName === 'default' ? local : exportName}' from '${source}' has no Atlas counterpart — migrate it manually`);
        continue;
      }
      if (isKeep(target)) {
        keep.push(spec);
        continue;
      }
      if (isManual(target)) {
        keep.push(spec);
        ctx.manual(declPath, target.manual);
        continue;
      }
      const isType = declIsType || (spec as { importKind?: string }).importKind === 'type' || Boolean(target.typeOnly);
      let remaining = 0;
      for (const ref of referencesOf(ctx, local)) {
        const verdict = target.accept ? target.accept(ref, ctx) : true;
        if (verdict !== true) {
          remaining++;
          ctx.manual(ref, verdict);
          continue;
        }
        const to = ctx.ensureImport(target.module, target.name, isType);
        renameRef(ref, to);
        ctx.rewrote();
        target.after?.(ref, ctx);
      }
      if (remaining > 0) keep.push(spec);
      else ctx.changed = true;
    }

    if (keep.length === 0) {
      j(declPath).remove();
    } else if (keep.length !== specifiers.length) {
      declPath.node.specifiers = keep;
    }
  });
}

/**
 * Re-exports from a vendor module (`export { signIn } from 'next-auth/react'`):
 * point each one at its Atlas target, keeping the exported name. `special`
 * handles a specifier itself (returning true), e.g. a middleware default export.
 */
export function applyReexportRules(
  ctx: VendorContext,
  rules: readonly ModuleRule[],
  special?: (path: ASTPath, local: string, exported: string, source: string) => boolean,
): void {
  const { j, root, facts } = ctx;
  root.find(j.ExportAllDeclaration).forEach((path) => {
    const source = String(path.node.source.value);
    if (rules.some((r) => moduleMatches(r, source))) {
      ctx.manual(path, `'export * from ${source}' — re-export the Atlas equivalents you need explicitly`);
    }
  });
  root.find(j.ExportNamedDeclaration).forEach((path) => {
    const source = path.node.source?.value;
    if (typeof source !== 'string') return;
    const rule = rules.find((r) => moduleMatches(r, source));
    if (!rule) return;
    const kept: typeof path.node.specifiers = [];
    const out = new Map<string, Array<{ name: string; exported: string }>>();
    for (const spec of path.node.specifiers ?? []) {
      if (spec.type !== 'ExportSpecifier') {
        kept.push(spec);
        continue;
      }
      const local = String((spec.local as { name?: string } | undefined)?.name ?? '');
      const exported = String((spec.exported as { name?: string }).name);
      if (special?.(path, local, exported, source)) {
        ctx.rewrote();
        continue;
      }
      const raw = local === 'default' ? rule.default : rule.named?.[local];
      const target = raw ? resolveTarget(raw, facts) : rule.keepOthers ? ({ keep: true } as KeepTarget) : undefined;
      if (!target || isKeep(target)) {
        kept.push(spec);
        if (!target) ctx.manual(path, `re-export of '${local}' from '${source}' has no Atlas counterpart`);
        continue;
      }
      if (isManual(target)) {
        kept.push(spec);
        ctx.manual(path, target.manual);
        continue;
      }
      if (target.noReexport) {
        kept.push(spec);
        ctx.manual(path, target.noReexport);
        continue;
      }
      const list = out.get(target.module) ?? [];
      list.push({ name: target.name, exported });
      out.set(target.module, list);
      ctx.rewrote();
    }
    if (out.size === 0 && kept.length === (path.node.specifiers ?? []).length) return;
    const replacements = [...out.entries()].map(([module, list]) =>
      j.exportNamedDeclaration(
        null,
        list.map((e) => j.exportSpecifier.from({ local: j.identifier(e.name), exported: j.identifier(e.exported) })),
        j.stringLiteral(module),
      ),
    );
    if (kept.length > 0) {
      path.node.specifiers = kept;
      if (replacements.length > 0) path.insertAfter(...replacements);
    } else if (replacements.length > 0) {
      path.replace(...replacements);
    } else {
      j(path).remove();
    }
  });
}

/** Rename env keys (`process.env.X`, `process.env['X']`, `import.meta.env.X`). */
export function renameEnv(
  ctx: VendorContext,
  rename: (key: string) => { to: string } | { report: string } | null,
): void {
  const { j, root } = ctx;
  root.find(j.MemberExpression).forEach((path) => {
    const node = path.node;
    if (!isEnvObject(node.object)) return;
    let key: string | undefined;
    if (!node.computed && node.property.type === 'Identifier') key = node.property.name;
    else if (node.computed && (node.property.type === 'StringLiteral' || node.property.type === 'Literal')) {
      key = String((node.property as { value: unknown }).value);
    }
    if (!key) return;
    const verdict = rename(key);
    if (!verdict) return;
    if ('report' in verdict) {
      ctx.manual(path, verdict.report);
      return;
    }
    if (node.property.type === 'Identifier') node.property.name = verdict.to;
    else (node.property as { value: string }).value = verdict.to;
    ctx.rewrote();
  });
}

/** True for `process.env` or `import.meta.env`. */
export function isEnvObject(object: unknown): boolean {
  const node = object as {
    type?: string;
    object?: { type?: string; name?: string; meta?: { name?: string } };
    property?: { type?: string; name?: string };
  };
  if (node?.type !== 'MemberExpression') return false;
  if (node.property?.type !== 'Identifier' || node.property.name !== 'env') return false;
  const inner = node.object;
  if (inner?.type === 'Identifier' && inner.name === 'process') return true;
  return inner?.type === 'MetaProperty' && inner.meta?.name === 'import';
}

/** Directive check (`'use client'` / `'use server'`) on the program. */
export function hasDirective(root: Collection, j: JSCodeshift, value: string): boolean {
  const program = root.get().node.program as {
    directives?: Array<{ value: { value: string } }>;
    body: Array<{ type: string; expression?: { type: string; value?: unknown }; directive?: string }>;
  };
  if ((program.directives ?? []).some((d) => d.value.value === value)) return true;
  return program.body.some(
    (s) =>
      s.type === 'ExpressionStatement' &&
      (s.directive === value ||
        ((s.expression?.type === 'StringLiteral' || s.expression?.type === 'Literal') && s.expression.value === value)),
  );
}

/** Work out where a file runs from its path, directives and imports. */
export function factsFor(file: FileInfo, root: Collection, j: JSCodeshift, envStyle: EnvStyle): FileFacts {
  const path = file.path.replace(/\\/g, '/');
  const base = path.split('/').pop() ?? path;
  const isMiddleware = /^(middleware|proxy)\.[cm]?[jt]sx?$/.test(base);
  const isTypeScript = /\.[cm]?tsx?$/.test(base);
  let kind: FileKind = 'unknown';
  if (hasDirective(root, j, 'use client')) kind = 'client';
  else if (
    hasDirective(root, j, 'use server') ||
    isMiddleware ||
    /(^|\/)(app|src\/app)\//.test(path) ||
    /(^|\/)pages\/api\//.test(path) ||
    /\.server\.[cm]?[jt]sx?$/.test(base)
  ) {
    kind = 'server';
  } else if (/(^|\/)(pages|src\/pages)\//.test(path)) {
    kind = 'client';
  } else {
    const sources = root.find(j.ImportDeclaration).nodes().map((n) => String(n.source.value));
    if (sources.includes('next/headers') || sources.some((s) => s === 'server-only')) kind = 'server';
    else if (envStyle === 'vite' || envStyle === 'cra') kind = 'client';
  }
  return { path, kind, isMiddleware, isTypeScript, envStyle };
}

/** Is this the callee of a call (`ref(...)`), and with how many arguments? */
export function callOf(ref: ASTPath): { args: ASTNode[]; path: ASTPath } | null {
  const parent = ref.parent as ASTPath | null;
  if (parent && (parent.node.type === 'CallExpression' || parent.node.type === 'NewExpression') && (parent.node as { callee: unknown }).callee === ref.node) {
    return { args: (parent.node as { arguments: ASTNode[] }).arguments, path: parent };
  }
  return null;
}

/** A transform entry point with the jscodeshift signature, sharing the vendor machinery. */
export type VendorTransform = (file: FileInfo, api: API, options?: VendorOptions) => string | undefined;

/** Build a vendor transform from its cheap pre-check and its passes. */
export function vendorTransform(input: {
  /** Fast textual pre-check: skip parsing files that cannot be affected. */
  mightApply: (source: string, path: string) => boolean;
  run: (ctx: VendorContext) => void;
}): VendorTransform {
  return (file, api, options = {}) => {
    if (!input.mightApply(file.source, file.path)) return undefined;
    const j = api.jscodeshift;
    const root = j(file.source);
    const ctx = new VendorContext(j, root, factsFor(file, root, j, options.envStyle ?? 'next'), options);
    input.run(ctx);
    if (!ctx.changed) return undefined;
    // recast can double the semicolon after a reprinted directive ('use client';;).
    const out = root.toSource({ quote: 'single' }).replace(/^(\s*(['"])use (?:client|server)\2);;/, '$1;');
    return out === file.source ? undefined : out;
  };
}

/** Set (or add) a JSX attribute's value on an opening element. */
export function setJsxAttr(ctx: VendorContext, opening: { attributes?: ASTNode[] }, name: string, value: ASTNode): void {
  const { j } = ctx;
  const attrs = (opening.attributes ?? []) as Array<{ type: string; name?: { name?: string }; value?: ASTNode }>;
  const existing = attrs.find((a) => a.type === 'JSXAttribute' && a.name?.name === name);
  const container = j.jsxExpressionContainer(value as never);
  if (existing) existing.value = container as never;
  else opening.attributes = [...attrs, j.jsxAttribute(j.jsxIdentifier(name), container) as never] as never;
}

/** Remove JSX attributes by name; returns the names removed. */
export function dropJsxAttrs(opening: { attributes?: ASTNode[] }, names: readonly string[]): string[] {
  const removed: string[] = [];
  opening.attributes = (opening.attributes ?? []).filter((a) => {
    const attr = a as { type: string; name?: { name?: string } };
    if (attr.type === 'JSXAttribute' && attr.name?.name && names.includes(attr.name.name)) {
      removed.push(attr.name.name);
      return false;
    }
    return true;
  });
  return removed;
}

export function getJsxAttr(opening: { attributes?: ASTNode[] }, name: string): { value?: ASTNode } | undefined {
  return (opening.attributes ?? []).find((a) => {
    const attr = a as { type: string; name?: { name?: string } };
    return attr.type === 'JSXAttribute' && attr.name?.name === name;
  }) as { value?: ASTNode } | undefined;
}

/**
 * For a provider element renamed to `<AtlasProvider>`: make sure it has the two
 * required props, mapping old props onto them when given (`map`), dropping the
 * vendor-only ones and reporting what was dropped.
 */
export function fixProviderProps(
  ctx: VendorContext,
  ref: ASTPath,
  config: { map?: Partial<Record<'publishableKey' | 'frontendApi', string>>; drop: readonly string[] },
): void {
  const parent = ref.parent?.node as { type?: string; attributes?: ASTNode[] } | undefined;
  if (!parent || parent.type !== 'JSXOpeningElement') return;
  for (const [atlasProp, vendorProp] of Object.entries(config.map ?? {}) as Array<['publishableKey' | 'frontendApi', string]>) {
    const old = getJsxAttr(parent, vendorProp);
    if (!old) continue;
    const value = old.value as { type?: string; expression?: ASTNode } | undefined;
    dropJsxAttrs(parent, [vendorProp]);
    if (value?.type === 'JSXExpressionContainer' && value.expression && value.expression.type !== 'StringLiteral') {
      // An expression (usually an env var, renamed by the env pass): keep it.
      setJsxAttr(ctx, parent, atlasProp, value.expression);
    } else {
      setJsxAttr(ctx, parent, atlasProp, ctx.publicEnv(atlasProp === 'publishableKey' ? 'PUBLISHABLE_KEY' : 'FRONTEND_API'));
      ctx.report(ref, `${atlasProp} now reads ${publicEnvKey(ctx.facts.envStyle, atlasProp === 'publishableKey' ? 'PUBLISHABLE_KEY' : 'FRONTEND_API')} (the old ${vendorProp} literal was not an Atlas value)`);
    }
  }
  const dropped = dropJsxAttrs(parent, config.drop);
  if (dropped.length > 0) {
    ctx.report(ref, `removed provider props with no Atlas counterpart: ${dropped.join(', ')} (configure these in the Atlas dashboard)`);
  }
  if (!getJsxAttr(parent, 'publishableKey')) setJsxAttr(ctx, parent, 'publishableKey', ctx.publicEnv('PUBLISHABLE_KEY'));
  if (!getJsxAttr(parent, 'frontendApi')) setJsxAttr(ctx, parent, 'frontendApi', ctx.publicEnv('FRONTEND_API'));
}
