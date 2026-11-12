import { describe, expect, it } from 'vitest';
import { parse } from '../args';
import { MemoryConfigStore } from '../config';
import type { RunContext } from '../context';
import { captureIO } from '../io';
import { runSuite, type SuiteExec } from './suite';

const SUITE = `steps:
  - name: billing
    cwd: ./b
    plan: billing plan
    apply: billing apply
    depends_on: [atlas]
    env: { TARGET: prod }
  - name: atlas
    plan: atlas plan --check
    apply: atlas apply
`;
const go = async (argv: string[], text: string, codes: Record<string, number> = {}) => {
  const io = captureIO();
  const ran: Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const exec: SuiteExec = (command, o) => { ran.push({ command, ...o }); return { code: codes[command] ?? 0, output: `out of ${command}\n` }; };
  const ctx = { io, env: { BASE: '1' }, config: new MemoryConfigStore({ active_profile: 'd', profiles: {} }), readFile: () => text } as unknown as RunContext;
  const code = await runSuite(ctx, parse(['suite', ...argv, '/w/suite.yaml']), exec);
  return { code, io, ran };
};

describe('atlas suite', () => {
  it('plans in dependency order with headers, cwd and env; exits 2 on drift', async () => {
    const r = await go(['plan'], SUITE, { 'atlas plan --check': 2 });
    expect(r.ran.map((x) => x.command)).toEqual(['atlas plan --check', 'billing plan']);
    expect(r.ran[1]!.cwd).toBe('/w/b');
    expect(r.ran[1]!.env).toMatchObject({ BASE: '1', TARGET: 'prod' });
    expect(r.io.stdout()).toContain('== atlas');
    expect(r.code).toBe(2);
  });
  it('plan exits 1 when a step fails, 0 when clean', async () => {
    expect((await go(['plan'], SUITE, { 'billing plan': 1 })).code).toBe(1);
    expect((await go(['plan'], SUITE)).code).toBe(0);
  });
  it('apply stops at the first failure and reports the rest skipped (--json)', async () => {
    const r = await go(['apply', '--json'], SUITE, { 'atlas apply': 1 });
    expect(r.ran.map((x) => x.command)).toEqual(['atlas apply']);
    expect(JSON.parse(r.io.stdout()).steps).toEqual([
      { name: 'atlas', status: 'failed', exit_code: 1 },
      { name: 'billing', status: 'skipped', exit_code: null },
    ]);
    expect(r.code).toBe(1);
  });
  it('--only runs a step with its dependencies', async () => {
    expect((await go(['plan', '--only', 'atlas'], SUITE)).ran).toHaveLength(1);
    expect((await go(['plan', '--only', 'billing'], SUITE)).ran).toHaveLength(2);
  });
  it('rejects duplicates, unknown depends_on and cycles', async () => {
    await expect(go(['plan'], 'steps:\n  - { name: a }\n  - { name: a }\n')).rejects.toThrow(/duplicate/);
    await expect(go(['plan'], 'steps:\n  - { name: a, depends_on: [z] }\n')).rejects.toThrow(/unknown step "z"/);
    await expect(go(['plan'], 'steps:\n  - { name: a, depends_on: [b] }\n  - { name: b, depends_on: [a] }\n')).rejects.toThrow(/cycle/);
  });
});
