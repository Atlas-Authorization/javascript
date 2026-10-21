import type { ApiKey, ApiKeySubjectType } from '@atlasauth/backend';
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

/** `atlas api-keys <list|create|revoke>` — maps onto `client.apiKeys.*`. */
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
      const { client } = requireClient(ctx, args.values);
      const key = await client.apiKeys.create({
        subject_type: subjectType,
        subject_id: subjectId,
        name: str(args.values, 'name'),
      });
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
          ? `Unknown subcommand 'api-keys ${sub}'. Try: list, create, revoke.`
          : 'api-keys needs a subcommand: list, create, revoke.',
      );
  }
}
