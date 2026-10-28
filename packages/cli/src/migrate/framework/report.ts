import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { serialize, type Format } from '../../serialize';
import type { MigrationPlugin, ReportStatus, TranslationReportEntry, TranslationResult } from './plugin';

/**
 * Writing a plugin's translation: the config-as-code documents (the
 * `atlas config import --dir` format) plus `<vendor>-report.md` and
 * `<vendor>-report.json`. The JSON report holds the whole translation, so a
 * resumed run reads it back instead of asking the vendor again.
 */

export const reportMd = (plugin: MigrationPlugin) => `${plugin.vendor}-report.md`;
export const reportJsonName = (plugin: MigrationPlugin) => `${plugin.vendor}-report.json`;

const ORDER: ReportStatus[] = ['manual', 'differs', 'mapped'];
const HEADINGS: Record<ReportStatus, string> = { manual: 'Needs a manual step', differs: 'Maps with a difference', mapped: 'Maps 1:1' };

export function reportCounts(report: TranslationReportEntry[]): Record<ReportStatus, number> {
  const out: Record<ReportStatus, number> = { mapped: 0, differs: 0, manual: 0 };
  for (const e of report) out[e.status] += 1;
  return out;
}

const where = (e: TranslationReportEntry) => (e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : e.setting);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderTranslationReport(plugin: MigrationPlugin, t: TranslationResult): string {
  const c = reportCounts(t.report);
  const lines = [`# ${plugin.label} → Atlas: configuration report`, '', `Read from ${t.origin}.`, '', `${c.mapped} map 1:1, ${c.differs} map with a difference, ${c.manual} need a manual step.`, ''];
  if (t.env.length) {
    lines.push('## Environment variables to set before applying', '');
    for (const e of t.env) lines.push(`- \`${e.name}\`: ${e.for}`);
    lines.push('');
  }
  for (const status of ORDER) {
    const entries = t.report.filter((e) => e.status === status);
    if (!entries.length) continue;
    lines.push(`## ${HEADINGS[status]} (${entries.length})`, '', `| ${plugin.label} | Atlas | Note | Where |`, '|---|---|---|---|');
    for (const e of entries) lines.push(`| \`${cell(e.setting)}\` | ${e.atlas ? `\`${cell(e.atlas)}\`` : ''} | ${cell(e.note)} | \`${cell(where(e))}\` |`);
    lines.push('');
  }
  for (const [title, map] of [['Provider ids', t.mappings.providers], ['Roles', t.mappings.roles]] as const) {
    const rows = Object.entries(map);
    if (!rows.length) continue;
    lines.push(`## ${title}`, '', `| ${plugin.label} | Atlas |`, '|---|---|');
    for (const [from, to] of rows) lines.push(`| \`${from}\` | \`${to}\` |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Write the documents (non-empty ones) and both reports into `dir`. Returns the file names written. */
export function writePluginTranslation(plugin: MigrationPlugin, t: TranslationResult, dir: string, format: Format): string[] {
  mkdirSync(dir, { recursive: true });
  const ext = format === 'json' ? 'json' : 'yaml';
  const written: string[] = [];
  for (const [type, value] of Object.entries(t.documents)) {
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    const name = `${type}.${ext}`;
    writeFileSync(join(dir, name), serialize(value, format));
    written.push(name);
  }
  writeFileSync(join(dir, reportMd(plugin)), renderTranslationReport(plugin, t));
  writeFileSync(join(dir, reportJsonName(plugin)), JSON.stringify({ object: 'config_translation', vendor: plugin.vendor, source: plugin.source, counts: reportCounts(t.report), translation: t }, null, 2) + '\n');
  written.push(reportMd(plugin), reportJsonName(plugin));
  return written;
}

/** The translation a previous run wrote into `dir`, or undefined. */
export function readPluginTranslation(plugin: MigrationPlugin, dir: string): TranslationResult | undefined {
  const path = join(dir, reportJsonName(plugin));
  if (!existsSync(path)) return undefined;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { translation?: TranslationResult }).translation;
  } catch {
    return undefined;
  }
}

export function translationSummary(plugin: MigrationPlugin, t: TranslationResult, dir: string, written: string[]): string[] {
  const c = reportCounts(t.report);
  const out = [
    `Read ${plugin.label} configuration from ${t.origin}.`,
    `Wrote ${written.length - 2} config file(s) and the report to ${dir}: ${written.join(', ')}`,
    `${c.mapped} map 1:1, ${c.differs} map with a difference, ${c.manual} need a manual step (see ${join(dir, reportMd(plugin))}).`,
  ];
  if (t.env.length) out.push(`Set before applying: ${t.env.map((e) => e.name).join(', ')}`);
  for (const e of t.report.filter((x) => x.status === 'manual')) out.push(`  manual  ${where(e)}  ${e.note}`);
  return out;
}
