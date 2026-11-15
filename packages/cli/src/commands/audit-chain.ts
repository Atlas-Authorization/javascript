import { verifyAuditChain, type AuditChainCheckpoint, type AuditChainLink, type AuditChainProblem } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';
import type { Handler } from './resources';

interface ChainStatus {
  enabled: boolean;
  genesis_hash: string;
  head_seq: number | null;
  head_hash: string | null;
  jwks_uri: string;
  unchained_rows: number;
}
interface LinksPage {
  data: AuditChainLink[];
  has_more: boolean;
  next_after_seq: number;
}
interface CheckpointsPage {
  data: AuditChainCheckpoint[];
  has_more: boolean;
}

const PROBLEM_TEXT: Record<AuditChainProblem['kind'], string> = {
  row_modified: 'an audit row was changed after it was chained',
  link_mismatch: 'a link hash does not match its row and the link before it',
  gap: 'a link is missing from the sequence',
  wrong_start: 'the sequence does not start where expected',
  checkpoint_mismatch: 'a signed checkpoint names a different head than the chain has',
  checkpoint_signature: 'a checkpoint signature is not valid',
  checkpoint_unverifiable: 'a checkpoint was signed by a key that is no longer published (only its head was compared)',
};

/**
 * `atlas audit verify [--after <seq>] [--jwks-url <url>] [--json]`: check the tamper-evident audit chain on this
 * machine. It downloads the chain's links with the audit rows they cover, recomputes every row hash and link hash,
 * and checks each signed checkpoint against the instance's published keys. Nothing is taken on Atlas's word: the
 * hashes are recomputed here. Exit 0 when the chain is intact, 1 when anything does not match.
 *
 * Every other `atlas audit` subcommand is the retention and chain settings (see `atlas audit --help`).
 */
export function auditCommand(fallback: Handler): Handler {
  return async (ctx, args) => {
    if (args.positionals[1] === 'verify') return verifyCommand(ctx, args);
    return fallback(ctx, args);
  };
}

async function verifyCommand(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const json = wantsJson(v);
  const auth = resolveAuth(ctx, v);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  const doFetch = ctx.fetch ?? fetch;

  const status = await http.get<ChainStatus>('/v1/audit/chain');
  if (!status.enabled) throw new CliError('The audit chain is not on for this instance. Turn it on with: atlas audit chain-enable');
  const rawAfter = str(v, 'after');
  const after = rawAfter === undefined ? 0 : Number(rawAfter);
  if (!Number.isInteger(after) || after < 0) throw new CliError(`--after must be a non-negative integer, got '${rawAfter}'.`);

  // Where the chain starts: its genesis, or the link just before --after (trusted as given; verify from 0 for a full check).
  let prev = status.genesis_hash;
  if (after > 0) {
    const anchor = await http.get<LinksPage>(`/v1/audit/chain/links?after_seq=${after - 1}&limit=1`);
    const link = anchor.data[0];
    if (!link || link.seq !== after) throw new CliError(`There is no link ${after} to start after.`);
    prev = link.link_hash;
  }

  // The keys that sign checkpoints, from the published key set (never from the Atlas API under test).
  const jwksUrl = str(v, 'jwks-url') ?? status.jwks_uri;
  let jwks: { keys: never[] } | undefined;
  try {
    const res = await doFetch(jwksUrl);
    if (res.ok) jwks = (await res.json()) as { keys: never[] };
  } catch {
    // Without keys the head of each checkpoint is still compared; the report says signatures were not checked.
  }

  const checkpoints: AuditChainCheckpoint[] = [];
  for (let cursor = 0; ; ) {
    const page = await http.get<CheckpointsPage>(`/v1/audit/chain/checkpoints?after_seq=${cursor}&limit=500`);
    checkpoints.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    cursor = page.data[page.data.length - 1]!.seq;
  }

  let checked = 0;
  let pruned = 0;
  let verifiedCheckpoints = 0;
  let lastSeq = after;
  const problems: AuditChainProblem[] = [];
  for (let cursor = after; ; ) {
    const page = await http.get<LinksPage>(`/v1/audit/chain/links?after_seq=${cursor}&limit=1000`);
    if (page.data.length === 0) break;
    const result = await verifyAuditChain({ links: page.data, prevLinkHash: prev, fromSeq: cursor + 1, checkpoints, jwks });
    checked += result.checked;
    pruned += result.pruned;
    verifiedCheckpoints += result.checkpointsVerified;
    problems.push(...result.problems);
    // A broken chain cannot be continued: the links after the break prove nothing.
    if (result.problems.some((p) => p.kind !== 'checkpoint_unverifiable')) break;
    prev = result.lastLinkHash;
    cursor = result.lastSeq;
    lastSeq = cursor;
    if (!page.has_more) break;
  }
  const breaking = problems.filter((p) => p.kind !== 'checkpoint_unverifiable');
  const ok = breaking.length === 0;

  if (json) {
    printJson(ctx.io, { ok, checked, pruned, last_seq: lastSeq, checkpoints_verified: verifiedCheckpoints, signatures_checked: Boolean(jwks), problems });
  } else if (ok) {
    ctx.io.out(`Audit chain intact: ${checked} link${checked === 1 ? '' : 's'} verified up to #${lastSeq}${pruned ? ` (${pruned} audit row${pruned === 1 ? '' : 's'} removed by retention; their links still chain)` : ''}.`);
    ctx.io.out(jwks ? `${verifiedCheckpoints} signed checkpoint${verifiedCheckpoints === 1 ? '' : 's'} verified against ${jwksUrl}.` : `Checkpoint signatures were NOT checked: could not read ${jwksUrl} (pass --jwks-url).`);
    for (const p of problems) ctx.io.out(`Note: checkpoint #${p.seq}: ${PROBLEM_TEXT[p.kind]}.`);
  } else {
    ctx.io.out(`AUDIT CHAIN DOES NOT VERIFY after ${checked} good link${checked === 1 ? '' : 's'}:`);
    for (const p of problems) ctx.io.out(`  #${p.seq}: ${PROBLEM_TEXT[p.kind]}.`);
  }
  return ok ? 0 : 1;
}
