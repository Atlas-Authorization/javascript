import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolSpec } from './tools';

/**
 * Atlas documentation search for AI coding agents.
 *
 * The public docs are published as one concatenated file for AI tools
 * (`llms-full.txt`): each page starts with `# <title>` and a `Source: <url>`
 * line. This module fetches it once (cached for {@link DocsSourceOptions.ttlMs}),
 * splits it into pages, and answers two read-only tools:
 *
 *   - `search_atlas_docs` — ranked pages for a query, each with its URL and the
 *     best-matching excerpt;
 *   - `read_atlas_doc` — one page in full, by URL, slug or title.
 *
 * No key is needed: the docs are public. Ranking is a plain term-frequency
 * score with a title boost, which is deterministic and needs no index service.
 */

export const DEFAULT_DOCS_URL = 'https://atlasauth.net/llms-full.txt';
export const DOCS_TOOL_NAMES = ['search_atlas_docs', 'read_atlas_doc'] as const;

export interface DocPage {
  title: string;
  url: string;
  body: string;
}

export interface DocHit {
  title: string;
  url: string;
  excerpt: string;
  score: number;
}

/** Split the concatenated docs into pages. Text before the first page header is dropped. */
export function parseDocs(text: string): DocPage[] {
  const pages: DocPage[] = [];
  const header = /^# (.+)\r?\nSource: (\S+)[^\n]*$/gm;
  const marks: Array<{ title: string; url: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = header.exec(text)) !== null) {
    marks.push({ title: m[1]!.trim(), url: m[2]!.trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : text.length;
    const body = text
      .slice(mark.bodyStart, end)
      .replace(/\n-{3,}\s*$/, '')
      .trim();
    pages.push({ title: mark.title, url: mark.url, body });
  });
  return pages;
}

const STOP = new Set(['a', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'with']);

function terms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_./:-]+/)
        .map((t) => t.replace(/^[./:-]+|[./:-]+$/g, ''))
        .filter((t) => t.length > 1 && !STOP.has(t)),
    ),
  ];
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** The paragraph of `body` that mentions the most query terms, trimmed to ~400 chars. */
function excerptOf(body: string, words: string[]): string {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
  let best = paragraphs[0] ?? '';
  let bestScore = -1;
  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    const score = words.reduce((s, w) => s + (lower.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  const flat = best.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}

/** Rank pages for a query. Pages matching no term are left out. */
export function searchDocs(pages: readonly DocPage[], query: string, limit = 5): DocHit[] {
  const words = terms(query);
  if (words.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const hits: DocHit[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const body = page.body.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const w of words) {
      const inTitle = count(title, w);
      const inBody = count(body, w);
      if (inTitle || inBody) matched++;
      score += inTitle * 10 + Math.min(inBody, 20);
    }
    if (!matched) continue;
    // Pages that cover every term, or the exact phrase, rank above partial matches.
    score *= 1 + matched / words.length;
    if (phrase.length > 3 && (title.includes(phrase) || body.includes(phrase))) score *= 1.5;
    hits.push({ title: page.title, url: page.url, excerpt: excerptOf(page.body, words), score: Math.round(score * 10) / 10 });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, Math.max(1, Math.min(limit, 20)));
}

/** Find one page by full URL, slug (the URL's last path segment) or exact title. */
export function findDoc(pages: readonly DocPage[], ref: string): DocPage | undefined {
  const want = ref.trim().replace(/\/+$/, '');
  const lower = want.toLowerCase();
  return (
    pages.find((p) => p.url.replace(/\/+$/, '') === want) ??
    pages.find((p) => p.url.replace(/\/+$/, '').split('/').pop()?.toLowerCase() === lower) ??
    pages.find((p) => p.title.toLowerCase() === lower)
  );
}

export interface DocsSourceOptions {
  /** Where the concatenated docs live. Default {@link DEFAULT_DOCS_URL}. */
  url?: string;
  fetch?: typeof fetch;
  /** How long a fetched copy is reused. Default one hour. */
  ttlMs?: number;
  now?: () => number;
}

export interface DocsSource {
  pages(): Promise<DocPage[]>;
}

/** Fetch-and-cache the docs. A failed refresh keeps serving the last good copy. */
export function createDocsSource(options: DocsSourceOptions = {}): DocsSource {
  const url = options.url ?? DEFAULT_DOCS_URL;
  const ttl = options.ttlMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let cached: { at: number; pages: DocPage[] } | null = null;
  let inflight: Promise<DocPage[]> | null = null;

  const load = async (): Promise<DocPage[]> => {
    const doFetch = options.fetch ?? fetch;
    const res = await doFetch(url, { headers: { accept: 'text/plain' } });
    if (!res.ok) throw new Error(`The Atlas docs could not be fetched (HTTP ${res.status}).`);
    const pages = parseDocs(await res.text());
    if (pages.length === 0) throw new Error('The Atlas docs file had no pages.');
    cached = { at: now(), pages };
    return pages;
  };

  return {
    async pages() {
      if (cached && now() - cached.at < ttl) return cached.pages;
      inflight ??= load().finally(() => {
        inflight = null;
      });
      try {
        return await inflight;
      } catch (error) {
        if (cached) return cached.pages;
        throw error;
      }
    },
  };
}

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const fail = (error: unknown): CallToolResult => ({
  content: [{ type: 'text', text: `Atlas docs error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

/** The two docs tools as MCP specs. */
export function docsToolSpecs(source: DocsSource): McpToolSpec[] {
  return [
    {
      name: 'search_atlas_docs',
      description:
        'Search the Atlas documentation (authentication, sessions, organizations, SDKs, APIs, migration guides). Returns the best-matching pages with their URL and an excerpt. Use read_atlas_doc to read a page in full.',
      shape: {
        query: z.string().min(1).describe('What to look for, e.g. "verify session token in express" or "import users from Clerk".'),
        limit: z.number().int().min(1).max(20).optional().describe('How many pages to return (default 5).'),
      },
      handler: async (args) => {
        try {
          const hits = searchDocs(await source.pages(), String(args.query ?? ''), typeof args.limit === 'number' ? args.limit : 5);
          if (hits.length === 0) return text('No Atlas docs page matched. Try different or fewer words.');
          return text(JSON.stringify(hits, null, 2));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: 'read_atlas_doc',
      description: 'Read one Atlas documentation page in full, by its URL, its slug (e.g. "migrate-from-clerk") or its exact title.',
      shape: {
        page: z.string().min(1).describe('The page URL from search_atlas_docs, its slug, or its title.'),
      },
      handler: async (args) => {
        try {
          const page = findDoc(await source.pages(), String(args.page ?? ''));
          if (!page) return { ...text('No Atlas docs page has that URL, slug or title. Use search_atlas_docs to find it.'), isError: true };
          return text(`# ${page.title}\nSource: ${page.url}\n\n${page.body}`);
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}
