import type {
  API,
  ASTPath,
  FileInfo,
  Identifier,
  ImportDeclaration,
  Options,
} from 'jscodeshift';

import {
  IDENTIFIER_MAP,
  PACKAGE_MAP,
  SHARED_IDENTIFIERS,
  TODO_PREFIX,
  isClerkPackage,
  renameEnvKey,
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

/**
 * Codemod: rewrite a Clerk-based source file to its Atlas equivalent.
 *
 * It rewrites, in order:
 *   1. `@clerk/*` import/require/dynamic-import module specifiers -> `@atlasauth/*`;
 *   2. imported identifiers that Atlas renamed (e.g. `ClerkProvider` ->
 *      `AtlasProvider`) together with every reference to them in the file,
 *      including JSX tags;
 *   3. `process.env.CLERK_*` / `import.meta.env.CLERK_*` keys -> `ATLAS_*`.
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
  let changed = false;

  const count = (kind: 'import' | 'identifier' | 'env' | 'todo') => {
    changed = true;
    options.onCount?.(kind);
  };

  // Identifiers whose local binding we renamed, so references can follow.
  // Maps old local name -> new local name.
  const references = new Map<string, string>();

  // --- 1 & 2: import declarations -----------------------------------------
  root.find(j.ImportDeclaration).forEach((path) => {
    const source = path.node.source.value;
    if (typeof source !== 'string') return;

    const atlasPkg = PACKAGE_MAP[source];
    if (!atlasPkg) {
      // Unknown Clerk package: we cannot rewrite it safely, so flag it.
      if (isClerkPackage(source)) {
        addLeadingTodo(j, path, `unmapped Clerk package '${source}' — migrate manually`);
        count('todo');
      }
      return;
    }

    path.node.source.value = atlasPkg;
    count('import');

    const unknownNamed: string[] = [];
    for (const spec of path.node.specifiers ?? []) {
      if (spec.type !== 'ImportSpecifier') {
        // default/namespace imports: the package is renamed, but the local
        // binding name was chosen by the developer, so we leave it alone.
        continue;
      }
      const imported = spec.imported.name;
      const local = spec.local?.name ?? imported;
      const mapped = IDENTIFIER_MAP[imported];

      if (mapped) {
        spec.imported.name = mapped;
        if (local === imported) {
          // Not aliased: keep binding in sync and rename every reference.
          if (spec.local) spec.local.name = mapped;
          references.set(imported, mapped);
        }
        // If aliased (`ClerkProvider as CP`) the local alias and its uses are
        // already correct — only the imported name needed updating.
        count('identifier');
      } else if (!SHARED_IDENTIFIERS.has(imported)) {
        // Imported from Clerk, renamed by neither table, not a shared symbol:
        // it has no confirmed Atlas peer, so defer to a human.
        unknownNamed.push(imported);
      }
    }

    if (unknownNamed.length > 0) {
      addLeadingTodo(
        j,
        path,
        `no 1:1 Atlas equivalent for: ${unknownNamed.join(', ')} — review manually`,
      );
      count('todo');
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
        const atlasPkg = PACKAGE_MAP[arg.value];
        if (atlasPkg) {
          arg.value = atlasPkg;
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

  if (!changed) return undefined;
  // single quotes match the house style used across packages/*/src.
  return root.toSource({ quote: 'single' });
}

/** Attach a `// TODO(atlas-upgrade): ...` line comment above a statement. */
function addLeadingTodo(j: API['jscodeshift'], path: ASTPath<ImportDeclaration>, message: string): void {
  const comment = j.commentLine(` ${TODO_PREFIX} ${message}`, true, false);
  path.node.comments = [...(path.node.comments ?? []), comment];
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
