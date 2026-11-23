/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any> & { id: string };

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Random id with the same prefix convention as Atlas (`user_01…`). Time-ordered, so newest sorts last. */
export function newId(prefix: string, now: number): string {
  let t = '';
  for (let n = Math.floor(now), i = 0; i < 10; i++, n = Math.floor(n / 32)) t = ALPHABET[n % 32] + t;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (const b of bytes) r += ALPHABET[b % 32];
  return `${prefix}_${t}${r}`;
}

export const randomToken = (bytes = 24): string => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** An insertion-ordered in-memory table. Lists are newest first, like the API. */
export class Table<T extends Row = Row> {
  private readonly map = new Map<string, T>();
  constructor(
    readonly name: string,
    private readonly nowFn: () => number,
    private readonly prefix: string,
  ) {}

  insert(data: Omit<T, 'id'> & { id?: string }): T {
    const row = { ...data, id: data.id ?? newId(this.prefix, this.nowFn()) } as T;
    this.map.set(row.id, row);
    return row;
  }
  get(id: string | undefined): T | undefined {
    return id === undefined ? undefined : this.map.get(id);
  }
  update(id: string, patch: Partial<T>): T | undefined {
    const row = this.map.get(id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  }
  delete(id: string): boolean {
    return this.map.delete(id);
  }
  all(): T[] {
    return [...this.map.values()].reverse();
  }
  find(pred: (r: T) => boolean): T | undefined {
    for (const r of this.map.values()) if (pred(r)) return r;
    return undefined;
  }
  filter(pred: (r: T) => boolean): T[] {
    return this.all().filter(pred);
  }
  some(pred: (r: T) => boolean): boolean {
    return this.find(pred) !== undefined;
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

export interface PageOptions {
  limit: number;
  startingAfter?: string;
}

/** Cursor pagination over a newest-first array: the cursor is the last id of the previous page. */
export function paginate<T extends { id: string }>(items: T[], { limit, startingAfter }: PageOptions) {
  let start = 0;
  if (startingAfter) {
    const at = items.findIndex((i) => i.id === startingAfter);
    start = at < 0 ? items.length : at + 1;
  }
  const data = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  return { data, has_more: hasMore, next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
}
