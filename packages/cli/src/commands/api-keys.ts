import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { signApiKeyAssertion, type ApiKey, type ApiKeySubjectType } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { productDir, writeSecretFile } from '../secrets';
import { requireArg, requireClient, wantsJson } from './shared';

const COLUMNS: Column<ApiKey>[] = [
  { header: 'ID', get: (k) => k.id },
  { header: 'SUBJECT_TYPE', get: (k) => k.subject_type },
  { header: 'SUBJECT_ID', get: (k) => k.subject_id },
  { header: 'NAME', get: (k) => k.name },
  { header: 'PREFIX', get: (k) => k.prefix },
  { header: 'CREATED', get: (k) => fmtTime(k.created_at) },
];

const SUBJECT_TYPES: readonly ApiKeySubjectType[] = ['user', 'organization'];

function parseSubjectType(value: string | undefined, flag: string): ApiKeySubjectType {
  if (!value) throw new CliError(`api-keys create requires ${flag} <user|organization>.`);
  if (!SUBJECT_TYPES.includes(value as ApiKeySubjectType)) {
    throw new CliError(`${flag} must be one of: ${SUBJECT_TYPES.join(', ')} (got '${value}').`);
  }
  return value as ApiKeySubjectType;
}

/** Write the one-time private key: 0600, never over an existing file (it may be the only copy of another key). */
function writePrivateKey(path: string, pem: string): void {
  if (existsSync(path)) throw new CliError(`${path} already exists. Nothing was overwritten; pick another --out.`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

/** `atlas api-keys <list|create|revoke|sign-assertion|verify>` — maps onto `client.apiKeys.*`. */
export async function apiKeys(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'list': {
      const { client } = requireClient(ctx, args.values);
      // Optional narrowing to one subject; the route itself is not cursor-paged.
      const subjectType = str(args.values, 'subject-type');
      const page = await client.apiKeys.list({
        subject_type: subjectType ? parseSubjectType(subjectType, '--subject-type') : undefined,
        subject_id: str(args.values, 'subject-id'),
      });
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }

    case 'create': {
      const subjectType = parseSubjectType(str(args.values, 'subject-type'), '--subject-type');
      const subjectId = str(args.values, 'subject-id');
      if (!subjectId) throw new CliError('api-keys create requires --subject-id <id>.');
      const keyPair = args.values['key-pair'] === true;
      const audience = str(args.values, 'audience');
      const publicKeyFile = str(args.values, 'public-key');
      const out = str(args.values, 'out');
      if (!keyPair && (audience || publicKeyFile)) throw new CliError('--audience and --public-key need --key-pair.');
      const publicKey = publicKeyFile ? ctx.readFile(publicKeyFile) : undefined;
      // Check the target first: the private key is revealed once, so a late refusal would lose it.
      if (keyPair && !publicKey && out && out !== '-' && existsSync(out)) throw new CliError(`${out} already exists. Nothing was overwritten; pick another --out.`);
      const { client } = requireClient(ctx, args.values);
      const key = await client.apiKeys.create({
        subject_type: subjectType,
        subject_id: subjectId,
        name: str(args.values, 'name'),
        ...(keyPair ? { credential: 'key_pair' as const, audience, public_key: publicKey } : {}),
      });
      if (keyPair) {
        const { private_key: pem, ...pub } = key as ApiKey & { private_key?: string };
        const keyId = key.key_id ?? key.id;
        if (!pem) {
          if (json) printJson(ctx.io, pub);
          else ctx.io.out(`Created key-pair API key ${keyId} with your public key.`);
          return 0;
        }
        if (out === '-') {
          if (json) printJson(ctx.io, { ...pub, private_key: pem });
          else {
            ctx.io.err('atlas: warning: printing the private key because --out - was given. It may end up in your shell history, terminal scrollback or CI logs.');
            ctx.io.out(pem);
          }
          return 0;
        }
        const path = out ?? join(productDir(ctx.env, str(args.values, 'product') ?? 'atlasauth'), `api-key-${keyId}.p8`);
        writePrivateKey(path, pem);
        if (json) printJson(ctx.io, { ...pub, private_key_file: path });
        else {
          ctx.io.out(`Created key-pair API key ${keyId}.`);
          ctx.io.out(`Private key written to ${path} (mode 0600). It is shown nowhere else.`);
        }
        return 0;
      }
      // The secret is revealed exactly once. By default it goes to a 0600 file
      // and only the path is printed; --print-secret is the explicit opt-out.
      const printSecret = args.values['print-secret'] === true;
      const { secret, ...rest } = key;
      if (printSecret) {
        ctx.io.err(
          'atlas: warning: printing the API key because --print-secret was given. It may end up in your shell history, terminal scrollback or CI logs.',
        );
        if (json) printJson(ctx.io, key);
        else {
          ctx.io.out(`Created API key ${key.id}.`);
          ctx.io.out(`Secret (shown once): ${secret}`);
        }
        return 0;
      }
      const { path } = writeSecretFile(
        productDir(ctx.env, str(args.values, 'product') ?? 'atlasauth'),
        `api-key-${key.id}.env`,
        { ATLAS_API_KEY: secret ?? '' },
        { force: args.values.force === true, comment: `End-user API key ${key.id} (${subjectType} ${subjectId}).` },
      );
      if (json) {
        printJson(ctx.io, { ...rest, secret_file: path });
      } else {
        ctx.io.out(`Created API key ${key.id}.`);
        ctx.io.out(`Secret written to ${path} (mode 0600). It is shown nowhere else.`);
      }
      return 0;
    }

    case 'sign-assertion': {
      const keyFile = str(args.values, 'key');
      const keyId = str(args.values, 'key-id');
      const audience = str(args.values, 'audience');
      if (!keyFile || !keyId || !audience) throw new CliError('api-keys sign-assertion requires --key <file.p8>, --key-id <id> and --audience <aud>.');
      const ttl = str(args.values, 'ttl');
      const ttlSeconds = ttl === undefined ? 300 : Number(ttl);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) throw new CliError('--ttl is a whole number of seconds from 1 to 86400.');
      let jwt: string;
      try {
        jwt = await signApiKeyAssertion(ctx.readFile(keyFile), { keyId, audience, ttlSeconds, scope: str(args.values, 'scope') });
      } catch (err) {
        throw new CliError(err instanceof Error ? err.message : 'Could not sign the assertion.');
      }
      if (json) printJson(ctx.io, { assertion: jwt, expires_in: ttlSeconds });
      else ctx.io.out(jwt);
      return 0;
    }

    case 'verify': {
      const token = str(args.values, 'token');
      if (!token) throw new CliError('api-keys verify requires --token <assertion>.');
      const { client } = requireClient(ctx, args.values);
      const verdict = await client.apiKeys.verify({ token });
      printJson(ctx.io, verdict);
      return verdict.valid ? 0 : 1;
    }

    case 'revoke': {
      const id = requireArg(args.positionals, 2, 'api-key-id');
      const { client } = requireClient(ctx, args.values);
      const result = await client.apiKeys.delete(id);
      if (json) printJson(ctx.io, result);
      else ctx.io.out(`Revoked API key ${result.id}.`);
      return 0;
    }

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'api-keys ${sub}'. Try: list, create, revoke, sign-assertion, verify.`
          : 'api-keys needs a subcommand: list, create, revoke, sign-assertion, verify.',
      );
  }
}
