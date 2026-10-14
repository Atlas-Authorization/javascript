import { describe, expect, it } from 'vitest';
import { captureIO } from './io';
import { fmtTime, printList, renderTable, type Column } from './output';

interface Row {
  id: string;
  name: string | null;
  created_at: number;
}

const COLUMNS: Column<Row>[] = [
  { header: 'ID', get: (r) => r.id },
  { header: 'NAME', get: (r) => r.name },
  { header: 'CREATED', get: (r) => fmtTime(r.created_at) },
];

describe('renderTable', () => {
  it('renders a header, a rule, and one line per row', () => {
    const table = renderTable(COLUMNS, [
      { id: 'u_1', name: 'Ada', created_at: 0 },
      { id: 'u_2', name: null, created_at: 0 },
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('ID');
    expect(lines[0]).toContain('NAME');
    expect(lines[1]).toMatch(/^-+/);
    expect(lines[2]).toContain('u_1');
    expect(lines[2]).toContain('Ada');
    // A null cell renders blank, not the string "null".
    expect(lines[3]).toContain('u_2');
    expect(lines[3]).not.toContain('null');
  });

  it('prints a placeholder for an empty result set', () => {
    expect(renderTable(COLUMNS, [])).toBe('(no results)');
  });
});

describe('fmtTime', () => {
  it('formats epoch ms as ISO and blanks null', () => {
    expect(fmtTime(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(fmtTime(null)).toBe('');
  });
});

describe('printList', () => {
  const page = { data: [{ id: 'u_1', name: 'Ada', created_at: 0 }], has_more: true, next_cursor: 'u_1' };

  it('emits raw JSON under --json', () => {
    const io = captureIO();
    printList(io, { json: true, columns: COLUMNS }, page);
    expect(JSON.parse(io.stdout())).toEqual(page);
  });

  it('prints a table plus a next-page hint when there is more', () => {
    const io = captureIO();
    printList(io, { json: false, columns: COLUMNS }, page);
    expect(io.stdout()).toContain('u_1');
    expect(io.stdout()).toContain('--starting-after u_1');
  });
});
