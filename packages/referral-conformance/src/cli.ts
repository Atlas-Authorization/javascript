#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatReport, runConformance } from './runner';

/** `referral-conformance --base-url <url> --connection-id <id> --secret-file <path|-> [--only auth.,signup.] [--json]` */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const USAGE =
  'usage: referral-conformance [--protocol connection|webhook] --base-url <url> --connection-id <id> --secret-file <path|-> [--only <ids|areas,…>] [--json]\n' +
  '       (or set REFERRAL_CONFORMANCE_SECRET instead of --secret-file)\n' +
  '       referral-conformance --help | --version\n' +
  'exit code: 0 all cases passed, 1 a case failed, 2 bad usage\n';

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (process.argv.includes('--version')) {
    process.stdout.write(`${(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version}\n`);
    return 0;
  }
  const baseUrl = arg('base-url');
  const profile = arg('protocol') === 'webhook' ? 'webhook' : 'connection';
  const connectionId = arg('connection-id') ?? (profile === 'webhook' ? 'n/a' : undefined);
  const secretFile = arg('secret-file') ?? (process.env.REFERRAL_CONFORMANCE_SECRET ? '' : undefined);
  if (!baseUrl || !connectionId || secretFile === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const secret = (secretFile ? readFileSync(secretFile === '-' ? 0 : secretFile, 'utf8') : (process.env.REFERRAL_CONFORMANCE_SECRET ?? '')).trim();
  if (!secret) {
    process.stderr.write('The connection secret is empty.\n');
    return 2;
  }
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const report = await runConformance({ baseUrl, connectionId, secret, profile, ...(only ? { only } : {}) });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else for (const line of formatReport(report)) process.stdout.write(`${line}\n`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
