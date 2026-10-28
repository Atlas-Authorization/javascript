/* eslint-disable @typescript-eslint/no-explicit-any -- a Babel AST is walked generically here */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import jscodeshift from 'jscodeshift';

import { collectSourceFiles } from '../runner';

/**
 * Static analysis of a Better Auth setup.
 *
 * Finds every `betterAuth({...})` call in a project and evaluates its options
 * argument WITHOUT running any of the app's code: object literals, arrays,
 * strings, numbers and booleans are read as they are written; identifiers are
 * followed to their declaration, across files through relative and tsconfig
 * `paths` imports (`export const`, `export default`, `export { a as b }`,
 * `export … from`, `export *`); spreads are merged; arithmetic such as
 * `60 * 60 * 24 * 7` is folded. Environment variables are resolved by NAME only
 * (`process.env.X`, `import.meta.env.X`, `Bun.env.X`, `Deno.env.get('X')`,
 * t3-env `env.X`, a `({ env })` / `c.env.X` binding): their values are never read.
 *
 * Anything that cannot be known statically (a function, a conditional, a call
 * into a package) is kept as a typed placeholder with its file and line, so a
 * translator can say exactly what needs a manual look.
 */

export interface SourceLoc {
  /** Path relative to the analysed root, with forward slashes. */
  file: string;
  line: number;
}

export type StaticValue =
  | { kind: 'string'; value: string; loc: SourceLoc }
  | { kind: 'number'; value: number; loc: SourceLoc }
  | { kind: 'boolean'; value: boolean; loc: SourceLoc }
  | { kind: 'null'; loc: SourceLoc }
  | { kind: 'undefined'; loc: SourceLoc }
  /** An environment variable, by name; `fallback` is the `?? x` / `|| x` default. */
  | { kind: 'env'; name: string; fallback?: StaticValue; loc: SourceLoc }
  /** A template literal with at least one non-literal part. */
  | { kind: 'template'; parts: Array<string | StaticValue>; loc: SourceLoc }
  | {
      kind: 'object';
      props: Record<string, StaticValue>;
      /** Spreads that could not be resolved (their keys are unknown). */
      unresolvedSpreads: StaticValue[];
      loc: SourceLoc;
    }
  | { kind: 'array'; items: StaticValue[]; loc: SourceLoc }
  | {
      kind: 'call';
      /** The callee as written (`twoFactor`, `ac.newRole`). */
      callee: string;
      /** Set when the callee is a binding imported from a package. */
      imported?: { module: string; name: string };
      args: StaticValue[];
      /** For a method call, the value it was called on. */
      receiver?: StaticValue;
      loc: SourceLoc;
    }
  | {
      kind: 'function';
      params: string[];
      async: boolean;
      /** The returned expression, when the function body is a single expression / return. */
      returns?: StaticValue;
      loc: SourceLoc;
    }
  /** A function parameter (or a member path of one) inside a function body. */
  | { kind: 'param'; name: string; path: string[]; loc: SourceLoc }
  /** A binding imported from a package (not a project file). */
  | { kind: 'external'; module: string; name: string; loc: SourceLoc }
  | { kind: 'unknown'; reason: string; text: string; loc: SourceLoc };

export interface BetterAuthInstance {
  /** Where `betterAuth(...)` is called. */
  loc: SourceLoc;
  /** The evaluated options argument (an `unknown` when it cannot be read). */
  options: StaticValue;
}

export interface BetterAuthAnalysis {
  root: string;
  filesScanned: number;
  instances: BetterAuthInstance[];
  /** dependencies + devDependencies of the root package.json (names → ranges). */
  dependencies: Record<string, string>;
  /** Files that could not be parsed (reported, not fatal). */
  parseErrors: Array<{ file: string; message: string }>;
}

type AstNode = { type: string; loc?: { start: { line: number } } | null; start?: number; end?: number; [key: string]: any };

interface ParsedFile {
  abs: string;
  rel: string;
  src: string;
  program: AstNode;
  parents: WeakMap<AstNode, AstNode>;
}

type Binding =
  | { type: 'declarator'; node: AstNode; file: ParsedFile; path: string[] }
  | { type: 'function'; node: AstNode; file: ParsedFile }
  | { type: 'import'; source: string; imported: string; file: ParsedFile; node: AstNode }
  | { type: 'param'; name: string; path: string[]; node: AstNode; file: ParsedFile };

const MAX_DEPTH = 60;
const ENV_PARAM = /^(env|ENV|bindings|vars)$/;

/** Defaults Better Auth exports for access control, so `...adminAc.statements` resolves. */
const BA_STATEMENTS: Record<string, Record<string, string[]>> = {
  'organization:defaultStatements': {
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
  },
  'organization:ownerAc': {
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
  },
  'organization:adminAc': {
    organization: ['update'],
    invitation: ['create', 'cancel'],
    member: ['create', 'update', 'delete'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
  },
  'organization:memberAc': { organization: [], member: [], invitation: [], team: [], ac: ['read'] },
  'admin:defaultStatements': {
    user: ['create', 'list', 'set-role', 'ban', 'impersonate', 'delete', 'set-password', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
  },
  'admin:adminAc': {
    user: ['create', 'list', 'set-role', 'ban', 'impersonate', 'delete', 'set-password', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
  },
  'admin:userAc': { user: [], session: [] },
};

class Analyzer {
  private files = new Map<string, ParsedFile | null>();
  private tsconfigs = new Map<string, { baseUrl: string; paths: Record<string, string[]> } | null>();
  private active = new Set<string>();
  readonly parseErrors: Array<{ file: string; message: string }> = [];

  constructor(readonly root: string) {}

  // ───────────────────────────── parsing ─────────────────────────────

  parse(abs: string): ParsedFile | null {
    if (this.files.has(abs)) return this.files.get(abs) ?? null;
    let parsed: ParsedFile | null = null;
    try {
      const src = readFileSync(abs, 'utf8');
      const program = parseProgram(src, abs);
      const parents = new WeakMap<AstNode, AstNode>();
      linkParents(program, parents);
      parsed = { abs, rel: relative(this.root, abs).split('\\').join('/') || abs, src, program, parents };
    } catch (err) {
      this.parseErrors.push({
        file: relative(this.root, abs).split('\\').join('/'),
        message: err instanceof Error ? err.message.split('\n')[0]! : String(err),
      });
    }
    this.files.set(abs, parsed);
    return parsed;
  }

  // ───────────────────────────── module resolution ─────────────────────────────

  resolveModule(fromAbs: string, spec: string): string | null {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      return resolveFile(isAbsolute(spec) ? spec : resolve(dirname(fromAbs), spec));
    }
    const ts = this.tsconfigFor(dirname(fromAbs));
    if (ts) {
      for (const [pattern, targets] of Object.entries(ts.paths)) {
        const star = pattern.indexOf('*');
        let rest: string | null = null;
        if (star === -1) {
          if (spec === pattern) rest = '';
        } else {
          const pre = pattern.slice(0, star);
          const post = pattern.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
            rest = spec.slice(pre.length, spec.length - post.length);
          }
        }
        if (rest === null) continue;
        for (const target of targets) {
          const found = resolveFile(resolve(ts.baseUrl, target.replace('*', rest)));
          if (found) return found;
        }
      }
    }
    return null;
  }

  private tsconfigFor(dir: string): { baseUrl: string; paths: Record<string, string[]> } | null {
    if (this.tsconfigs.has(dir)) return this.tsconfigs.get(dir) ?? null;
    let found: { baseUrl: string; paths: Record<string, string[]> } | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      found = readTsconfig(file);
      if (found) break;
    }
    if (!found) {
      const parent = dirname(dir);
      const inRoot = !relative(this.root, parent).startsWith('..');
      found = parent !== dir && inRoot ? this.tsconfigFor(parent) : null;
    }
    this.tsconfigs.set(dir, found);
    return found;
  }

  // ───────────────────────────── bindings ─────────────────────────────

  /** Find the declaration `name` refers to from `from`, walking the lexical scopes outward. */
  lookup(name: string, from: AstNode, file: ParsedFile): Binding | null {
    let node = file.parents.get(from);
    while (node) {
      if (isFunction(node)) {
        for (const param of node.params ?? []) {
          const hit = bindingInPattern(param, name);
          if (hit) return { type: 'param', name: hit.root, path: hit.path, node: param, file };
        }
      }
      const body: AstNode[] | undefined =
        node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock'
          ? node.body
          : undefined;
      if (body) {
        const hit = this.bindingInStatements(body, name, file);
        if (hit) return hit;
      }
      node = file.parents.get(node);
    }
    return null;
  }

  private bindingInStatements(body: AstNode[], name: string, file: ParsedFile): Binding | null {
    for (const raw of body) {
      const stmt = raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration' ? raw.declaration ?? raw : raw;
      if (!stmt) continue;
      if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations ?? []) {
          const hit = bindingInPattern(decl.id, name);
          if (hit) return { type: 'declarator', node: decl, file, path: hit.path };
        }
      } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'TSDeclareFunction') && stmt.id?.name === name) {
        return { type: 'function', node: stmt, file };
      } else if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type') {
        for (const spec of stmt.specifiers ?? []) {
          if (spec.local?.name !== name) continue;
          const imported =
            spec.type === 'ImportDefaultSpecifier'
              ? 'default'
              : spec.type === 'ImportNamespaceSpecifier'
                ? '*'
                : (spec.imported?.name ?? spec.imported?.value ?? name);
          return { type: 'import', source: String(stmt.source.value), imported, file, node: spec };
        }
      }
    }
    return null;
  }

  /** The value a module exports under `name` (`default` for the default export). */
  exportOf(file: ParsedFile, name: string, depth: number, seen = new Set<string>()): StaticValue | null {
    const key = `${file.abs}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    for (const stmt of file.program.body as AstNode[]) {
      if (stmt.type === 'ExportNamedDeclaration') {
        const decl = stmt.declaration;
        if (decl?.type === 'VariableDeclaration') {
          for (const d of decl.declarations ?? []) {
            const hit = bindingInPattern(d.id, name);
            if (hit) return this.evalDeclarator({ type: 'declarator', node: d, file, path: hit.path }, depth);
          }
        } else if (decl?.type === 'FunctionDeclaration' && decl.id?.name === name) {
          return this.evalFunction(decl, file, depth);
        }
        for (const spec of stmt.specifiers ?? []) {
          const exported = spec.exported?.name ?? spec.exported?.value;
          if (exported !== name) continue;
          const local = spec.local?.name ?? spec.local?.value ?? exported;
          if (stmt.source) {
            const target = this.resolveModule(file.abs, String(stmt.source.value));
            const parsed = target ? this.parse(target) : null;
            if (!parsed) return external(String(stmt.source.value), local, locOf(spec, file));
            return this.exportOf(parsed, spec.type === 'ExportNamespaceSpecifier' ? '*' : local, depth + 1, seen);
          }
          return this.evalIdentifierName(local, spec, file, depth + 1);
        }
      } else if (stmt.type === 'ExportDefaultDeclaration' && name === 'default') {
        const decl = stmt.declaration;
        if (decl.type === 'FunctionDeclaration') return this.evalFunction(decl, file, depth);
        return this.eval(decl, file, depth + 1);
      } else if (stmt.type === 'ExpressionStatement' && name === 'default') {
        // CommonJS: module.exports = …
        const e = stmt.expression;
        if (
          e?.type === 'AssignmentExpression' &&
          e.left?.type === 'MemberExpression' &&
          e.left.object?.name === 'module' &&
          (e.left.property?.name === 'exports' || e.left.property?.value === 'exports')
        ) {
          return this.eval(e.right, file, depth + 1);
        }
      }
    }
    for (const stmt of file.program.body as AstNode[]) {
      if (stmt.type !== 'ExportAllDeclaration' || name === 'default') continue;
      const target = this.resolveModule(file.abs, String(stmt.source.value));
      const parsed = target ? this.parse(target) : null;
      if (!parsed) continue;
      const hit = this.exportOf(parsed, name, depth + 1, seen);
      if (hit) return hit;
    }
    // `export { x }` handled above; a plain top-level declaration is a last resort.
    const local = this.bindingInStatements(file.program.body, name, file);
    if (local && local.type !== 'import') return this.evalBinding(local, depth + 1, file.program);
    return null;
  }

  // ───────────────────────────── evaluation ─────────────────────────────

  eval(node: AstNode | null | undefined, file: ParsedFile, depth = 0): StaticValue {
    if (!node) return { kind: 'undefined', loc: { file: file.rel, line: 0 } };
    const loc = locOf(node, file);
    if (depth > MAX_DEPTH) return unknown('too deeply nested to follow', node, file);
    switch (node.type) {
      case 'StringLiteral':
        return { kind: 'string', value: node.value, loc };
      case 'NumericLiteral':
        return { kind: 'number', value: node.value, loc };
      case 'BooleanLiteral':
        return { kind: 'boolean', value: node.value, loc };
      case 'NullLiteral':
        return { kind: 'null', loc };
      case 'Literal': // estree fallback
        if (node.value === null) return { kind: 'null', loc };
        if (typeof node.value === 'string') return { kind: 'string', value: node.value, loc };
        if (typeof node.value === 'number') return { kind: 'number', value: node.value, loc };
        if (typeof node.value === 'boolean') return { kind: 'boolean', value: node.value, loc };
        return unknown('literal', node, file);
      case 'TemplateLiteral':
        return this.evalTemplate(node, file, depth);
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TypeCastExpression':
      case 'ParenthesizedExpression':
      case 'TSInstantiationExpression':
        return this.eval(node.expression, file, depth + 1);
      case 'AwaitExpression':
        return this.eval(node.argument, file, depth + 1);
      case 'Identifier':
        return this.evalIdentifierName(node.name, node, file, depth);
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return this.evalMember(node, file, depth);
      case 'ObjectExpression':
        return this.evalObject(node, file, depth);
      case 'ArrayExpression': {
        const items: StaticValue[] = [];
        for (const el of node.elements ?? []) {
          if (!el) continue;
          if (el.type === 'SpreadElement') {
            const spread = this.eval(el.argument, file, depth + 1);
            if (spread.kind === 'array') items.push(...spread.items);
            else items.push(spread.kind === 'unknown' ? spread : unknown('spread of a value that is not an array', el, file));
          } else {
            items.push(this.eval(el, file, depth + 1));
          }
        }
        return { kind: 'array', items, loc };
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression':
        return this.evalCall(node, file, depth);
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration':
      case 'ObjectMethod':
        return this.evalFunction(node, file, depth);
      case 'UnaryExpression': {
        const arg = this.eval(node.argument, file, depth + 1);
        if (node.operator === '-' && arg.kind === 'number') return { kind: 'number', value: -arg.value, loc };
        if (node.operator === '+' && arg.kind === 'number') return arg;
        if (node.operator === '!' && arg.kind === 'boolean') return { kind: 'boolean', value: !arg.value, loc };
        if (node.operator === 'void') return { kind: 'undefined', loc };
        return unknown('expression', node, file);
      }
      case 'BinaryExpression':
        return this.evalBinary(node, file, depth);
      case 'LogicalExpression': {
        const left = this.eval(node.left, file, depth + 1);
        if (node.operator === '??' || node.operator === '||') {
          if (left.kind === 'env') return { ...left, fallback: this.eval(node.right, file, depth + 1) };
          if (left.kind === 'null' || left.kind === 'undefined') return this.eval(node.right, file, depth + 1);
          if (node.operator === '||' && isFalsyLiteral(left)) return this.eval(node.right, file, depth + 1);
          if (isLiteral(left)) return left;
        }
        if (node.operator === '&&' && isLiteral(left)) {
          return isFalsyLiteral(left) ? left : this.eval(node.right, file, depth + 1);
        }
        return unknown('a runtime condition', node, file);
      }
      case 'ConditionalExpression':
        return unknown('a runtime condition', node, file);
      case 'ClassExpression':
        return unknown('a class', node, file);
      default:
        return unknown('an expression that cannot be read statically', node, file);
    }
  }

  private evalTemplate(node: AstNode, file: ParsedFile, depth: number): StaticValue {
    const parts: Array<string | StaticValue> = [];
    const quasis = node.quasis as AstNode[];
    const exprs = node.expressions as AstNode[];
    quasis.forEach((q, i) => {
      const text = q.value?.cooked ?? q.value?.raw ?? '';
      if (text) parts.push(text);
      if (i < exprs.length) {
        const v = this.eval(exprs[i], file, depth + 1);
        if (v.kind === 'string') parts.push(v.value);
        else if (v.kind === 'number' || v.kind === 'boolean') parts.push(String(v.value));
        else if (v.kind === 'template') parts.push(...v.parts);
        else parts.push(v);
      }
    });
    const merged: Array<string | StaticValue> = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (typeof p === 'string' && typeof last === 'string') merged[merged.length - 1] = last + p;
      else merged.push(p);
    }
    const loc = locOf(node, file);
    if (merged.every((p) => typeof p === 'string')) return { kind: 'string', value: merged.join(''), loc };
    return { kind: 'template', parts: merged, loc };
  }

  private evalBinary(node: AstNode, file: ParsedFile, depth: number): StaticValue {
    const loc = locOf(node, file);
    const l = this.eval(node.left, file, depth + 1);
    const r = this.eval(node.right, file, depth + 1);
    if (l.kind === 'number' && r.kind === 'number') {
      const a = l.value;
      const b = r.value;
      const ops: Record<string, () => number> = {
        '+': () => a + b,
        '-': () => a - b,
        '*': () => a * b,
        '/': () => a / b,
        '%': () => a % b,
        '**': () => a ** b,
      };
      const op = ops[node.operator];
      if (op) return { kind: 'number', value: op(), loc };
    }
    if (node.operator === '+' && (l.kind === 'string' || r.kind === 'string' || l.kind === 'template' || r.kind === 'template' || l.kind === 'env' || r.kind === 'env')) {
      const asParts = (v: StaticValue): Array<string | StaticValue> =>
        v.kind === 'string' ? [v.value] : v.kind === 'number' ? [String(v.value)] : v.kind === 'template' ? v.parts : [v];
      const parts = [...asParts(l), ...asParts(r)];
      if (parts.every((p) => typeof p === 'string')) return { kind: 'string', value: parts.join(''), loc };
      return { kind: 'template', parts, loc };
    }
    return unknown('a runtime expression', node, file);
  }

  private evalObject(node: AstNode, file: ParsedFile, depth: number): StaticValue {
    const props: Record<string, StaticValue> = {};
    const unresolvedSpreads: StaticValue[] = [];
    for (const prop of node.properties ?? []) {
      if (prop.type === 'SpreadElement' || prop.type === 'SpreadProperty') {
        const spread = this.eval(prop.argument, file, depth + 1);
        if (spread.kind === 'object') {
          Object.assign(props, spread.props);
          unresolvedSpreads.push(...spread.unresolvedSpreads);
        } else if (spread.kind !== 'null' && spread.kind !== 'undefined') {
          unresolvedSpreads.push(spread);
        }
        continue;
      }
      const key = this.propKey(prop, file, depth);
      if (key === null) {
        unresolvedSpreads.push(unknown('a computed key', prop, file));
        continue;
      }
      if (prop.type === 'ObjectMethod') {
        if (prop.kind === 'get' || prop.kind === 'set') {
          props[key] = unknown('a getter', prop, file);
        } else {
          props[key] = this.evalFunction(prop, file, depth + 1);
        }
        continue;
      }
      const value = this.eval(prop.value, file, depth + 1);
      // A scalar reached through a constant (`expiresIn: WEEK`) is reported at the
      // option that sets it, not where the constant is declared.
      const scalar = value.kind !== 'object' && value.kind !== 'array' && value.kind !== 'function';
      props[key] = scalar && prop.value?.type === 'Identifier' ? { ...value, loc: locOf(prop.value, file) } : value;
    }
    return { kind: 'object', props, unresolvedSpreads, loc: locOf(node, file) };
  }

  private propKey(prop: AstNode, file: ParsedFile, depth: number): string | null {
    const k = prop.key;
    if (!k) return null;
    if (!prop.computed) {
      if (k.type === 'Identifier') return k.name;
      if (k.type === 'StringLiteral' || k.type === 'NumericLiteral' || k.type === 'Literal') return String(k.value);
      return null;
    }
    const v = this.eval(k, file, depth + 1);
    if (v.kind === 'string' || v.kind === 'number') return String(v.value);
    return null;
  }

  evalIdentifierName(name: string, node: AstNode, file: ParsedFile, depth: number): StaticValue {
    if (name === 'undefined') return { kind: 'undefined', loc: locOf(node, file) };
    const binding = this.lookup(name, node, file) ?? (node.type === 'Program' ? null : this.lookupTop(name, file));
    if (!binding) return unknown(GLOBALS.has(name) ? `global:${name}` : 'an unresolved name', node, file, name);
    return this.evalBinding(binding, depth + 1, node);
  }

  private lookupTop(name: string, file: ParsedFile): Binding | null {
    return this.bindingInStatements(file.program.body, name, file);
  }

  private evalBinding(binding: Binding, depth: number, at: AstNode): StaticValue {
    switch (binding.type) {
      case 'declarator':
        return this.evalDeclarator(binding, depth);
      case 'function':
        return this.evalFunction(binding.node, binding.file, depth);
      case 'param':
        return { kind: 'param', name: binding.name, path: binding.path, loc: locOf(at, binding.file) };
      case 'import': {
        const target = this.resolveModule(binding.file.abs, binding.source);
        const parsed = target ? this.parse(target) : null;
        if (!parsed) {
          const loc = locOf(binding.node, binding.file);
          const area = /admin/.test(binding.source) ? 'admin' : 'organization';
          const defaults = /^better-auth|^@better-auth\//.test(binding.source) && binding.imported === 'defaultStatements'
            ? BA_STATEMENTS[`${area}:defaultStatements`]
            : undefined;
          return defaults ? statementsValue(defaults, loc) : external(binding.source, binding.imported, loc);
        }
        if (binding.imported === '*') return this.namespaceOf(parsed, depth);
        return (
          this.exportOf(parsed, binding.imported, depth + 1) ??
          unknown(`'${binding.imported}' is not exported by ${parsed.rel}`, binding.node, binding.file, binding.imported)
        );
      }
    }
  }

  private namespaceOf(file: ParsedFile, depth: number): StaticValue {
    const props: Record<string, StaticValue> = {};
    for (const stmt of file.program.body as AstNode[]) {
      if (stmt.type !== 'ExportNamedDeclaration') continue;
      const decl = stmt.declaration;
      if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations ?? []) {
          if (d.id?.type === 'Identifier') props[d.id.name] = this.evalDeclarator({ type: 'declarator', node: d, file, path: [] }, depth + 1);
        }
      }
    }
    return { kind: 'object', props, unresolvedSpreads: [], loc: { file: file.rel, line: 1 } };
  }

  private evalDeclarator(binding: Extract<Binding, { type: 'declarator' }>, depth: number): StaticValue {
    const { node, file } = binding;
    const key = `${file.abs}:${node.start ?? 0}`;
    if (this.active.has(key)) return unknown('a circular reference', node, file);
    this.active.add(key);
    try {
      let value = node.init ? this.eval(node.init, file, depth + 1) : unknown('declared without a value', node, file);
      for (const seg of binding.path) value = this.memberOf(value, seg, node, file);
      return value;
    } finally {
      this.active.delete(key);
    }
  }

  evalFunction(node: AstNode, file: ParsedFile, depth: number): StaticValue {
    const params = (node.params ?? []).map((p: AstNode) => patternName(p));
    const loc = locOf(node, file);
    let returnsNode: AstNode | null = null;
    if (node.body && node.body.type !== 'BlockStatement') returnsNode = node.body;
    else if (node.body?.type === 'BlockStatement') {
      const returns = (node.body.body as AstNode[]).filter((s) => s.type === 'ReturnStatement');
      if (returns.length) returnsNode = returns[returns.length - 1]!.argument ?? null;
    }
    const fn: StaticValue = { kind: 'function', params, async: Boolean(node.async), loc };
    if (returnsNode && depth < MAX_DEPTH - 10) {
      const key = `${file.abs}:fn:${node.start ?? 0}`;
      if (!this.active.has(key)) {
        this.active.add(key);
        try {
          fn.returns = this.eval(returnsNode, file, depth + 1);
        } finally {
          this.active.delete(key);
        }
      }
    }
    return fn;
  }

  /** `value.prop`, with the env / param / statements conventions applied. */
  memberOf(value: StaticValue, prop: string, node: AstNode, file: ParsedFile): StaticValue {
    const loc = locOf(node, file);
    switch (value.kind) {
      case 'object': {
        const hit = value.props[prop];
        if (hit) return hit;
        if (value.unresolvedSpreads.length) return unknown(`'${prop}' may come from a spread that cannot be read`, node, file);
        return { kind: 'undefined', loc };
      }
      case 'array': {
        if (prop === 'length') return { kind: 'number', value: value.items.length, loc };
        const i = Number(prop);
        if (Number.isInteger(i)) return value.items[i] ?? { kind: 'undefined', loc };
        return unknown(`array .${prop}`, node, file);
      }
      case 'param': {
        if ((value.path.length === 0 && ENV_PARAM.test(value.name)) || value.path[value.path.length - 1] === 'env') {
          return { kind: 'env', name: prop, loc };
        }
        return { kind: 'param', name: value.name, path: [...value.path, prop], loc };
      }
      case 'external': {
        if (/^(env|ENV)$/.test(value.name) || value.name.endsWith('.env')) return { kind: 'env', name: prop, loc };
        const statements = baStatements(value.module, value.name, prop);
        if (statements) return statements(loc);
        return external(value.module, `${value.name}.${prop}`, loc);
      }
      case 'call': {
        if (/(^|\.)createEnv$/.test(value.callee)) return { kind: 'env', name: prop, loc };
        if (prop === 'statements' && /(^|\.)newRole$/.test(value.callee)) return value.args[0] ?? { kind: 'undefined', loc };
        if (/(^|\.)createAccessControl$/.test(value.callee) && prop === 'statements') {
          return value.args[0] ?? { kind: 'undefined', loc };
        }
        return unknown(`'${prop}' of the result of ${value.callee}()`, node, file);
      }
      case 'unknown': {
        if (value.reason === 'global:process' && prop === 'env') return envRoot(loc);
        if (value.reason === 'global:Bun' && prop === 'env') return envRoot(loc);
        if (value.reason === 'global:Deno' && prop === 'env') return { ...value, reason: 'global:Deno.env', loc };
        if (value.reason === 'env-root') return { kind: 'env', name: prop, loc };
        return value;
      }
      default:
        return unknown(`'${prop}' of a ${value.kind}`, node, file);
    }
  }

  private evalMember(node: AstNode, file: ParsedFile, depth: number): StaticValue {
    let prop: string | null = null;
    if (!node.computed) prop = node.property?.name ?? null;
    else {
      const v = this.eval(node.property, file, depth + 1);
      if (v.kind === 'string' || v.kind === 'number') prop = String(v.value);
    }
    if (prop === null) return unknown('a computed member', node, file);
    if (node.object?.type === 'MetaProperty' && prop === 'env') return envRoot(locOf(node, file));
    const obj = this.eval(node.object, file, depth + 1);
    return this.memberOf(obj, prop, node, file);
  }

  private evalCall(node: AstNode, file: ParsedFile, depth: number): StaticValue {
    const loc = locOf(node, file);
    const callee = node.callee as AstNode;
    const args: StaticValue[] = (node.arguments ?? []).map((a: AstNode) =>
      a.type === 'SpreadElement' ? unknown('a spread argument', a, file) : this.eval(a, file, depth + 1),
    );
    const calleeText = textOf(callee, file);

    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
      const method = !callee.computed ? callee.property?.name : undefined;
      const receiver = this.eval(callee.object, file, depth + 1);
      if (receiver.kind === 'unknown' && receiver.reason === 'global:Deno.env' && method === 'get') {
        const a = args[0];
        if (a?.kind === 'string') return { kind: 'env', name: a.value, loc };
      }
      if (receiver.kind === 'array' && method && ['filter', 'flat', 'slice'].includes(method)) {
        // `[a, b].filter(Boolean)`: the readable items stay; falsy literals drop.
        return { ...receiver, items: receiver.items.filter((i) => !isFalsyLiteral(i)) };
      }
      if (receiver.kind === 'array' && method === 'concat') {
        const items = [...receiver.items];
        for (const a of args) {
          if (a.kind === 'array') items.push(...a.items);
          else items.push(a);
        }
        return { ...receiver, items };
      }
      return { kind: 'call', callee: calleeText, args, receiver, loc };
    }

    if (callee.type === 'Identifier') {
      if (['Number', 'parseInt', 'parseFloat', 'String', 'Boolean'].includes(callee.name)) {
        const a = args[0];
        if (a?.kind === 'env') return { ...a, loc };
        if (callee.name === 'Number' || callee.name.startsWith('parse')) {
          if (a?.kind === 'string' && a.value.trim() !== '' && Number.isFinite(Number(a.value))) {
            return { kind: 'number', value: Number(a.value), loc };
          }
          if (a?.kind === 'number') return a;
        }
      }
      const target = this.evalIdentifierName(callee.name, callee, file, depth + 1);
      if (target.kind === 'external') {
        return { kind: 'call', callee: callee.name, imported: { module: target.module, name: target.name }, args, loc };
      }
      if (target.kind === 'function' && target.returns && isPluginShaped(target.returns)) {
        // A local wrapper (`const plugins = () => [twoFactor()]`): read through it.
        return target.returns;
      }
      if (target.kind === 'call' && target.imported) {
        // A curried plugin factory imported from a package.
        return { kind: 'call', callee: callee.name, imported: target.imported, args, loc };
      }
      return { kind: 'call', callee: callee.name, args, loc };
    }
    return { kind: 'call', callee: calleeText, args, loc };
  }

  // ───────────────────────────── discovery ─────────────────────────────

  /** Every `betterAuth(...)` call in a file. */
  findInstances(file: ParsedFile): BetterAuthInstance[] {
    const out: BetterAuthInstance[] = [];
    walk(file.program, (node) => {
      if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') return;
      const name = node.callee.name as string;
      const binding = this.lookup(name, node.callee, file);
      let isBetterAuth = false;
      if (binding?.type === 'import') {
        isBetterAuth = binding.imported === 'betterAuth' && /^better-auth(\/|$)/.test(binding.source);
      } else if (!binding) {
        isBetterAuth = name === 'betterAuth';
      }
      if (!isBetterAuth) return;
      const arg = node.arguments?.[0];
      out.push({
        loc: locOf(node, file),
        options: arg ? this.eval(arg, file, 0) : unknown('betterAuth() called without options', node, file),
      });
    });
    return out;
  }

  // ───────────────────────────── generic call discovery ─────────────────────────────

  /** The package binding an identifier names: an ES import, or a CommonJS `require('x')` / `require('x').Y` / `const { Y } = require('x')`. */
  packageBinding(name: string, from: AstNode, file: ParsedFile): { module: string; name: string } | null {
    const binding = this.lookup(name, from, file);
    if (!binding) return null;
    if (binding.type === 'import') return { module: binding.source, name: binding.imported };
    if (binding.type !== 'declarator') return null;
    let init = binding.node.init as AstNode | undefined;
    const member: string[] = [];
    while (init && (init.type === 'MemberExpression' || init.type === 'OptionalMemberExpression') && !init.computed) {
      member.unshift(init.property?.name);
      init = init.object;
    }
    if (init?.type !== 'CallExpression' || init.callee?.type !== 'Identifier' || init.callee.name !== 'require') return null;
    const arg = init.arguments?.[0];
    if (arg?.type !== 'StringLiteral' && !(arg?.type === 'Literal' && typeof arg.value === 'string')) return null;
    const path = [...member, ...binding.path];
    return { module: String(arg.value), name: path[0] ?? 'default' };
  }

  /** Every call (or `new`) in a file whose callee is a package binding a matcher names. */
  findCalls(file: ParsedFile, matchers: readonly CallMatcher[]): FoundCall[] {
    const out: FoundCall[] = [];
    walk(file.program, (node) => {
      const isNew = node.type === 'NewExpression';
      if (!isNew && node.type !== 'CallExpression') return;
      const callee = node.callee as AstNode | undefined;
      let pkg: { module: string; name: string } | null = null;
      let calleeText = '';
      if (callee?.type === 'Identifier') {
        pkg = this.packageBinding(callee.name, callee, file);
        calleeText = callee.name;
      } else if ((callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') && !callee.computed && callee.object?.type === 'Identifier') {
        // `new Providers.GitHub(...)`, `passportGoogle.Strategy` on a namespace / require binding.
        const base = this.packageBinding(callee.object.name, callee.object, file);
        if (base && (base.name === '*' || base.name === 'default')) pkg = { module: base.module, name: callee.property?.name };
        calleeText = textOf(callee, file);
      }
      if (!pkg) return;
      for (const m of matchers) {
        if (m.construct !== undefined && m.construct !== isNew) continue;
        if (!m.module.test(pkg.module)) continue;
        if (m.names !== '*' && !m.names.includes(pkg.name)) continue;
        out.push({
          matcher: m.id,
          callee: calleeText,
          imported: pkg,
          loc: locOf(node, file),
          args: (node.arguments ?? []).map((a: AstNode) => this.eval(a, file, 0)),
        });
        break;
      }
    });
    return out;
  }
}

const GLOBALS = new Set(['process', 'Bun', 'Deno', 'globalThis', 'window', 'console', 'Date', 'Math', 'JSON']);

function envRoot(loc: SourceLoc): StaticValue {
  return { kind: 'unknown', reason: 'env-root', text: 'process.env', loc };
}

function external(module: string, name: string, loc: SourceLoc): StaticValue {
  return { kind: 'external', module, name, loc };
}

function unknown(reason: string, node: AstNode, file: ParsedFile, text?: string): StaticValue {
  return { kind: 'unknown', reason, text: text ?? textOf(node, file), loc: locOf(node, file) };
}

function baStatements(module: string, name: string, prop: string): ((loc: SourceLoc) => StaticValue) | null {
  if (!/^better-auth|^@better-auth\//.test(module)) return null;
  const area = /admin/.test(module) ? 'admin' : 'organization';
  const table = prop === 'statements' ? BA_STATEMENTS[`${area}:${name}`] : undefined;
  if (!table) return null;
  return (loc) => statementsValue(table, loc);
}

function statementsValue(table: Record<string, string[]>, loc: SourceLoc): StaticValue {
  const props: Record<string, StaticValue> = {};
  for (const [k, actions] of Object.entries(table)) {
    props[k] = { kind: 'array', items: actions.map((a) => ({ kind: 'string', value: a, loc })), loc };
  }
  return { kind: 'object', props, unresolvedSpreads: [], loc };
}

function isLiteral(v: StaticValue): boolean {
  return v.kind === 'string' || v.kind === 'number' || v.kind === 'boolean' || v.kind === 'object' || v.kind === 'array';
}

function isFalsyLiteral(v: StaticValue): boolean {
  return (
    v.kind === 'null' ||
    v.kind === 'undefined' ||
    (v.kind === 'boolean' && !v.value) ||
    (v.kind === 'number' && v.value === 0) ||
    (v.kind === 'string' && v.value === '')
  );
}

function isPluginShaped(v: StaticValue): boolean {
  return v.kind === 'call' || v.kind === 'array' || v.kind === 'object';
}

function isFunction(node: AstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod'
  );
}

/** Whether `pattern` binds `name`; the member path into the bound value when it is destructured. */
function bindingInPattern(pattern: AstNode | null | undefined, name: string): { root: string; path: string[] } | null {
  if (!pattern) return null;
  switch (pattern.type) {
    case 'Identifier':
      return pattern.name === name ? { root: name, path: [] } : null;
    case 'AssignmentPattern':
      return bindingInPattern(pattern.left, name);
    case 'TSParameterProperty':
      return bindingInPattern(pattern.parameter, name);
    case 'RestElement':
      return pattern.argument?.name === name ? { root: name, path: [] } : null;
    case 'ObjectPattern':
      for (const prop of pattern.properties ?? []) {
        if (prop.type === 'RestElement') {
          if (prop.argument?.name === name) return { root: name, path: [] };
          continue;
        }
        const key = prop.key?.name ?? prop.key?.value;
        const inner = bindingInPattern(prop.value, name);
        if (inner && key !== undefined) {
          // A destructured param is reported by its local name (`({ env })` → env).
          return { root: inner.root, path: [String(key), ...inner.path] };
        }
      }
      return null;
    case 'ArrayPattern':
      for (const [i, el] of (pattern.elements ?? []).entries()) {
        const inner = bindingInPattern(el, name);
        if (inner) return { root: inner.root, path: [String(i), ...inner.path] };
      }
      return null;
    default:
      return null;
  }
}

function patternName(p: AstNode): string {
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'AssignmentPattern') return patternName(p.left);
  if (p.type === 'RestElement') return `...${patternName(p.argument)}`;
  if (p.type === 'ObjectPattern') return '{}';
  if (p.type === 'ArrayPattern') return '[]';
  return '?';
}

function locOf(node: AstNode, file: ParsedFile): SourceLoc {
  // The ts parser can leave loc null on a node it re-wraps (the call in `export default NextAuth(…)`); its offset still holds.
  const line = node.loc?.start?.line ?? (typeof node.start === 'number' ? lineAt(file.src, node.start) : 0);
  return { file: file.rel, line };
}

function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function textOf(node: AstNode, file: ParsedFile): string {
  if (typeof node.start !== 'number' || typeof node.end !== 'number') return node.type;
  const text = file.src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const SKIP_KEYS = new Set(['loc', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'extra', 'original', 'typeAnnotation', 'returnType', 'typeParameters']);

function linkParents(node: AstNode, parents: WeakMap<AstNode, AstNode>): void {
  const stack: AstNode[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    for (const key of Object.keys(current)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = current[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && typeof item.type === 'string') {
            parents.set(item, current);
            stack.push(item);
          }
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        parents.set(value, current);
        stack.push(value);
      }
    }
  }
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  const stack: AstNode[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    visit(current);
    for (const key of Object.keys(current)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = current[key];
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          const item = value[i];
          if (item && typeof item === 'object' && typeof item.type === 'string') stack.push(item);
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
}

function parseProgram(src: string, abs: string): AstNode {
  const preferTs = /\.(ts|mts|cts)$/.test(abs);
  const order = preferTs ? (['ts', 'tsx'] as const) : (['tsx', 'ts'] as const);
  let lastError: unknown;
  for (const parser of order) {
    try {
      const file = jscodeshift.withParser(parser)(src).get().node as AstNode;
      return (file.program ?? file) as AstNode;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function resolveFile(base: string): string | null {
  const candidates = [base];
  // NodeNext-style `./auth.js` pointing at `auth.ts`.
  const jsExt = /\.(m|c)?jsx?$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* unreadable — try the next */
    }
  }
  return null;
}

function readTsconfig(file: string): { baseUrl: string; paths: Record<string, string[]> } | null {
  try {
    const json = JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) as {
      extends?: string;
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const dir = dirname(file);
    const paths = json.compilerOptions?.paths;
    if (!paths) {
      if (typeof json.extends === 'string' && json.extends.startsWith('.')) {
        const parentFile = resolve(dir, json.extends.endsWith('.json') ? json.extends : `${json.extends}.json`);
        return existsSync(parentFile) ? readTsconfig(parentFile) : null;
      }
      return null;
    }
    // Without a baseUrl, `paths` resolve from the tsconfig's own directory.
    return { baseUrl: resolve(dir, json.compilerOptions?.baseUrl ?? '.'), paths };
  } catch {
    return null;
  }
}

/** Remove // and /* *\/ comments and trailing commas from tsconfig JSON, leaving strings intact. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Read the root package.json's dependency map (empty when there is none). */
function readDependencies(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  } catch {
    return {};
  }
}

export interface AnalyzeOptions {
  /** Only look in this file (relative to the root or absolute) for the `betterAuth()` call. */
  entry?: string;
}

/**
 * Analyse the Better Auth setup under `root` (a directory or a single file).
 * Never executes project code and never reads `.env` files.
 */
export function analyzeBetterAuth(rootPath: string, opts: AnalyzeOptions = {}): BetterAuthAnalysis {
  const rootAbs = resolve(rootPath);
  const rootIsFile = existsSync(rootAbs) && statSync(rootAbs).isFile();
  const root = rootIsFile ? dirname(rootAbs) : rootAbs;
  const analyzer = new Analyzer(root);
  const files = opts.entry
    ? [isAbsolute(opts.entry) ? opts.entry : resolve(root, opts.entry)]
    : rootIsFile
      ? [rootAbs]
      : collectSourceFiles(root);

  const instances: BetterAuthInstance[] = [];
  for (const abs of files) {
    // Cheap pre-filter: only parse files that mention the call.
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('betterAuth')) continue;
    const parsed = analyzer.parse(abs);
    if (!parsed) continue;
    instances.push(...analyzer.findInstances(parsed));
  }
  instances.sort((a, b) => (a.loc.file === b.loc.file ? a.loc.line - b.loc.line : a.loc.file < b.loc.file ? -1 : 1));
  return {
    root,
    filesScanned: files.length,
    instances,
    dependencies: readDependencies(root),
    parseErrors: analyzer.parseErrors,
  };
}

// ───────────────────────────── helpers for consumers ─────────────────────────────

/** A literal JS value for a static value, or `undefined` when it is not a plain literal. */
export function literalOf(v: StaticValue | undefined): unknown {
  if (!v) return undefined;
  switch (v.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'array': {
      const items = v.items.map(literalOf);
      return items.some((i) => i === undefined) ? undefined : items;
    }
    case 'object': {
      if (v.unresolvedSpreads.length) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(v.props)) {
        const lit = literalOf(p);
        if (lit === undefined && p.kind !== 'undefined') return undefined;
        if (lit !== undefined) out[k] = lit;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** A property of an object value (undefined when absent or when `v` is not an object). */
export function propOf(v: StaticValue | undefined, key: string): StaticValue | undefined {
  if (!v || v.kind !== 'object') return undefined;
  const hit = v.props[key];
  return hit && hit.kind !== 'undefined' ? hit : undefined;
}

// ───────────────────────────── generic call analysis ─────────────────────────────

/** Which calls to collect: a package callee (`import X from 'pkg'` or `require('pkg')`). */
export interface CallMatcher {
  /** Returned on each match. */
  id: string;
  /** The package the callee comes from. */
  module: RegExp;
  /** Imported names (`default` for a default import); `*` for any export. */
  names: readonly string[] | '*';
  /** `new X()` only (true), plain calls only (false), or both. */
  construct?: boolean;
}

export interface FoundCall {
  matcher: string;
  /** The callee as written. */
  callee: string;
  imported: { module: string; name: string };
  loc: SourceLoc;
  /** Every argument, evaluated statically. */
  args: StaticValue[];
}

export interface CallAnalysis {
  root: string;
  filesScanned: number;
  calls: FoundCall[];
  dependencies: Record<string, string>;
  parseErrors: Array<{ file: string; message: string }>;
}

/**
 * Find every call to a package API the matchers name under `root` (a directory
 * or one file) and evaluate its arguments statically — the same evaluator
 * {@link analyzeBetterAuth} uses, so env vars resolve by name, identifiers are
 * followed across files, and nothing is executed. `hints`: only files whose
 * text contains one of these are parsed.
 */
export function analyzeCalls(rootPath: string, matchers: readonly CallMatcher[], hints: readonly string[]): CallAnalysis {
  const rootAbs = resolve(rootPath);
  const rootIsFile = existsSync(rootAbs) && statSync(rootAbs).isFile();
  const root = rootIsFile ? dirname(rootAbs) : rootAbs;
  const analyzer = new Analyzer(root);
  const files = rootIsFile ? [rootAbs] : collectSourceFiles(root);
  const calls: FoundCall[] = [];
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!hints.some((h) => text.includes(h))) continue;
    const parsed = analyzer.parse(abs);
    if (!parsed) continue;
    calls.push(...analyzer.findCalls(parsed, matchers));
  }
  calls.sort((a, b) => (a.loc.file === b.loc.file ? a.loc.line - b.loc.line : a.loc.file < b.loc.file ? -1 : 1));
  return { root, filesScanned: files.length, calls, dependencies: readDependencies(root), parseErrors: analyzer.parseErrors };
}
