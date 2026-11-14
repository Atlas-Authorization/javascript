import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_HELP } from '../help';
import { configTypes } from './config';

/** The apply order is written out in `atlas apply --help` and the plan docs; both must match the code. */
function orderIn(text: string): string[] {
  const m = /in a fixed order: ([\s\S]*?)\. (?:Re-running|The email provider)/.exec(text);
  if (!m) throw new Error('no order list found');
  return m[1]!.split(',').map((s) => s.replace(/[`\s]/g, ''));
}

describe('apply order', () => {
  it('apply --help lists every resource type in code order', () => {
    expect(orderIn(COMMAND_HELP.apply!)).toEqual(configTypes());
  });

  it('the plan docs list every resource type in code order, once', () => {
    const doc = readFileSync(join(__dirname, '../../../../docs/guides/config-drift-and-plan.md'), 'utf8');
    expect(doc.match(/in a fixed order:/g)).toHaveLength(1);
    expect(orderIn(doc)).toEqual(configTypes());
  });
});
