#!/usr/bin/env node
import { defaultContext } from './context';
import { run } from './run';

/**
 * The bin entry — the ONLY place that touches `process` for lifecycle. It wires
 * the production context, runs, and exits with the returned code. `run` is
 * designed to catch its own errors, so the `.catch` here is a last-resort guard
 * against a genuine bug; even then it prints a line, never a raw stack.
 */
run(process.argv.slice(2), defaultContext())
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`atlas: unexpected error: ${message}\n`);
    process.exit(1);
  });
