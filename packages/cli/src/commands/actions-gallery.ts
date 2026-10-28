import { dirname, resolve } from 'node:path';
import type {
  ActionGalleryEntry,
  ActionGalleryInstallation,
  ActionTemplateSecret,
  CreateActionTemplateBody,
  GalleryTrigger,
} from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable, type Column } from '../output';
import { parseDotenv } from '../secrets';
import { requireArg, requireClient, wantsJson } from './shared';

/**
 * The gallery half of `atlas actions`:
 *
 *   gallery [query] [--trigger t]     browse first-party and community templates
 *   show <slug>                       a template's description, secrets and code
 *   install <slug> [--secrets-file f] install as a DISABLED action (secrets from a dotenv file)
 *   installs                          actions from the gallery, with update status
 *   update <action-id> [--secrets-file f]
 *                                     move an installed action to the latest version
 *   publish <template.json> [--draft] create or version your own template and submit it
 *
 * Secret VALUES come from a dotenv file, never from argv (shell history).
 */

const GALLERY_COLUMNS: Column<ActionGalleryEntry>[] = [
  { header: 'SLUG', get: (t) => t.slug },
  { header: 'NAME', get: (t) => t.name },
  { header: 'TRIGGER', get: (t) => t.trigger },
  { header: 'BY', get: (t) => (t.author.first_party ? 'Atlas' : `${t.author.name}${t.verified ? ' ✓' : ''}`) },
  { header: 'VERSION', get: (t) => t.latest_version },
  { header: 'INSTALLS', get: (t) => t.install_count },
  { header: 'CALLS OUT', get: (t) => (t.uses_http ? 'yes' : '') },
];

const INSTALL_COLUMNS: Column<ActionGalleryInstallation>[] = [
  { header: 'ACTION', get: (i) => i.action_id },
  { header: 'NAME', get: (i) => i.action_name },
  { header: 'TEMPLATE', get: (i) => i.template_slug },
  { header: 'VERSION', get: (i) => i.installed_version },
  { header: 'LATEST', get: (i) => i.latest_version ?? 'removed' },
  { header: 'UPDATE', get: (i) => (i.update_available ? 'available' : '') },
  { header: 'ENABLED', get: (i) => i.enabled },
  { header: 'MISSING SECRETS', get: (i) => i.missing_secrets },
];

function secretsFrom(ctx: RunContext, args: ParsedArgs): Record<string, string> | undefined {
  const file = str(args.values, 'secrets-file');
  if (!file) return undefined;
  return parseDotenv(ctx.readFile(file));
}

export async function gallery(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { client } = requireClient(ctx, args.values);
  const q = args.positionals.slice(2).join(' ').trim() || undefined;
  const trigger = str(args.values, 'trigger') as GalleryTrigger | undefined;
  const page = await client.actionGallery.list({ q, trigger });
  if (wantsJson(args.values)) printJson(ctx.io, page);
  else {
    ctx.io.out(renderTable(GALLERY_COLUMNS, page.data));
    ctx.io.out('');
    ctx.io.out("Details: 'atlas actions show <slug>'. Install: 'atlas actions install <slug> [--secrets-file .env.action]'.");
  }
  return 0;
}

export async function show(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const slug = requireArg(args.positionals, 2, 'slug');
  const { client } = requireClient(ctx, args.values);
  const t = await client.actionGallery.get(slug);
  if (wantsJson(args.values)) {
    printJson(ctx.io, t);
    return 0;
  }
  ctx.io.out(`${t.name}  (${t.slug} ${t.latest_version}, ${t.trigger})`);
  ctx.io.out(`By ${t.author.first_party ? 'Atlas' : t.author.name}${t.verified && !t.author.first_party ? ' (verified)' : ''} · ${t.license} · ${t.install_count} install(s)`);
  ctx.io.out('');
  ctx.io.out(t.summary);
  if (t.uses_http) ctx.io.out('Sends outbound HTTPS requests (after the sign-in completes).');
  ctx.io.out('');
  ctx.io.out('Secrets:');
  if (t.secrets.length === 0) ctx.io.out('  (none)');
  for (const s of t.secrets) ctx.io.out(`  ${s.name}${s.required ? ' (required)' : ''}  ${s.description}`);
  ctx.io.out('');
  ctx.io.out('Code:');
  ctx.io.out(t.code.replace(/^/gm, '  '));
  return 0;
}

export async function install(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const slug = requireArg(args.positionals, 2, 'slug');
  const secrets = secretsFrom(ctx, args);
  const { client } = requireClient(ctx, args.values);
  const res = await client.actionGallery.install(slug, {
    ...(str(args.values, 'name') ? { name: str(args.values, 'name') } : {}),
    ...(secrets ? { secrets } : {}),
  });
  if (wantsJson(args.values)) {
    printJson(ctx.io, res);
    return 0;
  }
  ctx.io.out(`Installed ${res.template.slug} ${res.template.version} as action ${res.action.id} (${res.action.name}), DISABLED.`);
  if (res.missing_secrets.length > 0) {
    ctx.io.out(`Still needs: ${res.missing_secrets.join(', ')}. Set them with 'atlas actions update ${res.action.id} --secrets-file <file>' or in the dashboard.`);
  }
  ctx.io.out(`Next: bind it to the ${res.action.trigger} flow and enable it (dashboard → Actions), after a dry run.`);
  return 0;
}

export async function installs(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const { client } = requireClient(ctx, args.values);
  const page = await client.actionGallery.installs();
  if (wantsJson(args.values)) printJson(ctx.io, page);
  else ctx.io.out(renderTable(INSTALL_COLUMNS, page.data));
  return 0;
}

export async function update(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const id = requireArg(args.positionals, 2, 'action-id');
  const secrets = secretsFrom(ctx, args);
  const { client } = requireClient(ctx, args.values);
  const res = await client.actionGallery.update(id, secrets ? { secrets } : {});
  if (wantsJson(args.values)) printJson(ctx.io, res);
  else if (res.updated) ctx.io.out(`Updated ${id} from ${res.from_version} to ${res.version}.`);
  else ctx.io.out(`${id} already runs the latest version (${res.version}).`);
  return 0;
}

/** The manifest `atlas actions publish` reads. `code_file` is relative to it. */
interface TemplateManifest {
  slug?: string;
  name?: string;
  author_name?: string;
  summary?: string;
  description?: string;
  category?: string;
  tags?: string[];
  trigger?: GalleryTrigger;
  license?: string;
  repository_url?: string;
  version?: string;
  code?: string;
  code_file?: string;
  secrets?: ActionTemplateSecret[];
  changelog?: string;
}

export async function publish(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const file = requireArg(args.positionals, 2, 'template.json');
  let manifest: TemplateManifest;
  try {
    manifest = JSON.parse(ctx.readFile(file)) as TemplateManifest;
  } catch (err) {
    throw new CliError(`${file} is not valid JSON (${(err as Error).message}).`);
  }
  for (const key of ['slug', 'name', 'trigger', 'version'] as const) {
    if (!manifest[key]) throw new CliError(`${file} needs "${key}".`);
  }
  const code = manifest.code ?? (manifest.code_file ? ctx.readFile(resolve(dirname(file), manifest.code_file)) : undefined);
  if (!code?.trim()) throw new CliError(`${file} needs "code" or "code_file".`);
  const submit = args.values.draft !== true;

  const { client } = requireClient(ctx, args.values);
  const mine = await client.actionTemplates.list();
  const existing = mine.data.find((t) => t.slug === manifest.slug);
  const version = { version: manifest.version!, code, secrets: manifest.secrets ?? [], changelog: manifest.changelog, submit };
  let result: unknown;
  if (existing) {
    const listing = {
      name: manifest.name,
      summary: manifest.summary,
      description: manifest.description,
      category: manifest.category,
      tags: manifest.tags,
      license: manifest.license,
      repository_url: manifest.repository_url,
      ...(manifest.author_name ? { author_name: manifest.author_name } : {}),
    };
    await client.actionTemplates.update(existing.id, listing);
    result = await client.actionTemplates.addVersion(existing.id, version);
    if (!wantsJson(args.values)) ctx.io.out(`Added ${manifest.slug} ${manifest.version}${submit ? ' and submitted it for review' : ' as a draft'}.`);
  } else {
    if (!manifest.author_name) throw new CliError(`${file} needs "author_name" (shown as the author) for a new template.`);
    const body: CreateActionTemplateBody = {
      slug: manifest.slug!,
      name: manifest.name!,
      author_name: manifest.author_name,
      trigger: manifest.trigger!,
      summary: manifest.summary,
      description: manifest.description,
      category: manifest.category,
      tags: manifest.tags,
      license: manifest.license,
      repository_url: manifest.repository_url,
      ...version,
    };
    result = await client.actionTemplates.create(body);
    if (!wantsJson(args.values)) ctx.io.out(`Created ${manifest.slug} ${manifest.version}${submit ? ' and submitted it for review' : ' as a draft'}.`);
  }
  if (wantsJson(args.values)) printJson(ctx.io, result);
  else if (submit) ctx.io.out('It is listed in the gallery once approved; follow its status with --json or in the dashboard.');
  return 0;
}
