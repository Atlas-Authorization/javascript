import type { Engine } from './engine';
import type { Obj } from './openapi';

export type Coverage = 'handler' | 'generic';

/**
 * What the emulator does for each operation of the OpenAPI document, for the surface-completeness matrix:
 * `handler` = hand-written behaviour (state, side effects, events), `generic` = document-driven CRUD only (a valid answer,
 * no side effects). Routes the engine serves that the document does not list (`/oauth2/*`, `/scim/v2/*`, the well-known
 * documents) come back under `extra`.
 */
export function coverageList(engine: Engine): { operations: Record<string, Coverage>; extra: string[] } {
  const documented = new Set(engine.index.ops.map((o) => `${o.method} ${o.path}`));
  return {
    operations: engine.coverage(),
    extra: engine.handwritten().filter((r) => !r.op && !r.pattern.startsWith('/__emulator')).map((r) => `${r.method} ${r.pattern}`).filter((k) => !documented.has(k)),
  };
}

/** Copy of the document with `x-atlas-emulator-coverage` set on every operation. */
export function annotateCoverage(doc: Obj, engine: Engine): Obj {
  const cov = engine.coverage();
  const out = structuredClone(doc);
  for (const [path, item] of Object.entries<Obj>(out.paths ?? {})) {
    for (const method of Object.keys(item)) {
      const level = cov[`${method.toUpperCase()} ${path}`];
      if (level) item[method]['x-atlas-emulator-coverage'] = level;
    }
  }
  return out;
}
