#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startEmulator } from './server';

const { values } = parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' }, seed: { type: 'string' }, app: { type: 'string' } } });
async function main(): Promise<void> {
  const emulator = await startEmulator({
    port: values.port ? Number(values.port) : 4400,
    host: values.host,
    app: values.app,
    seed: values.seed ? JSON.parse(readFileSync(values.seed, 'utf8')) : undefined,
  });
  console.log(`Atlas emulator on ${emulator.url}  (mail catcher: ${emulator.url}/__emulator/mail)`);
  process.once('SIGINT', () => void emulator.close().then(() => process.exit(0)));
  process.once('SIGTERM', () => void emulator.close().then(() => process.exit(0)));
}

void main();
