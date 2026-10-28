import { list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { envApiUrl, resolveAuth, wantsJson } from './shared';
import { instanceCredential } from './project-commands';

/** One surface of the embed manifest (`GET /v1/embed`): the CSP sources it needs. */
interface EmbedSurface {
  csp?: Record<string, string[]>;
  requires?: Record<string, string[]>;
  sri?: Record<string, string>;
}

interface EmbedManifest {
  product?: string;
  surfaces?: Record<string, EmbedSurface>;
  changes?: Array<{ effective?: string; surface?: string; add?: Record<string, string[]>; remove?: Record<string, string[]>; note?: string }>;
}

const FRAMEWORKS = ['next', 'express', 'nginx'] as const;
type Framework = (typeof FRAMEWORKS)[number];

/** Which manifest surfaces each `--shape` needs. `redirect` runs entirely on Atlas's hosted pages. */
const SHAPE_SURFACES: Record<string, string[]> = {
  redirect: [],
  panel: ['embedded-panel'],
  button: ['sign-in-button'],
};

/** Merge the CSP sources of the chosen surfaces into one directive map (union, stable order). */
export function mergeCsp(manifest: EmbedManifest, shape?: string): Record<string, string[]> {
  const surfaces = manifest.surfaces ?? {};
  const names = shape ? (SHAPE_SURFACES[shape] ?? []) : Object.keys(surfaces).filter((n) => n !== 'hosted-pages');
  const out: Record<string, string[]> = {};
  for (const name of names) {
    for (const [directive, sources] of Object.entries(surfaces[name]?.csp ?? {})) {
      const set = (out[directive] ??= []);
      for (const s of sources) if (!set.includes(s)) set.push(s);
    }
  }
  return out;
}

/** True when a chosen surface says its style needs a source (so `style-src` must be extended). */
function styleRequires(manifest: EmbedManifest, shape?: string): string[] {
  const names = shape ? (SHAPE_SURFACES[shape] ?? []) : Object.keys(manifest.surfaces ?? {});
  return [...new Set(names.flatMap((n) => manifest.surfaces?.[n]?.requires?.['style-src'] ?? []))];
}

const toHeader = (d: Record<string, string[]>) =>
  Object.entries(d)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');

export function renderCsp(framework: Framework, directives: Record<string, string[]>): string {
  const header = toHeader(directives);
  if (framework === 'nginx') {
    return [
      '# Atlas sources only: merge them with the directives you already send.',
      `add_header Content-Security-Policy "${header}" always;`,
    ].join('\n');
  }
  if (framework === 'express') {
    const body = Object.entries(directives)
      .filter(([, v]) => v.length)
      .map(([k, v]) => `    '${k}': [${v.map((s) => JSON.stringify(s)).join(', ')}],`)
      .join('\n');
    return [
      '// Atlas sources only: add each list to the matching directive you already set.',
      "import helmet from 'helmet';",
      '',
      'app.use(',
      '  helmet.contentSecurityPolicy({',
      '    useDefaults: true,',
      '    directives: {',
      body.replace(/^/gm, '  '),
      '    },',
      '  }),',
      ');',
    ].join('\n');
  }
  const lines = Object.entries(directives)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  return [
    '// next.config.ts: Atlas sources only. Merge each list into the matching directive you already set.',
    'const atlasCsp: Record<string, string[]> = {',
    ...lines,
    '};',
    '',
    "const csp = Object.entries(atlasCsp).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');",
    '',
    'export default {',
    '  async headers() {',
    "    return [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: csp }] }];",
    '  },',
    '};',
  ].join('\n');
}

/**
 * `atlas csp --framework next|express|nginx [--shape redirect|panel|button]`:
 * read the instance's embed manifest (`GET /v1/embed`, which fills in your
 * custom FAPI host and any consent or captcha origins) and print the Content
 * Security Policy sources Atlas needs, ready to paste. Read-only.
 */
export async function csp(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const framework = (str(v, 'framework') ?? 'next') as Framework;
  if (!FRAMEWORKS.includes(framework)) throw new CliError(`--framework must be one of: ${FRAMEWORKS.join(', ')} (got '${framework}').`);
  const shape = str(v, 'shape');
  if (shape && !(shape in SHAPE_SURFACES)) throw new CliError(`--shape must be one of: ${Object.keys(SHAPE_SURFACES).join(', ')} (got '${shape}').`);

  // Any provider that publishes the open embed-manifest format (surfaces -> csp) can be merged in:
  // --manifest <url|file> (repeatable) for a CMP, chat widget, captcha or analytics vendor.
  const manifests: EmbedManifest[] = [];
  const extra = list(v, 'manifest');
  let instance = str(v, 'instance');
  if (v['no-atlas'] !== true) {
    // --product <name> [--instance-env]: that project's instance (from its manifest); else the profile / ATLAS_SECRET_KEY.
    const cred = str(v, 'product')
      ? instanceCredential(ctx, { ...args, values: { ...v, instance: undefined } })
      : (() => {
          const auth = resolveAuth(ctx, v);
          return { secretKey: auth.secretKey, apiUrl: envApiUrl(ctx.env) ?? auth.apiUrl };
        })();
    const http = httpFor(ctx, { secretKey: cred.secretKey, apiUrl: cred.apiUrl });
    if (!instance) instance = (await http.get<{ id: string }>('/v1/instance')).id;
    const q = new URLSearchParams({ instance });
    const origin = str(v, 'origin');
    if (origin) q.set('origin', origin);
    if (shape) q.set('shape', shape);
    const own = await http.get<EmbedManifest & { tenant?: { originAllowed?: boolean | null } }>(`/v1/embed?${q}`);
    manifests.push(own);
    if (origin && own.tenant?.originAllowed === false) {
      ctx.io.err(`atlas: ${origin} is not one of the instance's allowed origins; add it (PATCH /v1/instance allowed_origins) or sign-in from it fails CORS.`);
    }
  } else if (extra.length === 0) {
    throw new CliError('--no-atlas needs at least one --manifest <url|file>.');
  }
  for (const source of extra) {
    let text: string;
    if (/^https?:\/\//i.test(source)) {
      const res = await (ctx.fetch ?? fetch)(source, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new CliError(`Could not fetch ${source} (HTTP ${res.status}).`);
      text = await res.text();
    } else {
      text = ctx.readFile(source);
    }
    try {
      manifests.push(JSON.parse(text) as EmbedManifest);
    } catch {
      throw new CliError(`${source} is not valid JSON.`);
    }
  }

  const directives: Record<string, string[]> = {};
  const unionInto = (d: Record<string, string[]>) => {
    for (const [k, srcs] of Object.entries(d)) {
      const set = (directives[k] ??= []);
      for (const s of srcs) if (!set.includes(s)) set.push(s);
    }
  };
  // The shape filter applies to the instance manifest only; a third-party manifest contributes every surface it lists.
  manifests.forEach((m, i) => unionInto(mergeCsp(m, v['no-atlas'] !== true && i === 0 ? shape : undefined)));
  const styles = manifests.flatMap((m, i) => styleRequires(m, v['no-atlas'] !== true && i === 0 ? shape : undefined));
  if (styles.length) directives['style-src'] = [...new Set([...(directives['style-src'] ?? []), ...styles])];
  const upcoming = manifests.flatMap((m) => m.changes ?? []);

  if (wantsJson(v)) {
    printJson(ctx.io, { instance, shape: shape ?? null, directives, header: toHeader(directives), upcoming });
    return 0;
  }
  if (Object.values(directives).every((s) => s.length === 0)) {
    ctx.io.out(shape === 'redirect' ? 'The hosted-redirect integration needs no Content Security Policy changes: sign-in runs on Atlas\'s own pages.' : 'No CSP sources are required for this setup.');
    return 0;
  }
  ctx.io.out(renderCsp(framework, directives));
  for (const c of upcoming) {
    ctx.io.err(`atlas: upcoming change${c.effective ? ` from ${c.effective}` : ''}${c.surface ? ` (${c.surface})` : ''}: ${c.note ?? JSON.stringify(c.add ?? {})}`);
  }
  return 0;
}
