import type { PartnerDelivery, PartnerPlatform, PartnerPlatformInput, PartnerPlatformRegistration } from '@atlasauth/backend';
import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

const COLUMNS: Column<PartnerPlatform>[] = [
  { header: 'PARTNER', get: (p) => p.partner },
  { header: 'STATUS', get: (p) => (p.enabled ? 'on' : 'off') },
  { header: 'TOKEN', get: (p) => (p.token_set ? 'stored' : 'not stored') },
  { header: 'RECEIVER', get: (p) => p.receiver_url },
  { header: 'LAST DELIVERY', get: (p) => (p.last_delivery_at ? fmtTime(p.last_delivery_at) : '') },
];

const DELIVERY_COLUMNS: Column<PartnerDelivery>[] = [
  { header: 'WHEN', get: (d) => fmtTime(d.received_at) },
  { header: 'EVENT', get: (d) => d.event_type ?? '' },
  { header: 'OUTCOME', get: (d) => d.outcome },
  { header: 'USER', get: (d) => d.user_id ?? '' },
];

/** The first non-comment line of a file (or stdin), `NAME=value` or a bare value. */
function readTokenFile(ctx: RunContext, file: string): string {
  let text: string;
  try {
    text = ctx.readFile(file === '-' ? '/dev/stdin' : file);
  } catch {
    throw new CliError(`Could not read the partner token from ${file === '-' ? 'stdin' : file}.`);
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  const m = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line);
  const token = (m ? m[1]! : line).trim().replace(/^"(.*)"$/, '$1');
  if (!token || /\s/.test(token)) throw new CliError(`No partner token found in ${file === '-' ? 'stdin' : file}.`);
  return token;
}

/**
 * `atlas partner-platforms list | get <partner> | set <partner> | registration <partner>
 *  | token <partner> | deliveries <partner> | remove <partner>`: this instance as a
 * partner platform of another product (cookiemunch is a preset). The partner
 * token is read from a file or stdin (`--token-file <path|->`) or
 * `ATLAS_PARTNER_TOKEN`, sent once and never printed.
 */
export async function partnerPlatforms(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const partner = args.positionals[2];
  const json = wantsJson(args.values);
  const http = () => {
    const auth = resolveAuth(ctx, args.values);
    return httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  };
  const path = (p: string, rest = '') => `/v1/partner_platforms/${encodeURIComponent(p)}${rest}`;
  const needPartner = () => {
    if (!partner) throw new CliError(`partner-platforms ${sub} needs a partner id (a preset such as cookiemunch, or your own id).`);
    return partner;
  };

  switch (sub) {
    case 'list': {
      const page = await http().get<{ data: PartnerPlatform[] }>('/v1/partner_platforms');
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }
    case 'get': {
      printJson(ctx.io, await http().get<PartnerPlatform>(path(needPartner())));
      return 0;
    }
    case 'set': {
      const target = needPartner();
      const body: PartnerPlatformInput = {};
      const platformId = str(args.values, 'platform-id');
      if (platformId) body.platform_id = platformId;
      const jwks = str(args.values, 'jwks-url');
      if (jwks) body.jwks_url = jwks;
      const header = str(args.values, 'signature-header');
      if (header) body.signature_header = header;
      const sources = list(args.values, 'allowed-source');
      if (sources.length) body.allowed_sources = sources;
      if (args.values.disable === true) body.enabled = false;
      const saved = await http().put<PartnerPlatform>(path(target), body);
      if (json) printJson(ctx.io, saved);
      else
        ctx.io.out(
          `Saved ${saved.partner}: ${saved.enabled ? 'on' : 'off'}, receiver ${saved.receiver_url}. Next: atlas partner-platforms registration ${saved.partner}`,
        );
      return 0;
    }
    case 'registration': {
      const details = await http().get<PartnerPlatformRegistration>(path(needPartner(), '/registration'));
      if (json) {
        printJson(ctx.io, details);
        return 0;
      }
      ctx.io.out(
        [
          `Send ${details.send_to ? details.send_to.contact : 'the partner'} these details:`,
          `  platform id:   ${details.platform_id}`,
          `  receiver URL:  ${details.receiver_url}${details.receiver_url_is_template ? '  ({externalId} = the Atlas instance id)' : ''}`,
          `  events:        ${details.events.join(', ')}`,
          `  signature:     ${details.signature.header}: ${details.signature.format}`,
          `  key set:       ${details.signature.jwks_url} (tolerance ${details.signature.tolerance_seconds}s)`,
          ...(details.send_to ? [`  docs:          ${details.send_to.docs}`] : []),
          `Then store the token it hands back: atlas partner-platforms token ${details.partner} --token-file -`,
        ].join('\n'),
      );
      return 0;
    }
    case 'token': {
      const target = needPartner();
      const file = str(args.values, 'token-file');
      const token = file ? readTokenFile(ctx, file) : ctx.env.ATLAS_PARTNER_TOKEN?.trim();
      if (!token) {
        throw new CliError('Pass the partner token with --token-file <path|-> (or ATLAS_PARTNER_TOKEN). It is stored encrypted and never shown again.');
      }
      const apiBase = str(args.values, 'base-url');
      const saved = await http().post<PartnerPlatform>(path(target, '/token'), {
        token,
        ...(args.values.rotate === true ? { rotate: true } : {}),
        ...(apiBase ? { api_base_url: apiBase } : {}),
      });
      if (json) printJson(ctx.io, saved);
      else ctx.io.out(`Stored the ${saved.name} partner token (encrypted; it is never shown again).`);
      return 0;
    }
    case 'deliveries': {
      const lim = str(args.values, 'limit');
      const page = await http().get<{ data: PartnerDelivery[] }>(path(needPartner(), `/deliveries${lim ? `?limit=${encodeURIComponent(lim)}` : ''}`));
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(DELIVERY_COLUMNS, page.data));
      return 0;
    }
    case 'remove': {
      const target = needPartner();
      await http().delete(path(target));
      if (json) printJson(ctx.io, { partner: target, removed: true });
      else ctx.io.out(`Removed ${target} and its stored partner token.`);
      return 0;
    }
    default:
      throw new CliError(
        sub
          ? `Unknown subcommand 'partner-platforms ${sub}'. Try: list, get, set, registration, token, deliveries, remove.`
          : 'partner-platforms needs a subcommand: list, get, set, registration, token, deliveries, remove.',
      );
  }
}
