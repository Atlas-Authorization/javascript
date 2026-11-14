#!/usr/bin/env node
/**
 * node dist/parity-bin.js
 *   ATLAS_OPENAPI          path or URL of the OpenAPI document the emulator is built from (required unless EMULATOR_URL is set)
 *   EMULATOR_URL           an emulator that is already running (else one starts in-process)
 *   EMULATOR_SECRET_KEY    its secret key (default sk_test_emulator)
 *   PARITY_BASE_URL        the real Atlas Backend API to compare against (a development instance)
 *   PARITY_SECRET_KEY      its secret key
 *   PARITY_GROUPS          comma list of feature groups to run (oauth,scim,agents,passkeys,device,round2); default all
 * Exit code 1 when any request differs. Run it on CI, never against production data.
 */
import { runParity } from './parity';
import { fullParityRequests } from './parity-routes';
import { startEmulatorServer } from './server';

async function main(): Promise<void> {
  const refUrl = process.env.PARITY_BASE_URL;
  const refKey = process.env.PARITY_SECRET_KEY;
  if (!refUrl || !refKey) {
    console.error('Set PARITY_BASE_URL and PARITY_SECRET_KEY to the instance to compare against.');
    process.exit(2);
  }
  let url = process.env.EMULATOR_URL;
  let close: (() => Promise<void>) | undefined;
  const key = process.env.EMULATOR_SECRET_KEY ?? 'sk_test_emulator';
  if (!url) {
    if (!process.env.ATLAS_OPENAPI) {
      console.error('Set ATLAS_OPENAPI (path or URL) or EMULATOR_URL.');
      process.exit(2);
    }
    const s = await startEmulatorServer({ openapi: process.env.ATLAS_OPENAPI, secretKeys: key });
    url = s.url;
    close = s.close;
  }
  const results = await runParity({ requests: fullParityRequests, groups: process.env.PARITY_GROUPS?.split(',').filter(Boolean), emulator: { baseUrl: url, secretKey: key }, reference: { baseUrl: refUrl, secretKey: refKey } });
  await close?.();
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'DIFF'} ${r.id} (${r.status.emulator}/${r.status.reference})`);
    for (const d of r.diffs) console.log(`       ${d}`);
    if (!r.ok) bad++;
  }
  console.log(`\n${results.length - bad}/${results.length} match.`);
  process.exit(bad ? 1 : 0);
}

void main();
