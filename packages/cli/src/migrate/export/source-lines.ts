import type { ReportStatus } from '../framework/plugin';
import type { ConfigBuilder } from './translate-kit';

/**
 * Report lines that point at a config FILE the owner keeps (appwrite.json,
 * nhost.toml, pb_schema.json): the 1-based line a setting sits on, so the
 * report reads `nhost/nhost.toml:42` instead of a bare setting path.
 */

/**
 * The line of a JSON key path (`["settings", "auth", "security", "duration"]`)
 * in a JSON text, found by walking the quoted keys in order. Undefined when a
 * key is missing (the report then names only the setting path).
 */
export function jsonKeyLine(text: string, path: string[]): number | undefined {
  let at = 0;
  for (const key of path) {
    const i = text.indexOf(`"${key}"`, at);
    if (i < 0) return undefined;
    at = i + key.length + 2;
  }
  return lineAt(text, at);
}

/** The 1-based line of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Add a report line with a file location (when the line is known). */
export function addAt(b: ConfigBuilder, file: string | undefined, line: number | undefined, status: ReportStatus, area: string, setting: string, note: string, atlas?: string): void {
  b.add(status, area, setting, note, atlas);
  if (file && line) {
    const entry = b.report[b.report.length - 1]!;
    entry.file = file;
    entry.line = line;
  }
}
