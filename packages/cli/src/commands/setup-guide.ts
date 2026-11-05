import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { printJson } from '../output';
import { wantsJson } from './shared';

/**
 * `atlas setup-guide`: the exact order of setup calls with the read-back that
 * proves each worked, for a person or a coding agent. A 2xx alone proves little on
 * a lenient instance, so every step names what to read.
 */
const DOCS_URL = 'https://atlasauth.net/docs/agent-setup';

const STEPS: Array<{ step: string; run: string; read_back: string }> = [
  { step: 'Create the instance and its key files', run: 'atlas init --product <name> --with-dev --yes', read_back: 'atlas env --product <name>: the publishable key and issuer are set' },
  { step: 'Write the app files (Next.js)', run: 'atlas init --next --mount /atlas', read_back: 'atlas.yaml, the two route files and .env.example exist' },
  { step: 'Set the runtime variables', run: 'See .env.example: only the publishable key is a build arg', read_back: 'atlas doctor --scan-dir . exits 0' },
  { step: 'Apply the config', run: 'atlas apply atlas.yaml --secrets-file <0600 file> --yes', read_back: 'atlas plan atlas.yaml --check --secrets-file <0600 file> exits 0' },
  { step: 'Claim the path mount', run: 'POST /v1/domains {"method":"path","hostname":"<app host>","base_path":"/atlas"}', read_back: 'GET /v1/domains: the domain is listed, with its verification token in instructions' },
  { step: 'Mint the proxy secret', run: 'POST /v1/instance/proxy_secret, then set ATLAS_PROXY_SECRET, ATLAS_UPSTREAM and ATLAS_VERIFY_TOKEN at runtime and deploy', read_back: 'GET /v1/domains: instructions.proxy_secret_set is true' },
  { step: 'See what the issuer will do', run: 'POST /v1/domains/{id}/verify?dry_run=true', read_back: 'issuer_before and issuer_after in the answer. Add issuer_before to previousIssuers in your verifiers and deploy' },
  { step: 'Go live', run: 'atlas golive --origin https://<app host> --yes', read_back: 'Every step prints a check mark; atlas golive --origin https://<app host> --dry-run --json says ok: true' },
  { step: 'Import users', run: 'atlas import users.jsonl --dry-run --password-policy until_email_verified, then the same without --dry-run', read_back: 'The same command again reports created: 0 and updated: 0' },
  { step: 'Check the result', run: 'atlas preflight --fix', read_back: 'atlas preflight exits 0; atlas doctor --origin https://<app host> exits 0' },
];

export async function setupGuide(ctx: RunContext, args: ParsedArgs): Promise<number> {
  if (wantsJson(args.values)) {
    printJson(ctx.io, { docs: DOCS_URL, steps: STEPS });
    return 0;
  }
  ctx.io.out(`Atlas setup, in order. Full guide: ${DOCS_URL}`);
  STEPS.forEach((s, i) => {
    ctx.io.out('');
    ctx.io.out(`${i + 1}. ${s.step}`);
    ctx.io.out(`   run:       ${s.run}`);
    ctx.io.out(`   read back: ${s.read_back}`);
  });
  return 0;
}
