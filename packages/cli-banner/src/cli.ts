#!/usr/bin/env node
/**
 * `atlas-banner` — play or print the Atlas banner.
 *
 *   atlas-banner            animate (or a still, off a TTY)
 *   atlas-banner --static   print the still image and exit
 *   atlas-banner --no-color drop the tint (also respects NO_COLOR)
 *
 * A tiny demo/preview bin so the banner can be seen without wiring it into a
 * host CLI first.
 */

import { parseArgs } from 'node:util';
import { animate, staticBanner } from './banner';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      static: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const colour = !values['no-color'] && !process.env.NO_COLOR;

  if (values.static || !process.stdout.isTTY) {
    process.stdout.write(`${staticBanner(colour)}\n`);
    return;
  }
  await animate();
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
