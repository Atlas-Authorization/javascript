/**
 * A tiny, dependency-free reader for the sanitised HTML a policy document is
 * served as (`content_html`). It turns the markup into {@link PolicyBlock}s
 * (paragraphs, headings, list items, quotes, rules) made of styled
 * {@link PolicySpan}s, which the native components draw as nested `<Text>`.
 *
 * Deliberately forgiving: tags it does not know are transparent (their text is
 * kept), `<script>` / `<style>` content is dropped, and only `http(s)` and
 * `mailto:` links survive. It never builds views from the markup, so nothing in
 * a document can run or load anything. Pure TypeScript, so it is unit-tested
 * without a device.
 */

export interface PolicySpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** The link target, only for safe schemes (`http`, `https`, `mailto`). */
  href?: string;
}

export interface PolicyBlock {
  kind: 'paragraph' | 'heading' | 'list_item' | 'quote' | 'rule';
  spans: PolicySpan[];
  /** 1 to 6 for a heading; otherwise 0. */
  level: number;
  /** The list marker (`•` or `1.`) for a list item. */
  marker?: string;
  /** List nesting depth, 0 for a top-level item. */
  depth: number;
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'pre', 'hr', 'br',
]);
const DROP_TAGS = new Set(['script', 'style', 'head', 'template', 'iframe', 'object', 'embed']);

/** Parse sanitised policy HTML into blocks. */
export function parsePolicyHtml(html: string): PolicyBlock[] {
  const blocks: PolicyBlock[] = [];
  let spans: PolicySpan[] = [];
  let kind: PolicyBlock['kind'] = 'paragraph';
  let level = 0;
  let marker: string | undefined;
  let depth = 0;
  let bold = 0;
  let italic = 0;
  let code = 0;
  let quote = 0;
  let dropUntil: string | null = null;
  const hrefs: Array<string | undefined> = [];
  const lists: Array<{ ordered: boolean; n: number }> = [];

  const flush = () => {
    const cleaned = spans.filter((s) => s.text.length > 0);
    if (cleaned.length > 0) {
      cleaned[0] = { ...cleaned[0]!, text: cleaned[0]!.text.replace(/^\s+/, '') };
      const last = cleaned.length - 1;
      cleaned[last] = { ...cleaned[last]!, text: cleaned[last]!.text.replace(/\s+$/, '') };
    }
    const kept = cleaned.filter((s) => s.text.length > 0);
    if (kept.length > 0) {
      const k = kind === 'paragraph' && quote > 0 ? 'quote' : kind;
      blocks.push({ kind: k, spans: kept, level, ...(marker ? { marker } : {}), depth });
    }
    spans = [];
    kind = 'paragraph';
    level = 0;
    marker = undefined;
    depth = 0;
  };

  const addText = (raw: string) => {
    if (!raw) return;
    let text = decodeEntities(raw).replace(/[ \t\r\n\f]+/g, ' ');
    if (!text) return;
    const prev = spans[spans.length - 1];
    if (prev && prev.text.endsWith(' ') && text.startsWith(' ')) text = text.slice(1);
    if (!prev && text.trim() === '') return;
    if (!text) return;
    const href = [...hrefs].reverse().find((h) => h !== undefined);
    spans.push({
      text,
      ...(bold > 0 ? { bold: true } : {}),
      ...(italic > 0 ? { italic: true } : {}),
      ...(code > 0 ? { code: true } : {}),
      ...(href ? { href } : {}),
    });
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      if (dropUntil === null) addText(html.slice(i));
      break;
    }
    if (lt > i && dropUntil === null) addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      // A stray "<": treat the rest as text.
      if (dropUntil === null) addText(html.slice(lt));
      break;
    }
    const inner = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!inner || inner[0] === '!' || inner[0] === '?') continue;
    const closing = inner[0] === '/';
    const body = closing ? inner.slice(1).trim() : inner;
    const name = (/^[^\s/]+/.exec(body)?.[0] ?? '').toLowerCase();
    if (!name) continue;
    if (dropUntil !== null) {
      if (closing && name === dropUntil) dropUntil = null;
      continue;
    }
    if (!closing && DROP_TAGS.has(name) && !body.endsWith('/')) {
      dropUntil = name;
      continue;
    }
    if (closing) {
      switch (name) {
        case 'strong': case 'b': if (bold > 0) bold--; break;
        case 'em': case 'i': if (italic > 0) italic--; break;
        case 'code': case 'kbd': case 'samp': case 'tt': if (code > 0) code--; break;
        case 'a': hrefs.pop(); break;
        case 'ul': case 'ol': flush(); lists.pop(); break;
        case 'blockquote': flush(); if (quote > 0) quote--; break;
        default: if (BLOCK_TAGS.has(name)) flush();
      }
      continue;
    }
    switch (name) {
      case 'strong': case 'b': bold++; break;
      case 'em': case 'i': italic++; break;
      case 'code': case 'kbd': case 'samp': case 'tt': code++; break;
      case 'a': hrefs.push(safeHref(attribute(body, 'href'))); break;
      case 'br': spans.push({ text: '\n', ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}) }); break;
      case 'hr': flush(); blocks.push({ kind: 'rule', spans: [], level: 0, depth: 0 }); break;
      case 'ul': case 'ol': flush(); lists.push({ ordered: name === 'ol', n: 0 }); break;
      case 'li': {
        flush();
        kind = 'list_item';
        depth = Math.max(0, lists.length - 1);
        const top = lists[lists.length - 1];
        if (top?.ordered) {
          top.n += 1;
          marker = `${top.n}.`;
        } else {
          marker = '•';
        }
        break;
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        flush();
        kind = 'heading';
        level = Number(name[1]);
        break;
      case 'blockquote': flush(); quote++; break;
      default: if (BLOCK_TAGS.has(name)) flush();
    }
  }
  flush();
  return blocks;
}

/** Plain text of a document, one block per line (accessibility labels and tests). */
export function policyPlainText(html: string): string {
  return parsePolicyHtml(html)
    .map((b) => (b.marker ? `${b.marker} ` : '') + b.spans.map((s) => s.text).join(''))
    .join('\n');
}

function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function safeHref(href: string | undefined): string | undefined {
  const h = href?.trim();
  if (!h) return undefined;
  const lower = h.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:') ? h : undefined;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©',
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return codePoint(parseInt(e.slice(2), 16), whole);
    if (e.startsWith('#')) return codePoint(parseInt(e.slice(1), 10), whole);
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

function codePoint(cp: number, fallback: string): string {
  if (!Number.isFinite(cp)) return fallback;
  return cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
}
