import { describe, expect, it } from 'vitest';
type Mark = (src: string) => { out: string; n: number; already: boolean };
const script = './mark-optional-requires.mjs';
const { markOptionalRequires } = (await import(script)) as { markOptionalRequires: Mark };

describe('markOptionalRequires', () => {
  it('puts the ignore comment on the require tsc emits for an ignored dynamic import, once', () => {
    const emitted = '                return (await Promise.resolve(`${spec}`).then(s => __importStar(require(s))));';
    const { out, n } = markOptionalRequires(emitted);
    expect(n).toBe(1);
    expect(out).toContain('require(/* webpackIgnore: true */ /* turbopackIgnore: true */ s)');
    expect(markOptionalRequires(out).n).toBe(0);
    expect(markOptionalRequires('const x = require("y");').n).toBe(0);
  });
});
