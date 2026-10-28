import { basename } from 'node:path';
import type { Action, ActionTrigger } from '@atlasauth/backend';
import { ACTION_TRIGGERS, createTestEvent, runScript } from '@atlasauth/actions';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';
import { gallery, install, installs, publish, show, update } from './actions-gallery';

const COLUMNS: Column<Action>[] = [
  { header: 'ID', get: (a) => a.id },
  { header: 'NAME', get: (a) => a.name },
  { header: 'TRIGGER', get: (a) => a.trigger },
  { header: 'ENABLED', get: (a) => a.enabled },
  { header: 'SECRETS', get: (a) => a.secret_names },
  { header: 'UPDATED', get: (a) => fmtTime(a.updated_at) },
];

/** Validate a `--trigger` value against the known set, with a clean error. */
function parseTrigger(raw: string | undefined): ActionTrigger {
  if (!raw) {
    throw new CliError(`--trigger is required (one of: ${ACTION_TRIGGERS.join(', ')}).`);
  }
  if (!ACTION_TRIGGERS.includes(raw as ActionTrigger)) {
    throw new CliError(`Unknown trigger '${raw}'. Expected one of: ${ACTION_TRIGGERS.join(', ')}.`);
  }
  return raw as ActionTrigger;
}

/**
 * `atlas actions` — manage tenant Actions (code run in the auth pipeline).
 *
 *   list                        the instance's actions
 *   deploy <file> --trigger <t> upload a file's code as a new action
 *   test <file> [--trigger <t>] dry-run the file OFFLINE through @atlasauth/actions
 *   logs <id>                   where to find an action's execution history
 *   gallery | show | install | installs | update | publish
 *                               the Actions gallery (see ./actions-gallery.ts)
 */
export async function actions(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);

  switch (sub) {
    case 'list': {
      const { client } = requireClient(ctx, args.values);
      const page = await client.actions.list();
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }

    case 'deploy': {
      const file = requireArg(args.positionals, 2, 'file');
      const trigger = parseTrigger(str(args.values, 'trigger'));
      const code = ctx.readFile(file);
      if (!code.trim()) throw new CliError(`'${file}' is empty — nothing to deploy.`);
      const name = str(args.values, 'name') || basename(file).replace(/\.[^.]+$/, '');

      const { client } = requireClient(ctx, args.values);
      const action = await client.actions.create({ name, trigger, code });
      if (json) printJson(ctx.io, action);
      else {
        ctx.io.out(`Deployed action ${action.id} (${action.name}) for ${action.trigger}.`);
        ctx.io.err(
          `It is created but NOT yet bound to the ${action.trigger} flow — bind it to run it.`,
        );
      }
      return 0;
    }

    case 'test': {
      const file = requireArg(args.positionals, 2, 'file');
      // Default to post_login's sample event; --trigger picks another shape.
      const trigger = str(args.values, 'trigger')
        ? parseTrigger(str(args.values, 'trigger'))
        : 'post_login';
      const code = ctx.readFile(file);
      if (!code.trim()) throw new CliError(`'${file}' is empty — nothing to test.`);

      // OFFLINE: no network, no client — the local harness mirrors the isolate.
      const result = await runScript(code, createTestEvent(trigger));
      if (json) {
        printJson(ctx.io, result);
      } else {
        ctx.io.out(`Trigger:   ${trigger}`);
        ctx.io.out(`Denied:    ${result.denied}${result.denyReason ? ` (${result.denyReason})` : ''}`);
        ctx.io.out(`ID claims: ${JSON.stringify(result.idTokenClaims)}`);
        ctx.io.out(`AT claims: ${JSON.stringify(result.accessTokenClaims)}`);
        ctx.io.out(`Metadata:  ${JSON.stringify(result.appMetadata)}`);
        if (result.logs.length) ctx.io.out(`Logs:\n  ${result.logs.join('\n  ')}`);
        if (result.error) ctx.io.err(`Error:     ${result.error}`);
      }
      // A thrown error in the action is a failed dry-run → non-zero so CI catches it.
      return result.error ? 1 : 0;
    }

    case 'logs': {
      const id = requireArg(args.positionals, 2, 'action-id');
      // The Backend API does not expose a per-action execution-log endpoint:
      // each run is written as an audit event (`action.<trigger>`) carrying the
      // outcome, duration and captured logs. Point the user at where to read it
      // rather than pretend an endpoint exists.
      const lines = [
        `Atlas does not expose a live log stream for action ${id}.`,
        'Each execution is recorded as an audit event named `action.<trigger>`',
        '(outcome, duration, deny reason / error, and the action\'s console logs).',
        'Read them in the dashboard audit log, or stream them via a configured',
        'log stream. To see what an action WOULD do right now, dry-run it:',
        `  atlas actions test <file> --trigger <trigger>`,
      ];
      if (json) printJson(ctx.io, { object: 'action_logs_info', action_id: id, message: lines.join(' ') });
      else ctx.io.out(lines.join('\n'));
      return 0;
    }

    case 'gallery':
      return gallery(ctx, args);
    case 'show':
      return show(ctx, args);
    case 'install':
      return install(ctx, args);
    case 'installs':
      return installs(ctx, args);
    case 'update':
      return update(ctx, args);
    case 'publish':
      return publish(ctx, args);

    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'actions ${sub}'. Try: list, deploy, test, logs, gallery, show, install, installs, update, publish.`
          : 'actions needs a subcommand: list, deploy, test, logs, gallery, show, install, installs, update, publish.',
      );
  }
}
