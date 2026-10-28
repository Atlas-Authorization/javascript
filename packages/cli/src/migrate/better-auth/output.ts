import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serialize, type Format, type Json } from '../../serialize';
import type { ReportEntry, ReportStatus, Translation } from './translate';

/** The report files written next to the config documents (ignored by `atlas config import`). */
export const REPORT_MD = 'better-auth-report.md';
export const REPORT_JSON = 'better-auth-report.json';

const ORDER: ReportStatus[] = ['manual', 'differs', 'mapped'];
const HEADINGS: Record<ReportStatus, string> = {
  manual: 'Needs a manual step',
  differs: 'Maps with a difference',
  mapped: 'Maps 1:1',
};

/** Counts per status. */
export function reportCounts(report: ReportEntry[]): Record<ReportStatus, number> {
  const out: Record<ReportStatus, number> = { mapped: 0, differs: 0, manual: 0 };
  for (const e of report) out[e.status] += 1;
  return out;
}

/** The resource files a translation produces: only the non-empty ones, plus the instance. */
export function documentFiles(t: Translation): Array<{ type: string; value: Json }> {
  const d = t.document;
  const files: Array<{ type: string; value: Json }> = [{ type: 'instance', value: d.instance as unknown as Json }];
  const collections: Array<[string, Json[]]> = [
    ['oauth_providers', d.oauth_providers],
    ['custom_oauth_providers', d.custom_oauth_providers],
    ['permissions', d.permissions],
    ['roles', d.roles],
    ['oauth_clients', d.oauth_clients],
    ['resource_servers', d.resource_servers],
    ['billing_plans', d.billing_plans],
    ['redirect_urls', d.redirect_urls],
    ['jwt_templates', d.jwt_templates],
  ];
  for (const [type, value] of collections) if (value.length) files.push({ type, value });
  return files;
}

/** Write the config documents and both reports into `dir`. Returns the file names written. */
export function writeTranslation(t: Translation, dir: string, format: Format): string[] {
  mkdirSync(dir, { recursive: true });
  const ext = format === 'json' ? 'json' : 'yaml';
  const written: string[] = [];
  for (const f of documentFiles(t)) {
    const name = `${f.type}.${ext}`;
    writeFileSync(join(dir, name), serialize(f.value, format));
    written.push(name);
  }
  writeFileSync(join(dir, REPORT_MD), renderReport(t));
  writeFileSync(join(dir, REPORT_JSON), JSON.stringify(reportJson(t), null, 2) + '\n');
  written.push(REPORT_MD, REPORT_JSON);
  return written;
}

/** The machine-readable report (no values of secrets: only env var names). */
export function reportJson(t: Translation): Record<string, unknown> {
  return {
    object: 'better_auth_config_translation',
    source: t.source,
    other_instances: t.otherInstances,
    plugins: t.plugins,
    counts: reportCounts(t.report),
    report: t.report,
    env: t.env,
    secrets: t.secrets,
    mappings: t.mappings,
    bridge: t.bridge,
    document: t.document,
  };
}

/** The human report, as Markdown. */
export function renderReport(t: Translation): string {
  const counts = reportCounts(t.report);
  const lines: string[] = [];
  lines.push('# Better Auth → Atlas: configuration report', '');
  lines.push(t.source ? `Translated \`betterAuth()\` at \`${t.source.file}:${t.source.line}\`.` : 'No `betterAuth()` call was found.', '');
  if (t.plugins.length) lines.push(`Plugins: ${t.plugins.map((p) => `\`${p}\``).join(', ')}.`, '');
  lines.push(`${counts.mapped} map 1:1, ${counts.differs} map with a difference, ${counts.manual} need a manual step.`, '');
  if (t.env.length) {
    lines.push('## Environment variables to set before applying', '');
    lines.push('The config files hold `${NAME}` placeholders, never secret values. Set these (from your app\'s environment) when you run `atlas config import` or `atlas migrate better-auth`:', '');
    for (const e of t.env) lines.push(`- \`${e.name}\`: ${e.for}`);
    lines.push('');
  }
  if (t.secrets.length) {
    lines.push('## Secrets stored before the config', '');
    for (const s of t.secrets) lines.push(`- captcha secret for \`${s.provider}\` from \`${s.env}\` (write-only)`);
    lines.push('');
  }
  for (const status of ORDER) {
    const entries = t.report.filter((e) => e.status === status);
    if (!entries.length) continue;
    lines.push(`## ${HEADINGS[status]} (${entries.length})`, '');
    lines.push('| Better Auth | Atlas | Note | Where |', '|---|---|---|---|');
    for (const e of entries) {
      lines.push(`| \`${cell(e.option)}\` | ${e.atlas ? `\`${cell(e.atlas)}\`` : ''} | ${cell(e.note)} | \`${e.file}:${e.line}\` |`);
    }
    lines.push('');
  }
  const providers = Object.entries(t.mappings.providers);
  if (providers.length) {
    lines.push('## Provider ids', '', '| Better Auth providerId | Atlas provider |', '|---|---|');
    for (const [from, to] of providers) lines.push(`| \`${from}\` | \`${to}\` |`);
    lines.push('');
  }
  const roles = Object.entries(t.mappings.roles);
  if (roles.length) {
    lines.push('## Organization roles', '', '| Better Auth role | Atlas role |', '|---|---|');
    for (const [from, to] of roles) lines.push(`| \`${from}\` | \`${to}\` |`);
    lines.push('');
  }
  return lines.join('\n');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Short terminal summary lines. */
export function summaryLines(t: Translation, dir: string, written: string[]): string[] {
  const c = reportCounts(t.report);
  const out = [
    t.source ? `Read betterAuth() at ${t.source.file}:${t.source.line}${t.plugins.length ? ` with ${t.plugins.length} plugin(s): ${t.plugins.join(', ')}` : ''}.` : 'No betterAuth() call found.',
    `Wrote ${written.length - 2} config file(s) and the report to ${dir}: ${written.join(', ')}`,
    `${c.mapped} map 1:1, ${c.differs} map with a difference, ${c.manual} need a manual step (see ${join(dir, REPORT_MD)}).`,
  ];
  if (t.env.length) out.push(`Set before applying: ${t.env.map((e) => e.name).join(', ')}`);
  for (const e of t.report.filter((x) => x.status === 'manual')) out.push(`  manual  ${e.file}:${e.line}  ${e.option}: ${e.note}`);
  return out;
}
