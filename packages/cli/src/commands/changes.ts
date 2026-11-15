import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

const TYPES = ['user', 'organization', 'membership', 'invitation', 'role_assignment', 'api_key', 'machine', 'machine_grant'] as const;

interface ChangesPage {
  data: Array<{ seq: number; resource_type: string; resource_id: string; op: string; occurred_at: number }>;
  has_more: boolean;
  next_after: number;
  head_seq: number;
}

function checkTypes(types: string[]): string[] {
  for (const t of types) if (!(TYPES as readonly string[]).includes(t)) throw new CliError(`Unknown resource type '${t}'. One of: ${TYPES.join(', ')}.`);
  return types;
}

/**
 * `atlas changes tail [--types a,b] [--after <seq>] [--once] [--json]`: print the change
 * feed as it grows. Without --after it starts at the current head (only new changes);
 * `--after 0` replays everything still retained. Ctrl-C stops it; --once prints what is
 * there and exits.
 */
export async function changes(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== 'tail' && sub !== 'consumers') throw new CliError(sub ? `Unknown subcommand 'changes ${sub}'. Try: tail, consumers.` : 'changes needs a subcommand: tail, consumers.');
  const v = args.values;
  const json = wantsJson(v);
  if (sub === 'consumers') {
    // Who reads the feed and how far behind each one is.
    const auth = resolveAuth(ctx, v);
    const res = await httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl }).get<{ data?: Array<Record<string, unknown>> }>('/v1/changes/consumers');
    if (json || !Array.isArray(res.data)) printJson(ctx.io, res);
    else for (const c of res.data) ctx.io.out(Object.entries(c).filter(([k]) => k !== 'object').map(([k, x]) => `${k}=${String(x)}`).join('\t'));
    return 0;
  }
  const types = checkTypes(list(v, 'types'));
  const auth = resolveAuth(ctx, v);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  const path = (after: number, limit: number) => `/v1/changes?after=${after}&limit=${limit}${types.length ? `&types=${encodeURIComponent(types.join(','))}` : ''}`;

  let after: number;
  const rawAfter = str(v, 'after');
  if (rawAfter !== undefined) {
    after = Number(rawAfter);
    if (!Number.isInteger(after) || after < 0) throw new CliError(`--after must be a non-negative integer, got '${rawAfter}'.`);
  } else {
    after = (await http.get<ChangesPage>(path(0, 1))).head_seq;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  ctx.signal?.addEventListener('abort', stop);
  const sigs = ctx.signal ? [] : (['SIGINT', 'SIGTERM'] as const);
  for (const s of sigs) process.once(s, stop);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    while (!controller.signal.aborted) {
      const page = await http.get<ChangesPage>(path(after, 200));
      for (const c of page.data) {
        if (json) printJson(ctx.io, c);
        else ctx.io.out(`${c.seq}\t${new Date(c.occurred_at).toISOString()}\t${c.op}\t${c.resource_type}\t${c.resource_id}`);
      }
      after = page.next_after;
      if (page.has_more) continue;
      if (v.once === true) break;
      await sleep(2000);
    }
  } finally {
    ctx.signal?.removeEventListener('abort', stop);
    for (const s of sigs) process.removeListener(s, stop);
  }
  return 0;
}

const table = (t: string) => `atlas_${t}s`;
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^\w/, (c) => c.toUpperCase());

function drizzleInit(types: string[]): string {
  const tables = types
    .map(
      (t) => `export const ${camel(table(t))} = pgTable('${table(t)}', {
  id: text('id').primaryKey(),
  atlasVersion: bigint('atlas_version', { mode: 'number' }),
  deletedAt: timestamp('deleted_at'),
  data: jsonb('data').notNull(),
});`,
    )
    .join('\n\n');
  const map = types
    .map((t) => `    ${t}: { table: schema.${camel(table(t))}, columns: { id: 'id', version: 'atlasVersion', deletedAt: 'deletedAt' }, onDelete: 'soft', map: (data) => ({ data }) },`)
    .join('\n');
  return `// schema.ts
import { bigint, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

${tables}

export const atlasMirrorCursor = pgTable('atlas_mirror_cursor', {
  id: text('id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
});

// mirror.ts
import * as orm from 'drizzle-orm';
import { createAtlasClient, createMirror } from '@atlasauth/backend';
import { drizzleMirrorStore } from '@atlasauth/backend/mirror/drizzle';
import * as schema from './schema';

export const mirror = createMirror({
  client: createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY! }),
  resources: [${types.map((t) => `'${t}'`).join(', ')}],
  store: drizzleMirrorStore({
    db, // your drizzle database
    orm,
    cursor: {
      async get(d) {
        const [row] = await d.select().from(schema.atlasMirrorCursor);
        return row ? row.seq : null;
      },
      async set(d, seq) {
        await d.insert(schema.atlasMirrorCursor).values({ id: 'main', seq }).onConflictDoUpdate({ target: schema.atlasMirrorCursor.id, set: { seq } });
      },
    },
    tables: {
${map}
    },
  }),
});

mirror.start(); // or call await mirror.sync() from a cron / worker
`;
}

function prismaInit(types: string[]): string {
  const models = types
    .map(
      (t) => `model Atlas${pascal(t)} {
  id           String    @id
  atlasVersion BigInt?
  deletedAt    DateTime?
  data         Json
  @@map("${table(t)}")
}`,
    )
    .join('\n\n');
  const map = types
    .map((t) => `    ${t}: { model: 'atlas${pascal(t)}', fields: { id: 'id', version: 'atlasVersion', deletedAt: 'deletedAt' }, onDelete: 'soft', map: (data) => ({ data }) },`)
    .join('\n');
  return `// schema.prisma
${models}

model AtlasMirrorCursor {
  id  String @id
  seq BigInt
  @@map("atlas_mirror_cursor")
}

// mirror.ts
import { createAtlasClient, createMirror } from '@atlasauth/backend';
import { prismaMirrorStore } from '@atlasauth/backend/mirror/prisma';

export const mirror = createMirror({
  client: createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY! }),
  resources: [${types.map((t) => `'${t}'`).join(', ')}],
  store: prismaMirrorStore({
    prisma, // your PrismaClient
    cursor: {
      async get(c) {
        const row = await c.atlasMirrorCursor.findUnique({ where: { id: 'main' } });
        return row ? Number(row.seq) : null;
      },
      async set(c, seq) {
        await c.atlasMirrorCursor.upsert({ where: { id: 'main' }, create: { id: 'main', seq }, update: { seq } });
      },
    },
    models: {
${map}
    },
  }),
});

mirror.start(); // or call await mirror.sync() from a cron / worker
`;
}

/** `atlas mirror init --adapter drizzle|prisma [--types a,b]`: print a starter schema and wiring code. Writes nothing. */
export async function mirrorCommand(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== 'init') throw new CliError(sub ? `Unknown subcommand 'mirror ${sub}'. Try: init.` : 'mirror needs a subcommand: init.');
  const adapter = str(args.values, 'adapter');
  if (adapter !== 'drizzle' && adapter !== 'prisma') throw new CliError('mirror init requires --adapter drizzle|prisma.');
  const types = checkTypes(list(args.values, 'types'));
  const chosen = types.length ? types : ['user', 'organization', 'membership'];
  ctx.io.out(adapter === 'drizzle' ? drizzleInit(chosen) : prismaInit(chosen));
  return 0;
}
