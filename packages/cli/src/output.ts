import type { IO } from './io';

/**
 * A single rendered column: a header plus a getter that pulls the raw value off
 * a row. Getters (not keys) because a few columns are derived — a user's name
 * joins first + last, a webhook's events join an array — and a getter keeps that
 * shaping next to the column instead of forcing a pre-massaged row.
 */
export interface Column<T> {
  header: string;
  get: (row: T) => unknown;
}

/** Render a value as a table cell: null/undefined blank, arrays joined, objects JSON. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => cell(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Epoch-millisecond timestamp → ISO-8601, the form every Atlas `*_at` field
 * takes on the wire. Blank for null (e.g. a user who never signed in) so the
 * column stays readable rather than printing `1970-...`.
 */
export function fmtTime(value: unknown): string {
  if (value === null || value === undefined) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return new Date(n).toISOString();
}

/**
 * Hand-rolled fixed-width table — the only "formatting library" this CLI has.
 * Columns are padded to the widest cell (header included); a dashed rule sits
 * under the header; trailing padding on the last column is trimmed so lines
 * don't carry invisible whitespace. Empty input prints a friendly placeholder
 * rather than a bare header with no rows.
 */
export function renderTable<T>(columns: Column<T>[], rows: T[]): string {
  if (rows.length === 0) return '(no results)';

  const matrix = rows.map((row) => columns.map((col) => cell(col.get(row))));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...matrix.map((r) => r[i]!.length)),
  );

  const pad = (text: string, width: number) => text.padEnd(width);
  const line = (fields: string[]) =>
    fields.map((f, i) => pad(f, widths[i]!)).join('  ').replace(/\s+$/, '');

  const lines = [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '-'.repeat(w))),
    ...matrix.map((r) => line(r)),
  ];
  return lines.join('\n');
}

/** Pretty-print any value as the `--json` output on stdout. */
export function printJson(io: IO, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/**
 * Print a cursor-paginated list as either raw JSON or a table, and — in table
 * mode, when there is another page — a footer naming the exact flag to fetch
 * it. Keeping the hint next to the data is what makes `--starting-after`
 * discoverable without the user reading `--help`.
 */
export function printList<T>(
  io: IO,
  opts: { json: boolean; columns: Column<T>[] },
  page: { data: T[]; has_more?: boolean; next_cursor?: string | null },
  raw: unknown = page,
): void {
  if (opts.json) {
    printJson(io, raw);
    return;
  }
  io.out(renderTable(opts.columns, page.data));
  if (page.has_more && page.next_cursor) {
    io.out('');
    io.out(`More results — fetch the next page with: --starting-after ${page.next_cursor}`);
  }
}
