import { resolve } from 'node:path';
import { CANONICAL_MODEL_ORDER, isCanonicalModel, type CanonicalModel, type CanonicalRecordData } from '@atlasauth/migrate';
import { str } from '../../args';
import { CliError } from '../../errors';
import type { MigrationPlugin } from './plugin';

/**
 * `atlas migrate custom export --file <records>` — your own user store through
 * the same pipeline as every vendor. The file holds canonical records (the
 * `@atlasauth/migrate` schema v1), as NDJSON (one `{ "model": …, "data": … }`
 * per line) or a JSON array of them; `{ "type": "record", … }` entries from a
 * decrypted bundle are accepted too. Records are written in canonical model
 * order whatever order the file has them in; an invalid record is left out and
 * reported, never fatal.
 *
 * The file is read on this machine; only the sealed bundle goes to Atlas.
 */

/** Records between two export checkpoints. */
const CHECKPOINT_EVERY = 1000;

export interface CanonicalFileRecord {
  model: CanonicalModel;
  data: Record<string, unknown>;
}

/** Parse NDJSON or a JSON array of `{ model, data }`. Unknown models are returned in `unknown`. */
export function parseCanonicalRecords(text: string): { records: CanonicalFileRecord[]; unknown: Record<string, number> } {
  const trimmed = text.trim();
  let raw: unknown[];
  if (!trimmed) raw = [];
  else if (trimmed.startsWith('[')) {
    try {
      raw = JSON.parse(trimmed) as unknown[];
    } catch {
      throw new CliError('The records file is not valid JSON.');
    }
    if (!Array.isArray(raw)) throw new CliError('The records file must be a JSON array or NDJSON.');
  } else {
    raw = trimmed.split('\n').filter((l) => l.trim()).map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new CliError(`Line ${i + 1} of the records file is not valid JSON.`);
      }
    });
  }
  const records: CanonicalFileRecord[] = [];
  const unknown: Record<string, number> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { type?: unknown; model?: unknown; data?: unknown };
    if (e.type !== undefined && e.type !== 'record') continue; // manifest / end lines of a decrypted bundle
    const model = String(e.model ?? '');
    if (!isCanonicalModel(model) || !e.data || typeof e.data !== 'object') {
      unknown[model || '(none)'] = (unknown[model || '(none)'] ?? 0) + 1;
      continue;
    }
    records.push({ model, data: e.data as Record<string, unknown> });
  }
  const rank = (m: string) => (CANONICAL_MODEL_ORDER as readonly string[]).indexOf(m);
  // Stable: records of one model keep the file's order.
  records.sort((a, b) => rank(a.model) - rank(b.model));
  return { records, unknown };
}

export const customPlugin: MigrationPlugin = {
  vendor: 'custom',
  source: 'custom',
  label: 'Your own user database',
  help: 'Import a homegrown user store: write its users, identities, organizations and so on as canonical migration records (NDJSON or a JSON array of { model, data }), then run atlas migrate custom export --file <records> and atlas migrate custom import.',
  export: {
    reads: 'a local file of canonical migration records (--file)',
    credentials: [],
    async run(p, writer, resume) {
      const file = str(p.args.values, 'file') ?? p.credential({ flag: 'file', env: 'ATLAS_MIGRATE_FILE', label: 'the records file (--file)', required: true });
      const { records, unknown } = parseCanonicalRecords(p.ctx.readFile(resolve(file!)));
      for (const [model, n] of Object.entries(unknown)) writer.omit(model, 'not a canonical model (or no data)', n);
      const start = typeof resume.cursor === 'number' ? resume.cursor : 0;
      if (start) p.say(`  resuming at record ${start + 1} of ${records.length}`);
      for (let i = start; i < records.length; i++) {
        const r = records[i]!;
        const issues = await writer.add(r.model, r.data as unknown as CanonicalRecordData[typeof r.model]);
        if (issues.length) p.say(`  left out ${r.model} #${i + 1}: ${issues[0]!.message}`);
        if ((i + 1) % CHECKPOINT_EVERY === 0) resume.checkpoint(i + 1);
      }
      p.say(`  read ${records.length} record(s) from ${file}`);
    },
  },
};
