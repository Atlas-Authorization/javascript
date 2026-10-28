import type { PageTemplate, PageTemplateDefinition, PageTemplatePage } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable, type Column } from '../output';
import { requireArg, requireClient, wantsJson } from './shared';

const PAGES: PageTemplatePage[] = ['sign-in', 'sign-up', 'user-profile'];

const COLUMNS: Column<PageTemplate>[] = [
  { header: 'PAGE', get: (p) => p.page },
  { header: 'LIVE', get: (p) => (p.live ? `v${p.live.version} ${fmtTime(p.live.updated_at)}` : '-') },
  { header: 'DRAFT', get: (p) => (p.draft ? `v${p.draft.version} ${fmtTime(p.draft.updated_at)}` : '-') },
];

function parsePage(raw: string | undefined): PageTemplatePage {
  if (!raw || !PAGES.includes(raw as PageTemplatePage)) throw new CliError(`--page is required (one of: ${PAGES.join(', ')}).`);
  return raw as PageTemplatePage;
}

/** A template file is the definition itself, or `{ "definition": … }`. */
function readDefinition(ctx: RunContext, file: string): PageTemplateDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.readFile(file));
  } catch (e) {
    throw new CliError(`'${file}' is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const doc = parsed as { definition?: PageTemplateDefinition; regions?: unknown } | null;
  const def = doc?.definition ?? (doc?.regions ? (doc as PageTemplateDefinition) : undefined);
  if (!def) throw new CliError(`'${file}' needs a "regions" object (header, above_form, below_form, footer).`);
  return def;
}

/**
 * `atlas pages` — code-defined hosted-page templates.
 *
 *   list                              each page's live and draft template
 *   push <file> --page <p> [--promote] save the file as the draft (and publish it with --promote)
 *   preview --page <p>                print a signed link to the page with the draft applied
 *   promote --page <p>                make the draft the live template
 *   pull --page <p> [--draft]         print the live (or draft) definition as JSON
 *   discard --page <p> --status <draft|live>
 *                                     drop the draft, or take the live template down
 */
export async function pages(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const json = wantsJson(args.values);
  const { client } = requireClient(ctx, args.values);

  switch (sub) {
    case 'list': {
      const page = await client.pageTemplates.list();
      if (json) printJson(ctx.io, page);
      else ctx.io.out(renderTable(COLUMNS, page.data));
      return 0;
    }
    case 'push': {
      const file = requireArg(args.positionals, 2, 'file');
      const page = parsePage(str(args.values, 'page'));
      let state = await client.pageTemplates.saveDraft(page, readDefinition(ctx, file));
      if (args.values.promote) state = await client.pageTemplates.promote(page);
      if (json) printJson(ctx.io, state);
      else ctx.io.out(args.values.promote ? `Saved and published the ${page} template.` : `Saved the ${page} draft. Run 'atlas pages preview --page ${page}' to see it.`);
      return 0;
    }
    case 'preview': {
      const out = await client.pageTemplates.preview(parsePage(str(args.values, 'page')));
      if (json) printJson(ctx.io, out);
      else {
        ctx.io.out(out.url);
        ctx.io.err(`The link works until ${fmtTime(out.expires_at)} and shows the draft with a preview banner.`);
      }
      return 0;
    }
    case 'promote': {
      const page = parsePage(str(args.values, 'page'));
      const state = await client.pageTemplates.promote(page);
      if (json) printJson(ctx.io, state);
      else ctx.io.out(`The ${page} draft is now live.`);
      return 0;
    }
    case 'pull': {
      const state = await client.pageTemplates.get(parsePage(str(args.values, 'page')));
      const slot = args.values.draft ? state.draft : state.live;
      if (!slot) throw new CliError(`There is no ${args.values.draft ? 'draft' : 'live'} template for ${state.page}.`);
      printJson(ctx.io, slot.definition);
      return 0;
    }
    case 'discard': {
      const page = parsePage(str(args.values, 'page'));
      const status = str(args.values, 'status');
      if (status !== 'draft' && status !== 'live') throw new CliError('--status is required: draft or live.');
      const state = await client.pageTemplates.discard(page, status);
      if (json) printJson(ctx.io, state);
      else ctx.io.out(`Dropped the ${status} ${page} template.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown pages command '${sub ?? ''}'. Try: list, push, preview, promote, pull, discard.`);
  }
}
