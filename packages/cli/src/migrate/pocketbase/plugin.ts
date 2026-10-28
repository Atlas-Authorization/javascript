import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportPocketBase, readPocketBaseDb, readPocketBaseDump, type PocketBaseTables } from '../export/pocketbase';
import { parsePocketBaseSchema, translatePocketBaseConfig } from '../export/pocketbase-config';
import { CliError } from '../../errors';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { vendorStep, writeRecordSet } from '../export/plugin-kit';
import { projectDir, projectFile, truthyCredential } from '../export/project-files';

/**
 * `atlas migrate pocketbase` — a PocketBase app (v0.23+ and ≤0.22). The REST
 * API never returns password hashes, so everything is read from the SQLite
 * database on this machine: `pb_data/data.db` through Node's built-in SQLite
 * (read-only), or a `sqlite3 -json` dump folder. Auth collection options
 * become Atlas config; the `pocketbase` remote bridge asks PocketBase about a
 * live token once (auth-refresh); lazy migration signs in against PocketBase
 * for anyone left; and the `pocketbase` codemod rewrites the JS SDK calls.
 */

const DB: CredentialSpec = { flag: '--pocketbase-db', env: 'POCKETBASE_DB', label: 'pb_data/data.db (copy it with its -wal/-shm files, or stop the server)', required: false };
const DUMP: CredentialSpec = { flag: '--pocketbase-dump', env: 'POCKETBASE_DUMP', label: 'a folder of sqlite3 -json table dumps (_collections, your auth collections, _externalAuths)', required: false };
const SCHEMA: CredentialSpec = { flag: '--pocketbase-schema', env: 'POCKETBASE_SCHEMA', label: 'a collections export (Settings → Export collections, pb_schema.json)', required: false };
const URL_SPEC: CredentialSpec = { flag: '--pocketbase-url', env: 'POCKETBASE_URL', label: 'the public PocketBase URL (https://pb.example.com)', required: false };
const COLLECTIONS: CredentialSpec = { flag: '--pocketbase-collections', env: 'POCKETBASE_COLLECTIONS', label: 'auth collections to export, comma-separated (default: all but _superusers)', required: false };
const SUPERUSERS: CredentialSpec = { flag: '--pocketbase-superusers', env: 'POCKETBASE_SUPERUSERS', label: 'true to export _superusers too', required: false };

async function readTables(p: PluginContext): Promise<{ tables: PocketBaseTables; origin: string } | undefined> {
  const dump = projectDir(p, DUMP);
  if (dump) return { tables: readPocketBaseDump(dump), origin: 'sqlite3 dump' };
  const named = p.credential(DB);
  const db = named ? resolve(named) : [join(resolve(p.project), 'pb_data', 'data.db')].find((f) => existsSync(f));
  if (!db) return undefined;
  return { tables: await readPocketBaseDb(db), origin: 'pb_data/data.db' };
}

function url(p: PluginContext): string | undefined {
  return p.credential(URL_SPEC)?.trim().replace(/\/+$/, '');
}

export const pocketbasePlugin: MigrationPlugin = {
  vendor: 'pocketbase',
  source: 'pocketbase',
  label: 'PocketBase',
  help: 'Move a PocketBase app: auth collection options (password, OAuth2, OTP, MFA, token duration, rules) as Atlas config; every auth record with its bcrypt hash, verified email, username, custom fields and OAuth2 links, read from pb_data/data.db or a sqlite3 dump on this machine; a zero-logout bridge that asks PocketBase about each live token once; lazy migration for anyone left; and the code.',
  config: {
    reads: 'a collections export (pb_schema.json) or _collections in pb_data/data.db',
    credentials: [SCHEMA, DB, DUMP, URL_SPEC],
    async translate(p) {
      const file = projectFile(p, SCHEMA, ['pb_schema.json']);
      if (file) return vendorStep('PocketBase', async () => translatePocketBaseConfig({ collections: parsePocketBaseSchema(file.text), file, url: url(p) }));
      const read = await vendorStep('PocketBase', () => readTables(p));
      if (!read) throw new CliError('PocketBase: pass a collections export (--set pocketbase-schema=pb_schema.json), the database (--set pocketbase-db=pb_data/data.db) or a dump folder (--set pocketbase-dump=<dir>).');
      return translatePocketBaseConfig({ collections: read.tables.collections, url: url(p) });
    },
  },
  export: {
    reads: 'pb_data/data.db (read-only, built-in SQLite) or a sqlite3 -json dump folder',
    credentials: [DB, DUMP, URL_SPEC, COLLECTIONS, SUPERUSERS],
    limits: [
      'The PocketBase API never returns password hashes or token keys: the export reads the SQLite database (or your dump of it) on this machine.',
      'Auth tokens are signed per record and are not imported: the pocketbase bridge preset asks PocketBase (auth-refresh) about each live token once instead.',
      'PocketBase MFA and OTP are one-time sign-in state, not enrolled factors: users enrol an Atlas second factor after the move.',
      '≤0.22 admins (_admins) are not exported.',
    ],
    async run(p, writer, resume) {
      const read = await vendorStep('PocketBase', () => readTables(p));
      if (!read) throw new CliError('PocketBase: no pb_data/data.db in this folder. Pass --set pocketbase-db=<path to data.db> or --set pocketbase-dump=<folder of sqlite3 -json dumps>.');
      const collections = p.credential(COLLECTIONS)?.split(',').map((c) => c.trim()).filter(Boolean);
      const set = exportPocketBase(read.tables, { collections, includeSuperusers: truthyCredential(p, SUPERUSERS), url: url(p), origin: read.origin });
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'pocketbase',
    vars(p, t) {
      const vars: Record<string, string> = { ...t?.bridge?.vars };
      const u = url(p);
      if (u) vars.url = u;
      vars.collection ??= 'users';
      return vars;
    },
  },
  lazy: {
    preset: 'pocketbase',
    config(p, t) {
      const config: Record<string, string> = { ...t?.lazy?.config };
      const u = url(p);
      if (u) config.url = u;
      config.collection ??= 'users';
      return config;
    },
  },
  codemod: 'pocketbase',
};
