import type { ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { requireClient, wantsJson } from './shared';

/** `atlas messages send` — a transactional email through POST /v1/messages (the instance's own provider and failover). */
export async function messages(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== 'send') throw new CliError(sub ? `Unknown subcommand 'messages ${sub}'. Try: send.` : 'messages needs a subcommand: send.');
  const v = args.values;

  const toRaw = typeof v.to === 'string' ? v.to : '';
  const to = toRaw.split(',').map((a) => a.trim()).filter(Boolean);
  if (to.length === 0) throw new CliError('send needs --to <address> (comma-separate up to 10).');

  const template = typeof v.template === 'string' ? v.template : undefined;
  const subject = typeof v.subject === 'string' ? v.subject : undefined;
  const htmlFile = typeof v['html-file'] === 'string' ? v['html-file'] : undefined;
  const textFile = typeof v['text-file'] === 'string' ? v['text-file'] : undefined;
  if (template && (subject || htmlFile || textFile)) throw new CliError('Use either --template or --subject with --html-file/--text-file, not both.');
  if (!template && !subject) throw new CliError('send needs --template, or --subject with --html-file and/or --text-file.');
  if (!template && !htmlFile && !textFile) throw new CliError('send needs --html-file and/or --text-file with --subject.');

  let data: Record<string, string | number | boolean> | undefined;
  if (typeof v.data === 'string') {
    if (!template) throw new CliError('--data only applies with --template.');
    try {
      data = JSON.parse(v.data) as Record<string, string | number | boolean>;
    } catch {
      throw new CliError('--data must be a JSON object, e.g. --data \'{"order":"1042"}\'.');
    }
  }

  const tags: Record<string, string> = {};
  for (const t of (v.tag as string[] | undefined) ?? []) {
    const i = t.indexOf('=');
    if (i < 1) throw new CliError(`--tag takes key=value, got '${t}'.`);
    tags[t.slice(0, i)] = t.slice(i + 1);
  }

  const read = (file: string) => ctx.readFile(file === '-' ? '/dev/stdin' : file);
  const body = {
    to: to.length === 1 ? to[0]! : to,
    ...(template ? { template, ...(data ? { data } : {}) } : { subject, ...(htmlFile ? { html: read(htmlFile) } : {}), ...(textFile ? { text: read(textFile) } : {}) }),
    ...(Object.keys(tags).length ? { tags } : {}),
  };

  const { client } = requireClient(ctx, v);
  const key = typeof v['idempotency-key'] === 'string' ? v['idempotency-key'] : undefined;
  const res = await client.messages.send(body, key);
  if (wantsJson(v)) {
    printJson(ctx.io, res);
    return 0;
  }
  type Sent = { id: string | null; recipient_masked: string; status: string; status_detail?: string | null };
  const out = res as unknown as Sent | { data: Sent[] };
  const sent = 'data' in out ? out.data : [out];
  for (const m of sent) ctx.io.out(`${m.id ?? '(unrecorded)'}  ${m.recipient_masked}  ${m.status}${m.status_detail ? ` (${m.status_detail})` : ''}`);
  return 0;
}
