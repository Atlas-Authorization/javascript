/**
 * A small RFC 4180 CSV reader for vendor exports: quoted fields, doubled quotes,
 * embedded commas and newlines, CRLF. Returns one object per data row keyed by
 * the header row. No dependency, because the CLI ships none it does not need.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);

  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return data.map((cells) => {
    const out: Record<string, string> = {};
    keys.forEach((k, idx) => {
      out[k] = cells[idx] ?? '';
    });
    return out;
  });
}
