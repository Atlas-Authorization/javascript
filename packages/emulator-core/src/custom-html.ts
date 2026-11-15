import { EmulatorError } from './errors';

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Custom hosted HTML and CSS for a page template region (the `custom` component).
 *
 * The author's markup is never trusted, and never placed in the sign-in page itself. Three layers, each enough on its own:
 *
 *  1. Allowlist sanitizer (this file). Only the tags, attributes and CSS properties below survive; there is no script, no style
 *     attribute, no event handler, no form control, no iframe, no object, no SVG, no `url()`, no import and no custom property.
 *     Links and images are https (links also mailto) only. A write that contains anything else is refused with the reason;
 *     the same function runs again, leniently (dropping what it does not allow), every time the template is rendered, so a
 *     row that was edited in the database is just as safe.
 *  2. Server-side render into a sandboxed iframe (`srcdoc`): `sandbox` without `allow-scripts` or `allow-same-origin`, so the
 *     frame has an opaque origin and cannot touch the sign-in form, read its fields, restyle it, or draw over it.
 *  3. A content-security-policy inside the frame that allows no script, no connection, no form post and no base element, and
 *     images from https only.
 *
 * Template variables are a fixed list substituted into text (never into attributes), HTML-escaped.
 *
 * This is the same allowlist, tokenizer and CSS rules the Atlas API applies (copied, not imported: the emulator has no dependency on the
 * server packages), so a block that is refused here is refused in production for the same reason.
 */

export const MAX_CUSTOM_HTML_BYTES = 16 * 1024;
export const MAX_CUSTOM_CSS_BYTES = 8 * 1024;
export const MAX_CUSTOM_TAGS = 300;
export const CUSTOM_MIN_HEIGHT = 40;
export const CUSTOM_MAX_HEIGHT = 1200;
/** The variables a custom block may use as `{{name}}` in text. */
export const CUSTOM_VARIABLES = ['year', 'locale'] as const;
export type CustomVariables = Partial<Record<(typeof CUSTOM_VARIABLES)[number], string>>;

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup',
  'blockquote', 'section', 'header', 'footer', 'nav', 'article', 'aside', 'main', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'pre', 'code', 'dl', 'dt', 'dd', 'address', 'mark', 'abbr', 'cite', 'q', 'time',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
/** Tags whose content must never be kept as text when the tag itself is dropped. */
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math', 'select', 'option', 'audio', 'video', 'canvas', 'applet', 'head']);

const SAFE_HTTPS = /^https:\/\/[^\s"'<>`\\]{1,2000}$/;
const SAFE_MAILTO = /^mailto:[^\s@"'<>`\\]+@[^\s@"'<>`\\]+$/;
const GLOBAL_ATTRS = new Set(['class', 'title', 'lang', 'dir', 'aria-label', 'aria-hidden']);
const TAG_ATTRS: Record<string, string[]> = { a: ['href'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], time: ['datetime'] };
/** Attributes the renderer sets itself; an author's value is ignored (not an error). */
const IGNORED_ATTRS = new Set(['target', 'rel', 'loading', 'referrerpolicy']);

const ENTITY = /^&(?:[A-Za-z][A-Za-z0-9]{1,31}|#\d{1,7}|#x[0-9A-Fa-f]{1,6});/;

/** Text safe between tags: markup characters become entities; a valid entity (`&amp;`, `&#169;`) is kept. */
function escapeText(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '&') {
      const m = ENTITY.exec(t.slice(i, i + 40));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
      } else out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '\u0000') continue;
    else out += c;
  }
  return out;
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export interface Sanitized {
  out: string;
  /** What was not allowed. Empty means the input was already clean. */
  problems: string[];
}

interface Attr {
  name: string;
  value: string | null;
}

/** Parse the attributes of an open tag starting after its name. Returns null when the tag never ends. */
function readAttrs(src: string, from: number): { attrs: Attr[]; end: number; selfClose: boolean } | null {
  const attrs: Attr[] = [];
  let i = from;
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) return null;
    if (src[i] === '>') return { attrs, end: i + 1, selfClose: false };
    if (src[i] === '/' && src[i + 1] === '>') return { attrs, end: i + 2, selfClose: true };
    if (src[i] === '/') {
      i++;
      continue;
    }
    const nm = /^[^\s"'<>\/=]+/.exec(src.slice(i, i + 200));
    if (!nm) {
      // A stray quote or "=" with no name: skip the character.
      i++;
      continue;
    }
    i += nm[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    let value: string | null = null;
    if (src[i] === '=') {
      i++;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1);
        if (close === -1) return null;
        value = src.slice(i + 1, close);
        i = close + 1;
      } else {
        const m = /^[^\s"'=<>`]+/.exec(src.slice(i, i + 2100));
        value = m ? m[0] : '';
        i += value.length;
      }
    }
    attrs.push({ name: nm[0].toLowerCase(), value });
  }
}

/**
 * Reduce markup to the allowlist. Returns the clean markup and every problem found (a tag, attribute or value that was
 * dropped). `vars` substitutes `{{year}}` / `{{locale}}` in text (escaped); an unknown `{{name}}` is a problem.
 */
export function sanitizeCustomHtml(input: string, opts: { vars?: CustomVariables } = {}): Sanitized {
  const problems: string[] = [];
  const note = (m: string) => {
    if (problems.length < 20 && !problems.includes(m)) problems.push(m);
  };
  if (input.length > MAX_CUSTOM_HTML_BYTES) {
    note(`html is larger than ${MAX_CUSTOM_HTML_BYTES / 1024} KB.`);
    input = input.slice(0, MAX_CUSTOM_HTML_BYTES);
  }
  let out = '';
  const stack: string[] = [];
  let tags = 0;
  let i = 0;
  let skip: string | null = null; // inside a dropped raw-content element
  const text = (raw: string) => {
    if (skip) return;
    const escaped = escapeText(raw);
    out += escaped.replace(VAR_RE, (whole, name: string) => {
      if (!(CUSTOM_VARIABLES as readonly string[]).includes(name)) {
        note(`{{${name}}} is not a variable. Available: ${CUSTOM_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`);
        return '';
      }
      const v = opts.vars?.[name as (typeof CUSTOM_VARIABLES)[number]];
      return v === undefined ? whole : escapeHtml(v);
    });
  };
  while (i < input.length) {
    if (input[i] !== '<') {
      const next = input.indexOf('<', i);
      const end = next === -1 ? input.length : next;
      text(input.slice(i, end));
      i = end;
      continue;
    }
    if (input.startsWith('<!--', i)) {
      const close = input.indexOf('-->', i + 4);
      i = close === -1 ? input.length : close + 3;
      continue;
    }
    if (input[i + 1] === '!' || input[i + 1] === '?') {
      note('Declarations, CDATA and processing instructions are not allowed.');
      const close = input.indexOf('>', i);
      i = close === -1 ? input.length : close + 1;
      continue;
    }
    const closeTag = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>/.exec(input.slice(i, i + 80));
    if (closeTag) {
      const name = closeTag[1]!.toLowerCase();
      i += closeTag[0].length;
      if (skip) {
        if (name === skip) skip = null;
        continue;
      }
      const at = stack.lastIndexOf(name);
      if (at === -1) {
        if (ALLOWED_TAGS.has(name)) note(`Unmatched </${name}>.`);
        continue;
      }
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    const open = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(input.slice(i, i + 80));
    if (!open) {
      text('<');
      i += 1;
      continue;
    }
    const name = open[1]!.toLowerCase();
    const parsed = readAttrs(input, i + open[0].length);
    if (!parsed) {
      note('A tag is never closed.');
      break;
    }
    i = parsed.end;
    if (skip) continue;
    if (!ALLOWED_TAGS.has(name)) {
      note(`<${name}> is not allowed.`);
      if (DROP_CONTENT.has(name) && !parsed.selfClose && !VOID_TAGS.has(name)) skip = name;
      continue;
    }
    if (++tags > MAX_CUSTOM_TAGS) {
      note(`At most ${MAX_CUSTOM_TAGS} tags.`);
      break;
    }
    const allowed = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[name] ?? [])]);
    let html = `<${name}`;
    let hasAlt = false;
    const seen = new Set<string>();
    for (const a of parsed.attrs) {
      if (IGNORED_ATTRS.has(a.name) || seen.has(a.name)) continue;
      if (!allowed.has(a.name)) {
        note(`The ${a.name} attribute is not allowed on <${name}>${a.name === 'style' ? ' (put CSS in the css field)' : ''}.`);
        continue;
      }
      const v = a.value ?? '';
      let ok = true;
      switch (a.name) {
        case 'class':
          ok = /^[A-Za-z0-9_ -]{1,200}$/.test(v);
          break;
        case 'title':
        case 'alt':
        case 'aria-label':
          ok = v.length <= 300 && !v.includes('\u0000');
          break;
        case 'lang':
          ok = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v);
          break;
        case 'dir':
          ok = v === 'ltr' || v === 'rtl' || v === 'auto';
          break;
        case 'aria-hidden':
          ok = v === 'true' || v === 'false';
          break;
        case 'href':
          ok = SAFE_HTTPS.test(v) || SAFE_MAILTO.test(v);
          break;
        case 'src':
          ok = SAFE_HTTPS.test(v);
          break;
        case 'width':
        case 'height':
          ok = /^\d{1,4}$/.test(v) && Number(v) <= 2000;
          break;
        case 'colspan':
        case 'rowspan':
          ok = /^\d{1,2}$/.test(v) && Number(v) >= 1;
          break;
        case 'datetime':
          ok = /^[0-9TZ:+.\- ]{1,40}$/.test(v);
          break;
      }
      if (!ok) {
        note(`${a.name} on <${name}> has a value that is not allowed${a.name === 'href' || a.name === 'src' ? ' (https only; links may also be mailto:)' : ''}.`);
        continue;
      }
      seen.add(a.name);
      if (a.name === 'alt') hasAlt = true;
      html += ` ${a.name}="${escapeHtml(v)}"`;
    }
    if (name === 'img') {
      if (!hasAlt) {
        note('<img> needs an alt attribute (use alt="" for a decorative image).');
        html += ' alt=""';
      }
      if (!parsed.attrs.some((a) => a.name === 'src' && a.value && SAFE_HTTPS.test(a.value))) {
        // An image with no valid source draws nothing: drop it.
        note('<img> needs an https src.');
        continue;
      }
      html += ' loading="lazy" referrerpolicy="no-referrer"';
    }
    if (name === 'a') html += ' target="_blank" rel="noopener noreferrer"';
    html += '>';
    out += html;
    if (!VOID_TAGS.has(name) && !parsed.selfClose) stack.push(name);
    else if (!VOID_TAGS.has(name) && parsed.selfClose) out += `</${name}>`;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return { out, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// CSS

const BOX = (p: string) => [p, `${p}-top`, `${p}-right`, `${p}-bottom`, `${p}-left`];
const ALLOWED_PROPS = new Set([
  'color', 'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'text-indent', 'text-shadow',
  'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'list-style', 'list-style-type',
  ...BOX('margin'), ...BOX('padding'), ...BOX('border'), 'border-width', 'border-style', 'border-color', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'box-sizing', 'aspect-ratio', 'object-fit',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'gap', 'row-gap', 'column-gap',
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'opacity', 'box-shadow', 'overflow', 'float', 'clear',
]);
const ENUM_PROPS: Record<string, string[]> = {
  display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none'],
  overflow: ['visible', 'hidden', 'auto'],
  float: ['left', 'right', 'none'],
  clear: ['left', 'right', 'both', 'none'],
};
const ALLOWED_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient', 'repeat', 'minmax']);
const VALUE_CHARS = /^[#A-Za-z0-9%.,\s\-+*/()"']*$/;
const COMPOUND = /^(?:\*|[a-z][a-z0-9]*)?(?:\.[A-Za-z_][A-Za-z0-9_-]*|:(?:hover|focus|active|first-child|last-child|first-of-type|last-of-type|nth-child\((?:\d{1,3}|odd|even)\)))*$/;
const MEDIA = /^@media\s+(?:screen\s+and\s+)?\(\s*(?:(?:max|min)-width\s*:\s*\d{1,4}px|prefers-color-scheme\s*:\s*(?:dark|light))\s*\)(?:\s+and\s+\(\s*(?:max|min)-width\s*:\s*\d{1,4}px\s*\))?$/i;

function cssValueProblem(prop: string, value: string): string | null {
  if (!value || value.length > 300) return 'value is empty or too long';
  for (const m of value.toLowerCase().matchAll(/([a-z-]+)\s*\(/g)) if (!ALLOWED_FUNCTIONS.has(m[1]!)) return `${m[1]}() is not allowed`;
  if (/(?:^|[^a-z])(?:url|expression|javascript|behavior|image-set|attr|var|env)(?![a-z-])/i.test(value)) return 'value is not allowed';
  if (!VALUE_CHARS.test(value)) return 'value has a character that is not allowed';
  const en = ENUM_PROPS[prop];
  if (en && !en.includes(value.toLowerCase())) return `${prop} must be one of ${en.join(', ')}`;
  return null;
}

/** A compound selector's element name, when it has one, must be a tag the markup may use (or body / html). */
function tagOk(compound: string): boolean {
  const tag = /^[a-z][a-z0-9]*/.exec(compound)?.[0];
  return !tag || tag === 'body' || tag === 'html' || ALLOWED_TAGS.has(tag);
}

function sanitizeRules(css: string, note: (m: string) => void, inMedia: boolean): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) {
      const rest = css.slice(i).trim();
      if (rest) note(rest.startsWith('@') ? `${rest.split(/[\s(]/)[0]} is not allowed (only @media with max-width, min-width or prefers-color-scheme).` : 'A rule has no block.');
      break;
    }
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    if (depth !== 0) {
      note('A block is never closed.');
      break;
    }
    const body = css.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) {
      if (inMedia || !MEDIA.test(prelude.replace(/\s+/g, ' '))) {
        note(`${prelude.split(/[\s(]/)[0]} is not allowed (only @media with max-width, min-width or prefers-color-scheme).`);
        continue;
      }
      const inner = sanitizeRules(body, note, true);
      if (inner) out += `${prelude.replace(/\s+/g, ' ')}{${inner}}`;
      continue;
    }
    const selectors: string[] = [];
    let selectorsOk = prelude.length > 0 && prelude.length <= 300 && /^[A-Za-z0-9_\-.\s,>+~:*()]+$/.test(prelude);
    if (selectorsOk) {
      for (const sel of prelude.split(',')) {
        const norm = sel.replace(/\s*([>+~])\s*/g, ' $1 ').trim().split(/\s+/);
        const good = norm.length > 0 && norm.every((tok, k) => (/^[>+~]$/.test(tok) ? k > 0 && k < norm.length - 1 && !/^[>+~]$/.test(norm[k - 1]!) : COMPOUND.test(tok) && tagOk(tok)));
        if (!good) {
          selectorsOk = false;
          break;
        }
        selectors.push(norm.join(' ').replace(/ ([>+~]) /g, '$1'));
      }
    }
    if (!selectorsOk) {
      note(`Selector "${prelude.slice(0, 60)}" is not allowed (classes, allowed tags, :hover, :focus, :first-child, :last-child, combinators).`);
      continue;
    }
    const decls: string[] = [];
    for (const raw of body.split(';')) {
      const d = raw.trim();
      if (!d) continue;
      const colon = d.indexOf(':');
      const prop = colon === -1 ? '' : d.slice(0, colon).trim().toLowerCase();
      const value = colon === -1 ? '' : d.slice(colon + 1).trim();
      if (!ALLOWED_PROPS.has(prop)) {
        note(`The CSS property "${prop || d.slice(0, 30)}" is not allowed.`);
        continue;
      }
      const bad = cssValueProblem(prop, value);
      if (bad) {
        note(`${prop}: ${bad}.`);
        continue;
      }
      decls.push(`${prop}:${value.replace(/\s+/g, ' ')}`);
    }
    if (decls.length) out += `${selectors.join(',')}{${decls.join(';')}}`;
  }
  return out;
}

/** Reduce CSS to the allowlist: class/tag selectors, a fixed property list, no url(), no imports, no custom properties. */
export function sanitizeCustomCss(input: string): Sanitized {
  const problems: string[] = [];
  const note = (m: string) => {
    if (problems.length < 20 && !problems.includes(m)) problems.push(m);
  };
  if (input.length > MAX_CUSTOM_CSS_BYTES) {
    note(`css is larger than ${MAX_CUSTOM_CSS_BYTES / 1024} KB.`);
    input = input.slice(0, MAX_CUSTOM_CSS_BYTES);
  }
  if (input.includes('\\')) note('Backslash escapes are not allowed in css.');
  const stripped = input.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\\/g, '');
  const open = stripped.indexOf('/*');
  if (open !== -1) note('A comment is never closed.');
  return { out: sanitizeRules(open === -1 ? stripped : stripped.slice(0, open), note, false), problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// The sandboxed frame

/** The policy inside the frame: nothing runs, nothing connects, nothing posts; images from https only; no base element. */
export const CUSTOM_FRAME_CSP = "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** The `sandbox` attribute value: popups only (for links), and never scripts, forms or the page's origin. */
export const CUSTOM_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

const FRAME_BASE_CSS = 'html,body{margin:0;padding:0}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;color:#1f2937;background:transparent;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#2563eb}';

/** The complete document placed in the iframe. `html` and `css` must already be sanitized. */
export function customFrameDocument(html: string, css: string, lang: string): string {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CUSTOM_FRAME_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${FRAME_BASE_CSS}</style>${css ? `<style>${css}</style>` : ''}</head><body>${html}</body></html>`;
}

/** The iframe element for a custom block (sanitizes again: the stored value is not trusted at render time). */
export function renderCustomBlock(n: { html: string; css?: string; height: number; title?: string }, vars: CustomVariables = {}): string {
  const html = sanitizeCustomHtml(n.html, { vars }).out;
  const css = n.css ? sanitizeCustomCss(n.css).out : '';
  const height = Math.min(Math.max(Math.trunc(n.height) || CUSTOM_MIN_HEIGHT, CUSTOM_MIN_HEIGHT), CUSTOM_MAX_HEIGHT);
  const lang = vars.locale && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(vars.locale) ? vars.locale : 'en';
  return `<iframe class="tpl-custom" title="${escapeHtml(n.title || 'Custom content')}" sandbox="${CUSTOM_FRAME_SANDBOX}" referrerpolicy="no-referrer" loading="lazy" height="${height}" srcdoc="${escapeHtml(customFrameDocument(html, css, lang))}"></iframe>`;
}

/** The `custom` component of a page template, validated like the API does: the same refusals, the same messages, the stored value is the sanitized form. */
export function parseCustomComponent(n: Record<string, unknown>, path: string, depth: number): Record<string, unknown> {
  const fail = (p: string, message: string): never => {
    throw new EmulatorError('VALIDATION_FAILED', `${p}: ${message}`, p);
  };
  if (depth > 0) fail(path, 'a custom block cannot sit inside columns.');
  const html = typeof n.html === 'string' && n.html.trim() !== '' ? n.html : fail(`${path}.html`, 'must be a non-empty string of HTML.');
  if (n.css !== undefined && typeof n.css !== 'string') fail(`${path}.css`, 'must be a string of CSS.');
  const cleanHtml = sanitizeCustomHtml(html as string);
  if (cleanHtml.problems.length) fail(`${path}.html`, cleanHtml.problems.slice(0, 3).join(' '));
  if (!cleanHtml.out.trim()) fail(`${path}.html`, 'has no content once sanitized.');
  const cleanCss = n.css ? sanitizeCustomCss(n.css as string) : { out: '', problems: [] as string[] };
  if (cleanCss.problems.length) fail(`${path}.css`, cleanCss.problems.slice(0, 3).join(' '));
  const height = typeof n.height === 'number' && Number.isInteger(n.height) && n.height >= CUSTOM_MIN_HEIGHT && n.height <= CUSTOM_MAX_HEIGHT ? n.height : (fail(`${path}.height`, `is required: the frame's height in pixels, ${CUSTOM_MIN_HEIGHT} to ${CUSTOM_MAX_HEIGHT}.`) as never);
  let title: string | undefined;
  if (n.title !== undefined) {
    if (typeof n.title !== 'string' || n.title.trim() === '' || n.title.length > 120) fail(`${path}.title`, 'must be a non-empty string of at most 120 characters.');
    title = n.title as string;
  }
  return { type: 'custom', html: cleanHtml.out, ...(cleanCss.out ? { css: cleanCss.out } : {}), height, ...(title !== undefined ? { title } : {}) };
}
