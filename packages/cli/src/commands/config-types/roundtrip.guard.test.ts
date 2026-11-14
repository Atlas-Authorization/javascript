import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNotFound, type ConfigHttp } from '../../config-http';
import { allConfigSpecs, type CollectionSpec, type SingletonSpec } from '../config';

/**
 * Guard 7 (round-trip half): for every registered atlas.yaml type, what `apply` writes is what
 * `export` (fetchLive) reads back, and applying it again changes nothing:
 *
 *   collection  create(sample) -> fetchLive has one entry carrying every non-secret key of the sample
 *               -> update(sample) leaves the live state exactly as it was (idempotent)
 *               -> writeOnly / sealed keys never appear on the live side (secrets never reach git)
 *   singleton   apply(sample) -> fetchLive has every sample key
 *
 * The server is an in-memory fake that stores exactly what it is sent, so a failure here is the
 * type's own plumbing (a key export drops, an update that rewrites, a secret that leaks), not an
 * API difference. Types the generic sample cannot drive are listed in
 * scripts/guards/allowlists/config-roundtrip.json (section `skip`) with the reason.
 * Re-baseline with UPDATE_GUARD_ALLOWLISTS=1.
 */
const ALLOW = join(__dirname, '../../../../../scripts/guards/allowlists/config-roundtrip.json');
const allow = (): { skip: Record<string, string> } => (existsSync(ALLOW) ? JSON.parse(readFileSync(ALLOW, 'utf8')) : { skip: {} });

/** Stores bodies by path; a collection path holds rows, an item path addresses a row by id, anything else is a document. */
class FakeHttp implements ConfigHttp {
  rows = new Map<string, Record<string, unknown>[]>();
  docs = new Map<string, unknown>();
  private n = 0;
  private split(path: string): { base: string; id?: string } {
    const clean = path.replace(/\?.*$/, '');
    const i = clean.lastIndexOf('/');
    const base = clean.slice(0, i);
    const id = decodeURIComponent(clean.slice(i + 1));
    return this.rows.has(base) || [...this.rows.values()].some((r) => r.some((x) => x.id === id)) ? { base, id } : { base: clean };
  }
  async get<T>(path: string): Promise<T> {
    const clean = path.replace(/\?.*$/, '');
    if (this.rows.has(clean)) return { object: 'list', data: this.rows.get(clean), has_more: false } as T;
    const { base, id } = this.split(clean);
    if (id !== undefined) {
      const row = this.rows.get(base)?.find((r) => r.id === id || r.name === id || r.key === id || r.slug === id);
      if (row) return row as T;
    }
    if (this.docs.has(clean)) return this.docs.get(clean) as T;
    // an empty collection answers an empty list; an unset document is a 404
    return { object: 'list', data: [], has_more: false } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    const rows = this.rows.get(path) ?? [];
    const row = { id: `rt_${(this.n += 1)}`, ...(body as object) } as Record<string, unknown>;
    this.rows.set(path, [...rows, row]);
    // a POST to a document path (an action) also leaves the document readable
    this.docs.set(path, body);
    return row as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.write(path, body);
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.write(path, body);
  }
  private write<T>(path: string, body: unknown): T {
    const { base, id } = this.split(path);
    if (id !== undefined && this.rows.has(base)) {
      this.rows.set(
        base,
        this.rows.get(base)!.map((r) => (r.id === id || r.name === id ? { ...r, ...(body as object) } : r)),
      );
      return body as T;
    }
    this.docs.set(path, { ...((this.docs.get(path) as object) ?? {}), ...(body as object) });
    return body as T;
  }
  async delete(path: string): Promise<void> {
    const { base, id } = this.split(path);
    if (id !== undefined && this.rows.has(base)) this.rows.set(base, this.rows.get(base)!.filter((r) => r.id !== id && r.name !== id));
    else this.docs.delete(path);
  }
}

const sampleFor = (keys: readonly string[], secret: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, secret.has(k) ? '${RT_SECRET}' : `rt_${k}`]));

const specs = allConfigSpecs();

describe('guard 7: atlas.yaml round trip', () => {
  it('the registry is not empty (the guard must not pass vacuously)', () => {
    expect(specs.length).toBeGreaterThan(50);
  });

  const failures: string[] = [];
  for (const spec of specs) {
    it(`${spec.type}: export reads back what apply wrote`, async () => {
      if (allow().skip[spec.type] && process.env.UPDATE_GUARD_ALLOWLISTS !== '1') return;
      try {
        await roundTrip(spec);
      } catch (e) {
        if (process.env.UPDATE_GUARD_ALLOWLISTS === '1') {
          failures.push(spec.type);
          return;
        }
        throw e;
      }
    });
  }

  it.runIf(process.env.UPDATE_GUARD_ALLOWLISTS === '1')('writes the skip baseline', () => {
    const next: Record<string, string> = {};
    const prev = allow().skip;
    for (const t of failures) next[t] = prev[t] ?? 'TRIAGE: the generic sample cannot drive this type through the in-memory fake; add a curated sample or a written reason';
    writeFileSync(ALLOW, `${JSON.stringify({ skip: next }, null, 2)}\n`);
  });
});

async function roundTrip(spec: CollectionSpec | SingletonSpec): Promise<void> {
  const http = new FakeHttp();
  if (spec.kind === 'collection') {
    const hidden = new Set<string>([...(spec.writeOnly ?? [])]);
    const sample = sampleFor(spec.fileKeys, hidden);
    await spec.create(http, sample as never);
    const first = await spec.fetchLive(http);
    expect(first, `${spec.type}: create then fetchLive must yield exactly one entry`).toHaveLength(1);
    const live = first[0]!;
    const liveCfg = (live.config ?? {}) as Record<string, unknown>;
    for (const k of spec.fileKeys) {
      if (hidden.has(k)) {
        expect(JSON.stringify(liveCfg), `${spec.type}: write-only key ${k} leaked into the exported config`).not.toContain('"${RT_SECRET}"');
        continue;
      }
      if (spec.defaulted?.includes(k)) continue;
      expect(liveCfg[k], `${spec.type}: key ${k} was written but export did not read it back`).toBeDefined();
    }
    if (spec.update) {
      await spec.update(http, live as never, sample as never);
      const second = await spec.fetchLive(http);
      expect(second.map((e) => e.config), `${spec.type}: applying the same config again changed the live state`).toEqual(first.map((e) => e.config));
    }
    return;
  }
  const keys = spec.fileKeys ?? [];
  if (keys.length === 0) return; // a document the server validates itself: no file keys to compare
  const sample = sampleFor(keys, new Set());
  await spec.apply(http, sample as never, { forceHook: false });
  const live = await spec.fetchLive(http).catch((e) => {
    if (isNotFound(e)) return null;
    throw e;
  });
  expect(live, `${spec.type}: apply then fetchLive must return the document`).not.toBeNull();
  for (const k of keys) {
    expect((live as Record<string, unknown>)[k], `${spec.type}: key ${k} was written but export did not read it back`).toBeDefined();
  }
}
