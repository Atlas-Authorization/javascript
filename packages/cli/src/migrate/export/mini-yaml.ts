/**
 * A small, dependency-free reader for the YAML subset vendor config files use
 * (kratos.yml, hydra.yml, Hanko's config.yaml, SuperTokens' config.yaml,
 * authentik blueprints): block mappings and sequences (including `- key: v`
 * items), plain / single- / double-quoted scalars, numbers, booleans, null,
 * `#` comments, simple flow collections (`[a, b]`, `{a: 1}`), `|` / `>` block
 * scalars and a leading `---` (the first document only). Anchors, aliases and
 * tags are not resolved: a tag (`!!str`) is skipped, an anchor (`&a`) dropped.
 *
 * Every mapping key and sequence item remembers its 1-based source line so a
 * translator can cite `kratos.yml:42` for the setting it read.
 */
export interface YamlDoc {
  value: unknown;
  /** 1-based source line of a dotted path (`selfservice.methods.password.enabled`, sequence items as `providers.0.id`), when known. */
  line(path: string): number | undefined;
}

interface Row {
  no: number;
  indent: number;
  /** The line without its indentation, trailing whitespace trimmed. */
  text: string;
  raw: string;
  tab: boolean;
}

const fail = (no: number, message: string): Error => new Error(`YAML line ${no}: ${message}`);
const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const isSeqItem = (text: string): boolean => /^-(\s|$)/.test(text);

/** Parse the first YAML document in `text`. Throws an Error naming the line on malformed input. */
export function parseYaml(text: string): YamlDoc {
  const src = text.replace(/^\ufeff/, '').split(/\r?\n/);
  const rows: Row[] = [];
  let content = false;
  let marker = false;
  for (let k = 0; k < src.length; k++) {
    const raw = src[k]!;
    const no = k + 1;
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) {
      if (content || marker) break;
      if (raw.startsWith('...')) continue;
      marker = true;
      const rest = raw.slice(3).trim();
      if (rest && !rest.startsWith('#')) {
        rows.push(row(no, `    ${rest}`));
        content = true;
      }
      continue;
    }
    if (!content && !marker && raw.startsWith('%')) continue;
    const r = row(no, raw);
    if (r.text && !r.text.startsWith('#')) content = true;
    rows.push(r);
  }
  const parser = new Parser(rows);
  const value = parser.document();
  return { value, line: (path) => parser.lines.get(path) };
}

function row(no: number, raw: string): Row {
  const lead = /^[ \t]*/.exec(raw)![0];
  return { no, indent: lead.length, text: raw.slice(lead.length).trimEnd(), raw, tab: lead.includes('\t') };
}

class Parser {
  readonly lines = new Map<string, number>();
  private pos = 0;

  constructor(private readonly rows: Row[]) {}

  document(): unknown {
    const first = this.peek();
    if (!first) return null;
    const value = this.node(0, '');
    const rest = this.peek();
    if (rest) throw fail(rest.no, 'unexpected content (check the indentation)');
    return value;
  }

  /** The next significant row (blank and comment lines skipped), not consumed. */
  private peek(): Row | undefined {
    while (this.pos < this.rows.length) {
      const r = this.rows[this.pos]!;
      if (r.text === '' || r.text.startsWith('#')) {
        this.pos++;
        continue;
      }
      if (r.tab) throw fail(r.no, 'tabs are not allowed in indentation');
      return r;
    }
    return undefined;
  }

  /** A node starting on the next row, indented at least `min`. */
  private node(min: number, path: string): unknown {
    const r = this.peek();
    if (!r || r.indent < min) return null;
    if (isSeqItem(r.text)) return this.sequence(r.indent, path);
    if (splitKey(r.text, r.no)) return this.mapping(r.indent, path);
    this.pos++;
    return this.inline(r, r.text, min - 1, path);
  }

  private mapping(indent: number, path: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const r = this.peek();
      if (!r || r.indent < indent) break;
      if (r.indent > indent) throw fail(r.no, 'unexpected indentation');
      if (isSeqItem(r.text)) throw fail(r.no, 'a sequence item where a mapping key was expected');
      const kv = splitKey(r.text, r.no);
      if (!kv) throw fail(r.no, 'expected "key: value"');
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw fail(r.no, `duplicate key "${kv.key}"`);
      this.pos++;
      const p = join(path, kv.key);
      this.lines.set(p, r.no);
      assign(out, kv.key, this.value(r, kv.rest, indent, p, true));
    }
    return out;
  }

  private sequence(indent: number, path: string): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const r = this.peek();
      if (!r || r.indent < indent) break;
      if (r.indent > indent) throw fail(r.no, 'unexpected indentation');
      if (!isSeqItem(r.text)) break;
      const p = join(path, String(out.length));
      this.lines.set(p, r.no);
      const dash = /^-\s*/.exec(r.text)![0];
      const rest = r.text.slice(dash.length);
      if (rest && !rest.startsWith('#') && (isSeqItem(rest) || splitKey(rest, r.no))) {
        // `- key: v` / `- - x`: the rest of the line is the first row of a nested block at its own column
        this.rows[this.pos] = { ...r, indent: r.indent + dash.length, text: rest };
        out.push(this.node(r.indent + dash.length, p));
        continue;
      }
      this.pos++;
      out.push(this.value(r, rest, indent, p, false));
    }
    return out;
  }

  /** The value after `key:` or `- ` on row `r`: inline, or a nested block below. */
  private value(r: Row, rest: string, indent: number, path: string, inMapping: boolean): unknown {
    const props = stripProps(stripComment(rest).trim());
    if (props.text === '') {
      const next = this.peek();
      if (!next) return null;
      if (next.indent > indent) return this.node(indent + 1, path);
      // `key:` followed by `- item` at the key's own indentation
      if (inMapping && next.indent === indent && isSeqItem(next.text)) return this.sequence(indent, path);
      return null;
    }
    return this.inline(r, rest, indent, path);
  }

  /** A scalar, flow collection or block scalar starting in `text` on row `r`. */
  private inline(r: Row, text: string, parent: number, path: string): unknown {
    const { text: t, tag } = stripProps(stripComment(text).trim());
    if (t.startsWith('|') || t.startsWith('>')) return this.blockScalar(t, parent, r);
    if (t.startsWith('[') || t.startsWith('{')) {
      let buf = t;
      while (flowDepth(buf) !== 0) {
        const next = this.rows[this.pos];
        if (!next) throw fail(r.no, 'unterminated flow collection');
        this.pos++;
        buf += ` ${stripComment(next.text)}`;
      }
      const flow = new Flow(buf, r.no, (p) => this.lines.set(p, r.no));
      return flow.document(path);
    }
    if (t.startsWith('"') || t.startsWith("'")) {
      const quote = t[0]!;
      let buf = stripProps(text.trim()).text;
      let q = readQuoted(buf, 0, r.no);
      while (!q) {
        const next = this.rows[this.pos];
        if (!next) throw fail(r.no, 'unterminated quoted string');
        this.pos++;
        const piece = next.text.trim();
        if (piece === '') buf += '\n';
        else if (quote === '"' && /(^|[^\\])(\\\\)*\\$/.test(buf)) buf = buf.slice(0, -1) + piece;
        else buf += buf.endsWith('\n') ? piece : ` ${piece}`;
        q = readQuoted(buf, 0, r.no);
      }
      if (stripComment(buf.slice(q.end)).trim() !== '') throw fail(r.no, 'unexpected text after a quoted scalar');
      return q.value;
    }
    let s = t;
    for (;;) {
      const next = this.peek();
      if (!next || next.indent <= parent) break;
      if (splitKey(next.text, next.no)) throw fail(next.no, 'unexpected indentation');
      this.pos++;
      s += ` ${stripComment(next.text).trim()}`;
    }
    return resolvePlain(s, tag);
  }

  private blockScalar(header: string, parent: number, r: Row): string {
    const m = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?$/.exec(header);
    if (!m) throw fail(r.no, `bad block scalar header "${header}"`);
    const literal = m[1] === '|';
    const chomp = m[3] ?? m[4] ?? '';
    const explicit = m[2] ?? m[5];
    let blockIndent = explicit ? Math.max(parent, 0) + Number(explicit) : -1;
    const body: string[] = [];
    while (this.pos < this.rows.length) {
      const next = this.rows[this.pos]!;
      if (next.raw.trim() === '') {
        body.push('');
        this.pos++;
        continue;
      }
      const ind = /^ */.exec(next.raw)![0].length;
      if (blockIndent < 0) {
        if (ind <= parent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      body.push(next.raw.slice(blockIndent).trimEnd());
      this.pos++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    const s = literal ? body.join('\n') : fold(body);
    if (chomp === '-') return s;
    if (chomp === '+') return `${s}\n${'\n'.repeat(trailing)}`;
    return `${s}\n`;
  }
}

/** Folded (`>`) block content: single line breaks become spaces, blank lines stay breaks, more-indented lines keep theirs. */
function fold(lines: string[]): string {
  let out = '';
  let started = false;
  let blanks = 0;
  let prevMore = false;
  for (const l of lines) {
    if (l === '') {
      blanks++;
      continue;
    }
    const more = /^[ \t]/.test(l);
    if (!started) out = '\n'.repeat(blanks) + l;
    else if (blanks) out += (prevMore || more ? '\n' : '') + '\n'.repeat(blanks) + l;
    else out += (prevMore || more ? '\n' : ' ') + l;
    started = true;
    blanks = 0;
    prevMore = more;
  }
  return out;
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  else out[key] = value;
}

/** Strip a leading tag (`!!str`, `!custom`) and anchor (`&name`); the tag is returned for scalar resolution. */
function stripProps(text: string): { text: string; tag?: string } {
  let t = text;
  let tag: string | undefined;
  for (;;) {
    const m = /^(!\S*|&\S+)(\s+|$)/.exec(t);
    if (!m) break;
    if (m[1]!.startsWith('!')) tag = m[1];
    t = t.slice(m[0].length);
  }
  return tag ? { text: t, tag } : { text: t };
}

/** Whether a quote at `i` opens a quoted scalar (at the start of a value), not an apostrophe inside a plain one. */
function quoteOpens(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (s[j] === ' ' || s[j] === '\t')) j--;
  if (j < 0) return true;
  const c = s[j]!;
  if (c === '[' || c === '{' || c === ',') return true;
  return (c === ':' || c === '-' || c === '?') && j < i - 1;
}

/** `value # comment` → `value`, leaving `#` inside quotes and inside plain words (`a#b`) alone. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') {
        i++;
        continue;
      }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") {
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && quoteOpens(s, i)) {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i).trimEnd();
  }
  return s;
}

/** Bracket depth left open at the end of `s` (quotes respected); -1 inside an open quote. */
function flowDepth(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && quoteOpens(s, i)) quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return quote ? -1 : depth;
}

/** `key: rest` → the key (unquoted) and the text after the colon; null when the row is not a mapping entry. */
function splitKey(text: string, no: number): { key: string; rest: string } | null {
  if (text.startsWith('[') || text.startsWith('{') || isSeqItem(text)) return null;
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = readQuoted(text, 0, no);
    if (!q) return null;
    const m = /^[ \t]*:(?=\s|$)/.exec(text.slice(q.end));
    return m ? { key: q.value, rest: text.slice(q.end + m[0].length) } : null;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '#' && i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) return null;
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      const key = text.slice(0, i).trim();
      return key ? { key, rest: text.slice(i + 1) } : null;
    }
  }
  return null;
}

const ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: ' ',
  P: ' ',
};

/** A quoted scalar starting at `start`: its value and the index after the closing quote, or null when unterminated. */
function readQuoted(s: string, start: number, no: number): { value: string; end: number } | null {
  const quote = s[start];
  let out = '';
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const e = s[i + 1];
    if (e === undefined) return null;
    const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (width) {
      const hex = s.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw fail(no, `bad escape "\\${e}${hex}"`);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 2 + width;
      continue;
    }
    const mapped = ESCAPES[e];
    if (mapped === undefined) throw fail(no, `bad escape "\\${e}"`);
    out += mapped;
    i += 2;
  }
  return null;
}

/** A plain scalar's value: null / booleans / numbers per the YAML core schema, otherwise the string. */
function resolvePlain(s: string, tag?: string): unknown {
  if (tag === '!!str') return s;
  if (tag === '!!int' || tag === '!!float') return Number(s);
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/** A flow collection (`[a, {b: 1}]`) on one logical line. */
class Flow {
  private i = 0;

  constructor(
    private readonly s: string,
    private readonly no: number,
    private readonly record: (path: string) => void,
  ) {}

  document(path: string): unknown {
    const v = this.value(path);
    this.ws();
    if (this.i < this.s.length) throw fail(this.no, `unexpected "${this.s.slice(this.i)}" after a flow collection`);
    return v;
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  private value(path: string): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq(path);
    if (c === '{') return this.map(path);
    if (c === '"' || c === "'") {
      const q = readQuoted(this.s, this.i, this.no);
      if (!q) throw fail(this.no, 'unterminated quoted string');
      this.i = q.end;
      return q.value;
    }
    const start = this.i;
    while (this.i < this.s.length && !',]}'.includes(this.s[this.i]!)) this.i++;
    const { text, tag } = stripProps(this.s.slice(start, this.i).trim());
    return resolvePlain(text, tag);
  }

  private seq(path: string): unknown[] {
    const out: unknown[] = [];
    this.i++;
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      const p = join(path, String(out.length));
      this.record(p);
      out.push(this.value(p));
      this.ws();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c !== ']') throw fail(this.no, 'expected "," or "]" in a flow sequence');
    }
  }

  private map(path: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) throw fail(this.no, 'unterminated flow mapping');
      let key: string;
      const c = this.s[this.i];
      if (c === '"' || c === "'") {
        const q = readQuoted(this.s, this.i, this.no);
        if (!q) throw fail(this.no, 'unterminated quoted string');
        this.i = q.end;
        key = q.value;
      } else {
        const start = this.i;
        while (this.i < this.s.length) {
          const ch = this.s[this.i]!;
          if (ch === ',' || ch === '}' || ch === ']') break;
          if (ch === ':' && (this.i + 1 >= this.s.length || /[\s,}\]]/.test(this.s[this.i + 1]!))) break;
          this.i++;
        }
        key = this.s.slice(start, this.i).trim();
      }
      this.ws();
      const p = join(path, key);
      this.record(p);
      let v: unknown = null;
      if (this.s[this.i] === ':') {
        this.i++;
        this.ws();
        v = this.s[this.i] === ',' || this.s[this.i] === '}' ? null : this.value(p);
      }
      assign(out, key, v);
      this.ws();
      const d = this.s[this.i];
      if (d === ',') this.i++;
      else if (d !== '}') throw fail(this.no, 'expected "," or "}" in a flow mapping');
    }
  }
}
