import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalPdp } from './pdp';
import { DecisionShipper, PdpSync } from './sync';
import { createSidecar } from './sidecar';

const HELP = `atlas-pdp — a local Atlas policy decision point

Environment:
  ATLAS_API_URL        Atlas Backend API origin (required)
  ATLAS_API_KEY        secret key: policy_bundles:read, fga:read, authz_decisions:write (required)
  ATLAS_JWKS_FILE      pin the bundle signing keys from a JWKS file (recommended; default: fetch once, trust on first use)
  ATLAS_PDP_TOKEN      require this bearer token on every request
  ATLAS_PDP_ID         stable id shown in the fleet list (default: random)
  ATLAS_PDP_SYNC_MS    sync interval (default 15000)
  ATLAS_PDP_SHIP       "0" to stop shipping decisions to Atlas
  PORT                 listen port (default 8181)
  HOST                 listen address (default 127.0.0.1)
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) return void console.log(HELP);
  const baseUrl = process.env.ATLAS_API_URL;
  const apiKey = process.env.ATLAS_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error(HELP);
    process.exit(2);
  }
  const jwks = process.env.ATLAS_JWKS_FILE ? (JSON.parse(readFileSync(process.env.ATLAS_JWKS_FILE, 'utf8')) as { keys: Array<Record<string, unknown>> }) : undefined;
  const pdp = new LocalPdp();
  const log = (msg: string, extra?: unknown) => console.error(JSON.stringify({ msg, ...(extra ? { extra } : {}) }));
  const sync = new PdpSync({ pdp, baseUrl, apiKey, jwks, intervalMs: Number(process.env.ATLAS_PDP_SYNC_MS) || 15_000, onError: (e) => log('sync failed', String(e)) });
  // Fail closed: do not listen until the first bundle verified and loaded.
  await sync.syncOnce();
  log('bundle loaded', { revision: pdp.revision });
  sync.start();
  let shipper: DecisionShipper | undefined;
  if (process.env.ATLAS_PDP_SHIP !== '0') {
    shipper = new DecisionShipper({ baseUrl, apiKey, pdp: { id: process.env.ATLAS_PDP_ID ?? randomUUID(), name: process.env.ATLAS_PDP_NAME, version: '0.1.0' }, revision: () => pdp.revision, onError: (e) => log('ship failed', String(e)) });
    pdp.onDecision = shipper.push;
    shipper.start();
  }
  const server = createSidecar({ pdp, token: process.env.ATLAS_PDP_TOKEN });
  const port = Number(process.env.PORT) || 8181;
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => log('listening', { port }));
  const stop = async () => {
    sync.stop();
    await shipper?.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
