import { createHash } from 'node:crypto';
import {
  CANONICAL_MODEL_ORDER,
  MIGRATION_BUNDLE_FORMAT,
  MIGRATION_BUNDLE_VERSION,
  validateRecord,
  type CanonicalModel,
  type CanonicalRecordData,
  type MigrationEntry,
  type MigrationManifest,
  type MigrationSource,
  type RecordIssue,
} from './schema';
import { BundleSealer, type ImportPublicKey } from './transport';

/**
 * Writes a sealed migration bundle: the manifest, the records in canonical
 * order, and the end entry with the counts. Every vendor exporter uses it, so
 * every bundle Atlas receives was validated and ordered the same way.
 *
 *   const w = new MigrationBundleWriter({ source: 'auth0', exporter, recipient, write });
 *   await w.add('user', { id: 'auth0|1', emails: [...] });
 *   …
 *   const summary = await w.finish();
 *
 * Records may be added in any order WITHIN a model, but models must come in
 * {@link CANONICAL_MODEL_ORDER}: adding a `user` after a `membership` throws,
 * because the importer resolves references through rows it has already seen.
 * (An exporter that reads models in another order buffers, or writes one
 * temporary file per model and replays them in order.)
 *
 * An invalid record is not written: it is counted under `omitted` with the
 * first problem as the reason, and returned to the caller (`strict: true`
 * throws instead).
 */
export interface MigrationBundleWriterOptions {
  source: MigrationSource;
  exporter: { name: string; version: string };
  recipient: ImportPublicKey;
  write: (line: string) => void | Promise<void>;
  /** Manifest fields beyond the required ones. */
  manifest?: Partial<Omit<MigrationManifest, 'type' | 'format' | 'formatVersion' | 'source' | 'exporter'>>;
  /** Throw on an invalid record instead of omitting it. */
  strict?: boolean;
  chunkBytes?: number;
  now?: () => Date;
}

export interface MigrationBundleSummary {
  counts: Record<string, number>;
  omitted: Record<string, { count: number; reason: string }>;
  chunks: number;
  warnings: string[];
}

export class MigrationBundleWriter {
  private readonly sealer: BundleSealer<MigrationEntry>;
  private readonly counts: Record<string, number> = {};
  private readonly omitted: Record<string, { count: number; reason: string }> = {};
  private readonly warnings: string[];
  private manifestWritten = false;
  private lastModelIndex = -1;
  private finished = false;

  constructor(private options: MigrationBundleWriterOptions) {
    this.sealer = new BundleSealer<MigrationEntry>(options.recipient, options.write, { chunkBytes: options.chunkBytes });
    this.warnings = [...(options.manifest?.warnings ?? [])];
  }

  /** Add a plain-words warning to the manifest (only before the first record). */
  warn(message: string): void {
    if (this.manifestWritten) throw new Error('Warnings go in the manifest: add them before the first record.');
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /**
   * Manifest fields an exporter learned from the vendor (origin, providers,
   * rpId …), merged over the constructor's (only before the first record).
   */
  describe(fields: Partial<Omit<MigrationManifest, 'type' | 'format' | 'formatVersion' | 'source' | 'exporter' | 'warnings'>>): void {
    if (this.manifestWritten) throw new Error('Manifest fields go in before the first record.');
    this.options.manifest = { ...this.options.manifest, ...fields };
  }

  private async writeManifest(): Promise<void> {
    if (this.manifestWritten) return;
    this.manifestWritten = true;
    const now = (this.options.now ?? (() => new Date()))();
    const manifest: MigrationManifest = {
      ...this.options.manifest,
      type: 'manifest',
      format: MIGRATION_BUNDLE_FORMAT,
      formatVersion: MIGRATION_BUNDLE_VERSION,
      source: this.options.source,
      exportedAt: now.toISOString(),
      exporter: this.options.exporter,
      warnings: this.warnings,
    };
    await this.sealer.add(manifest);
  }

  /**
   * Add one record. Returns the problems when it was refused (and omitted),
   * an empty list when it was written.
   */
  async add<M extends CanonicalModel>(model: M, data: CanonicalRecordData[M]): Promise<RecordIssue[]> {
    if (this.finished) throw new Error('The bundle is already finished.');
    const index = (CANONICAL_MODEL_ORDER as readonly string[]).indexOf(model);
    if (index < 0) throw new Error(`Unknown model "${model}".`);
    if (index < this.lastModelIndex) {
      throw new Error(`Model "${model}" must be written before "${CANONICAL_MODEL_ORDER[this.lastModelIndex]}" (canonical order: ${CANONICAL_MODEL_ORDER.join(', ')}).`);
    }
    await this.writeManifest();
    const issues = validateRecord(model, data);
    if (issues.length) {
      if (this.options.strict) throw new Error(`Invalid ${model} record: ${issues.map((i) => i.message).join(' ')}`);
      this.omit(model, `invalid record: ${issues[0]!.message}`);
      return issues;
    }
    this.lastModelIndex = index;
    await this.sealer.add({ type: 'record', model, data } as MigrationEntry);
    this.counts[model] = (this.counts[model] ?? 0) + 1;
    return [];
  }

  /** Count a row the exporter left out on purpose (expired session, deleted user …). The first reason per model is kept. */
  omit(model: string, reason: string, count = 1): void {
    const o = (this.omitted[model] ??= { count: 0, reason });
    o.count += count;
  }

  /** Write the end entry and seal the final chunk. */
  async finish(): Promise<MigrationBundleSummary> {
    if (this.finished) throw new Error('The bundle is already finished.');
    await this.writeManifest();
    this.finished = true;
    await this.sealer.add({ type: 'end', counts: { ...this.counts }, omitted: { ...this.omitted } });
    const chunks = await this.sealer.finish();
    return { counts: { ...this.counts }, omitted: { ...this.omitted }, chunks, warnings: [...this.warnings] };
  }
}

/**
 * sha256 hex of a session token — the `session.token_hash` the bridge looks up.
 * Hash exactly the string the bridge will be handed (see the source's bridge
 * preset: the raw cookie value, a JWT's `jti`, or the source session id).
 */
export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
