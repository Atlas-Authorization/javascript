/**
 * Atlas's own captcha (provider `atlas`), the browser half. Dependency-free.
 *
 * No third-party script and no site key: the widget fetches a signed,
 * single-use challenge from the instance's Frontend API, finds the number `n`
 * with SHA-256(salt + n) = challenge (proof of work, in Web Workers via
 * `crypto.subtle`, falling back to the page thread when workers are blocked),
 * and, only when the server decided the request looks risky, shows a
 * "select every matching shape" step with an accessible alternative (more
 * work instead of the puzzle). The flow's request then carries
 * `atlas1.<base64url JSON>` as `captcha_token`.
 *
 * Invisible by default: at low risk nothing is drawn and the work takes a
 * fraction of a second.
 */

/** A challenge, exactly as `GET /v1/client/captcha/challenge` returns it. */
export interface AtlasChallenge {
  object: 'captcha_challenge';
  provider: 'atlas';
  token: string;
  algorithm: 'SHA-256';
  salt: string;
  challenge: string;
  maxnumber: number;
  expires_at: string;
  interactive: { kind: 'match_shapes'; example: string; tiles: string[] } | null;
  accessible_alternative: boolean;
}

/** The words the widget shows. English defaults; pass your own to localise. */
export interface AtlasCaptchaLabels {
  checking: string;
  verified: string;
  puzzlePrompt: string;
  confirm: string;
  /** `{n}` is the tile number. */
  tile: string;
  alternative: string;
}

export const ATLAS_CAPTCHA_LABELS: AtlasCaptchaLabels = {
  checking: 'Checking your browser…',
  verified: 'Security check complete.',
  puzzlePrompt: "Select every picture that shows the same shape as this one. Colour and size don't matter.",
  confirm: 'Confirm',
  tile: 'Picture {n}',
  alternative: "Can't do the picture check? Use a longer automatic check instead.",
};

/**
 * The catalog keys of the widget's words, as in `@atlasauth/localizations` and
 * every SDK's built-in catalog.
 */
export const ATLAS_CAPTCHA_LABEL_KEYS: Readonly<Record<keyof AtlasCaptchaLabels, string>> = {
  checking: 'captcha.checking',
  verified: 'captcha.verified',
  puzzlePrompt: 'captcha.puzzlePrompt',
  confirm: 'captcha.puzzleConfirm',
  tile: 'captcha.puzzleTile',
  alternative: 'captcha.puzzleAlternative',
};

/**
 * The widget's labels from a form's translator (or any catalog lookup). A key
 * the lookup does not know (no value, or the key echoed back) keeps the English
 * default.
 */
export function atlasCaptchaLabels(
  lookup: ((key: string) => string | null | undefined) | Readonly<Record<string, unknown>> | null | undefined,
): Partial<AtlasCaptchaLabels> {
  if (!lookup) return {};
  const get = typeof lookup === 'function' ? lookup : (key: string) => lookup[key];
  const out: Partial<AtlasCaptchaLabels> = {};
  for (const [field, key] of Object.entries(ATLAS_CAPTCHA_LABEL_KEYS) as [keyof AtlasCaptchaLabels, string][]) {
    const value = get(key);
    if (typeof value === 'string' && value.trim() && value !== key) out[field] = value;
  }
  return out;
}

export interface AtlasCaptchaOptions {
  /**
   * Fetch a fresh challenge. Defaults to a GET of the flow's `challengeUrl`
   * (from `/v1/appearance`). `accessible` asks for the no-puzzle alternative.
   */
  fetchChallenge?: (accessible: boolean) => Promise<AtlasChallenge>;
  /** Where the default fetcher GETs (the flow's `challengeUrl`). */
  challengeUrl?: string;
  /**
   * `managed` (default) solves as soon as it is drawn and shows nothing unless
   * the puzzle is needed; `invisible` is the same, drawn only at submit;
   * `visible` always shows the check (and the server always adds the puzzle).
   */
  mode?: 'invisible' | 'managed' | 'visible';
  labels?: Partial<AtlasCaptchaLabels>;
  /** Use Web Workers when available (default true). */
  workers?: boolean;
}

const hex = (buf: ArrayBuffer) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16);
  return s;
};

const BATCH = 2000;

/**
 * Search [from, to] for n with SHA-256(salt + n) = challenge, on this thread.
 * Each batch awaits `crypto.subtle`, so the page stays responsive.
 */
export async function searchAtlasRange(
  c: Pick<AtlasChallenge, 'salt' | 'challenge'>,
  from: number,
  to: number,
  cancelled: () => boolean = () => false,
): Promise<number | null> {
  const enc = new TextEncoder();
  for (let start = from; start <= to; start += BATCH) {
    if (cancelled()) return null;
    const end = Math.min(to, start + BATCH - 1);
    const batch: Promise<ArrayBuffer>[] = [];
    for (let n = start; n <= end; n++) batch.push(crypto.subtle.digest('SHA-256', enc.encode(`${c.salt}${n}`)));
    const hashes = await Promise.all(batch);
    for (let i = 0; i < hashes.length; i++) if (hex(hashes[i]!) === c.challenge) return start + i;
  }
  return null;
}

/** The worker: the same search, posted back as { n }. Kept as a string so it ships with no bundler setup. */
const WORKER_SOURCE = `
self.onmessage = async function (e) {
  var d = e.data, enc = new TextEncoder();
  function hex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  for (var start = d.from; start <= d.to; start += ${BATCH}) {
    var end = Math.min(d.to, start + ${BATCH} - 1), batch = [];
    for (var n = start; n <= end; n++) batch.push(crypto.subtle.digest('SHA-256', enc.encode(d.salt + n)));
    var hs = await Promise.all(batch);
    for (var i = 0; i < hs.length; i++) if (hex(hs[i]) === d.challenge) { self.postMessage({ n: start + i }); return; }
  }
  self.postMessage({ n: null });
};`;

/**
 * Solve a challenge's proof of work. Splits the range over up to four Web
 * Workers; when workers cannot start (a CSP without `worker-src blob:`, an old
 * browser) it searches on this thread instead. Resolves `{ n, worker }`.
 */
export async function solveAtlasChallenge(
  c: Pick<AtlasChallenge, 'salt' | 'challenge' | 'maxnumber'>,
  opts: { workers?: boolean; cancelled?: () => boolean } = {},
): Promise<{ n: number; worker: boolean }> {
  const cancelled = opts.cancelled ?? (() => false);
  const g = globalThis as unknown as {
    Worker?: typeof Worker;
    Blob?: typeof Blob;
    URL?: typeof URL;
    navigator?: { hardwareConcurrency?: number };
  };
  if (opts.workers !== false && g.Worker && g.Blob && g.URL?.createObjectURL) {
    const viaWorkers = await solveInWorkers(c, Math.max(1, Math.min(4, g.navigator?.hardwareConcurrency ?? 2)), cancelled).catch(
      () => undefined,
    );
    if (viaWorkers !== undefined) {
      if (viaWorkers === null) throw new Error('captcha: no solution');
      return { n: viaWorkers, worker: true };
    }
  }
  const n = await searchAtlasRange(c, 0, c.maxnumber, cancelled);
  if (n === null) throw new Error(cancelled() ? 'captcha: cancelled' : 'captcha: no solution');
  return { n, worker: false };
}

function solveInWorkers(
  c: Pick<AtlasChallenge, 'salt' | 'challenge' | 'maxnumber'>,
  count: number,
  cancelled: () => boolean,
): Promise<number | null> {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  const workers: Worker[] = [];
  const stop = () => {
    for (const w of workers) w.terminate();
    URL.revokeObjectURL(url);
  };
  return new Promise<number | null>((resolve, reject) => {
    let pending = count;
    const span = Math.ceil((c.maxnumber + 1) / count);
    const poll = setInterval(() => {
      if (cancelled()) {
        clearInterval(poll);
        stop();
        resolve(null);
      }
    }, 100);
    const finish = (value: number | null | Error) => {
      clearInterval(poll);
      stop();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    try {
      for (let i = 0; i < count; i++) {
        const w = new Worker(url);
        workers.push(w);
        w.onmessage = (e: MessageEvent<{ n: number | null }>) => {
          if (typeof e.data?.n === 'number') finish(e.data.n);
          else if (--pending === 0) finish(null);
        };
        w.onerror = () => finish(new Error('captcha: worker failed'));
        const from = i * span;
        w.postMessage({ salt: c.salt, challenge: c.challenge, from, to: Math.min(c.maxnumber, from + span - 1) });
      }
    } catch (e) {
      finish(e instanceof Error ? e : new Error('captcha: worker failed'));
    }
  });
}

const b64url = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Encode a solution as the `captcha_token` the flow's request carries. */
export function encodeAtlasToken(s: { t: string; n: number; ms?: number; w?: 0 | 1; sel?: number }): string {
  return `atlas1.${b64url(JSON.stringify(s))}`;
}

/** GET a challenge from a URL (the flow's `challengeUrl`). */
export async function fetchAtlasChallenge(url: string, accessible = false): Promise<AtlasChallenge> {
  const u = accessible ? `${url}${url.includes('?') ? '&' : '?'}accessible=true` : url;
  const res = await fetch(u, { method: 'GET', credentials: 'omit' });
  if (!res.ok) throw new Error(`captcha: challenge refused (${res.status})`);
  return (await res.json()) as AtlasChallenge;
}

function svgImage(doc: Document, svg: string): HTMLImageElement {
  const img = doc.createElement('img');
  // A data: image never runs script, whatever the markup.
  img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  img.alt = '';
  img.width = 64;
  img.height = 64;
  img.style.cssText = 'display:block;width:64px;height:64px;border-radius:6px';
  return img;
}

/** Draw the shape-matching step; resolves the tile mask, or 'accessible'. */
function askPuzzle(
  box: HTMLElement,
  c: AtlasChallenge,
  labels: AtlasCaptchaLabels,
  cancelled: () => boolean,
): Promise<number | 'accessible'> {
  const doc = box.ownerDocument;
  return new Promise((resolve, reject) => {
    box.replaceChildren();
    const wrap = doc.createElement('div');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('data-atlas-captcha-puzzle', '');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px';
    const prompt = doc.createElement('p');
    prompt.style.cssText = 'margin:0;font-size:13px;text-align:center';
    prompt.textContent = labels.puzzlePrompt;
    wrap.append(prompt, svgImage(doc, c.interactive!.example));
    const grid = doc.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,72px);gap:6px';
    let mask = 0;
    c.interactive!.tiles.forEach((svg, i) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', labels.tile.replace('{n}', String(i + 1)));
      b.setAttribute('data-atlas-captcha-tile', String(i));
      b.style.cssText = 'padding:3px;border:2px solid transparent;border-radius:8px;background:none;cursor:pointer';
      b.append(svgImage(doc, svg));
      b.addEventListener('click', () => {
        mask ^= 1 << i;
        const on = (mask & (1 << i)) !== 0;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.style.borderColor = on ? 'currentColor' : 'transparent';
      });
      grid.append(b);
    });
    const ok = doc.createElement('button');
    ok.type = 'button';
    ok.setAttribute('data-atlas-captcha-confirm', '');
    ok.textContent = labels.confirm;
    ok.addEventListener('click', () => (cancelled() ? reject(new Error('captcha: widget removed')) : resolve(mask)));
    wrap.append(grid, ok);
    if (c.accessible_alternative) {
      const alt = doc.createElement('button');
      alt.type = 'button';
      alt.setAttribute('data-atlas-captcha-alternative', '');
      alt.style.cssText = 'font-size:12px;background:none;border:0;text-decoration:underline;cursor:pointer';
      alt.textContent = labels.alternative;
      alt.addEventListener('click', () => resolve('accessible'));
      wrap.append(alt);
    }
    box.append(wrap);
  });
}

/** A drawn Atlas captcha: its token, whether it is about to expire, and teardown. */
export interface AtlasCaptchaHandle {
  token: Promise<string>;
  /** True once the solved challenge is within 15 s of expiring: draw a fresh one. */
  stale(): boolean;
  remove(): void;
}

/** Render Atlas's captcha into `container` and resolve the `captcha_token`. */
export function renderAtlasCaptcha(container: HTMLElement, opts: AtlasCaptchaOptions): AtlasCaptchaHandle {
  const labels = { ...ATLAS_CAPTCHA_LABELS, ...opts.labels };
  const mode = opts.mode ?? 'managed';
  const doc = container.ownerDocument;
  const fetchChallenge =
    opts.fetchChallenge ??
    ((accessible: boolean) => {
      if (!opts.challengeUrl) return Promise.reject(new Error('captcha: no challenge URL'));
      return fetchAtlasChallenge(opts.challengeUrl, accessible);
    });

  let removed = false;
  let expiresAt = 0;
  const cancelled = () => removed;
  const box = doc.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.setAttribute('data-atlas-captcha-provider', 'atlas');
  box.style.cssText = 'font-size:13px;opacity:.85;text-align:center';
  container.append(box);
  const say = (text: string) => {
    box.replaceChildren();
    box.textContent = text;
  };

  const run = async (accessible: boolean): Promise<string> => {
    const c = await fetchChallenge(accessible);
    if (removed) throw new Error('captcha: widget removed');
    expiresAt = Date.parse(c.expires_at) || 0;
    if (mode === 'visible' || c.interactive) say(labels.checking);
    const started = Date.now();
    const work = solveAtlasChallenge(c, { workers: opts.workers, cancelled }).then((r) => ({
      ...r,
      ms: Date.now() - started,
    }));
    // A rejection here is reported by whichever await reads it.
    work.catch(() => undefined);
    let sel: number | undefined;
    if (c.interactive) {
      const answer = await askPuzzle(box, c, labels, cancelled);
      if (answer === 'accessible') {
        say(labels.checking);
        return run(true);
      }
      sel = answer;
      say(labels.checking);
    }
    const { n, worker, ms } = await work;
    if (removed) throw new Error('captcha: widget removed');
    if (mode === 'visible' || sel !== undefined) say(labels.verified);
    return encodeAtlasToken({ t: c.token, n, ms, ...(worker ? { w: 1 as const } : {}), ...(sel !== undefined ? { sel } : {}) });
  };

  const token = run(false);
  token.catch(() => undefined);
  return {
    token,
    stale: () => expiresAt > 0 && Date.now() > expiresAt - 15_000,
    remove() {
      removed = true;
      box.remove();
    },
  };
}
