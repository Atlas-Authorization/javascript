import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { CollectionSpec } from './commands/config';
import { NATIVE_APP_CONFIG_TYPES } from './commands/config-types/native-apps';

/**
 * Every code block of the React Native / Expo sign-in guide must be real: TypeScript and TSX blocks parse,
 * JSON and YAML blocks parse, the native_apps YAML passes the same validation `atlas config apply` runs, and
 * every name imported from an @atlasauth package exists in that package's source.
 */
const ROOT = join(__dirname, '../../..');
const GUIDE = readFileSync(join(ROOT, 'docs/guides/react-native-sign-in.md'), 'utf8');
const blocks = [...GUIDE.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, code: m[2]! }));

function sourceOf(pkg: string): string {
  const dir = join(ROOT, 'packages', pkg.replace('@atlasauth/', ''), 'src');
  if (!existsSync(dir)) return '';
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}

describe('react-native-sign-in guide code blocks', () => {
  it('has code blocks to check', () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  blocks.forEach(({ lang, code }, i) => {
    if (lang === 'ts' || lang === 'tsx') {
      it(`block ${i + 1} (${lang}) compiles and imports names that exist`, () => {
        const out = ts.transpileModule(code, { reportDiagnostics: true, fileName: lang === 'tsx' ? 'sample.tsx' : 'sample.ts', compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 } });
        expect((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
        for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(@atlasauth\/[^']+)'/g)) {
          const src = sourceOf(m[2]!);
          for (const name of m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!).filter(Boolean)) {
            expect(src, `${m[2]} must export ${name}`).toContain(name);
          }
        }
      });
    } else if (lang === 'json') {
      it(`block ${i + 1} (json) parses`, () => expect(() => JSON.parse(code)).not.toThrow());
    } else if (lang === 'yaml') {
      it(`block ${i + 1} (yaml) parses and every native app is valid`, () => {
        const doc = parseYaml(code) as { native_apps?: unknown[] };
        const spec = NATIVE_APP_CONFIG_TYPES[0] as CollectionSpec;
        for (const app of doc.native_apps ?? []) expect(spec.validate!(app as never)).toEqual([]);
      });
    }
  });

  it('names no integrator and no source path', () => {
    expect(GUIDE).not.toMatch(/apps\/api|packages\/|migration \d{4}|\.ts\b/);
  });
});
