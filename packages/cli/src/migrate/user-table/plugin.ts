import { resolve } from 'node:path';
import { str } from '../../args';
import { CliError } from '../../errors';
import { writeRecordSet } from '../export/plugin-kit';
import { mapTable, parseKeyValues, parseTable, typedParams } from '../export/table';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate user-table export --file users.csv` — a user table from any
 * system as CSV / TSV / JSON / NDJSON, with the hash-algorithm picker for
 * stores whose password column is not self-describing. The vendor-neutral
 * catch-all: every flag below is optional.
 */

const SPEC = (flag: string, env: string, label: string): CredentialSpec => ({ flag, env, label, required: false });
const HASH_ALGORITHM = SPEC('hash-algorithm', 'ATLAS_HASH_ALGORITHM', 'the password hash algorithm: auto (default), plaintext, or any id such as bcrypt, md5, sha256_salted, pbkdf2, scrypt');
const SALT_POSITION = SPEC('salt-position', 'ATLAS_SALT_POSITION', 'salted digests: prefix or suffix (default suffix)');
const HASH_ENCODING = SPEC('hash-encoding', 'ATLAS_HASH_ENCODING', 'how the hash column is encoded: hex, base64 or base64url');
const HASH_PARAMS = SPEC('hash-params', 'ATLAS_HASH_PARAMS', 'algorithm parameters, e.g. iterations=10000,digest=sha256');
const COLUMNS = SPEC('map', 'ATLAS_COLUMN_MAP', 'column names when yours differ: email=Mail,id=uid,password=pwd,salt=pwd_salt');
const TRUST = SPEC('trust-emails', 'ATLAS_TRUST_EMAILS', 'mark every address verified (true or false)');

function file(p: PluginContext): string {
  return str(p.args.values, 'file') ?? p.credential({ flag: 'file', env: 'ATLAS_MIGRATE_FILE', label: 'the users file (--file)', required: true })!;
}

export const userTablePlugin: MigrationPlugin = {
  vendor: 'user-table',
  source: 'custom',
  label: 'Your own user table (CSV / JSON)',
  help: 'Import users from a CSV, TSV, JSON array or NDJSON file — a SELECT * of your users table. Columns are recognised by their usual names (id, email, email_verified, username, first_name, last_name, phone, password_hash, salt, created_at, roles, disabled …) or named with --set map=email=Mail,id=uid. Name the password algorithm with --set hash-algorithm=<id> when the column is not self-describing (add salt-position, hash-encoding and hash-params as needed), or plaintext to hash it on this machine. The file is read locally.',
  export: {
    reads: 'a local CSV / TSV / JSON / NDJSON file (--file)',
    credentials: [HASH_ALGORITHM, SALT_POSITION, HASH_ENCODING, HASH_PARAMS, COLUMNS, TRUST],
    limits: ['Social links, second factors, organizations and sessions are not in a flat table: import those with atlas migrate custom (canonical records) after this.'],
    async run(p, writer, resume) {
      const path = resolve(file(p));
      let rows;
      try {
        rows = parseTable(p.ctx.readFile(path));
      } catch (err) {
        throw new CliError(`${path}: ${(err as Error).message}`);
      }
      if (!rows.length) throw new CliError(`No rows found in ${path}.`);
      const position = p.credential(SALT_POSITION);
      if (position && position !== 'prefix' && position !== 'suffix') throw new CliError('--set salt-position must be prefix or suffix.');
      const set = mapTable(rows, {
        map: parseKeyValues(p.credential(COLUMNS)),
        hashAlgorithm: p.credential(HASH_ALGORITHM),
        saltPosition: position as 'prefix' | 'suffix' | undefined,
        hashEncoding: p.credential(HASH_ENCODING),
        hashParams: typedParams(p.credential(HASH_PARAMS)),
        trustEmails: p.credential(TRUST) === 'true',
        origin: `user table ${path}`,
      });
      p.say(`  read ${rows.length} row(s) from ${path}`);
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
};
