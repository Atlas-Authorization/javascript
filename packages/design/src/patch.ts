import {
  designSchema,
  validateDesignPatch,
  zodProblems,
  type AtlasDesign,
  type DesignValidation,
} from './schema';
import { mergePatch, pruneEmpty } from './merge';

export { mergePatch, pruneEmpty } from './merge';

type Plain = Record<string, unknown>;

/**
 * Validate `patch`, merge it onto the stored `base` design, and re-validate the
 * merged result (a patch can be individually valid yet produce an invalid whole,
 * e.g. a gradient with one stop). Problems carry full dotted paths.
 */
export function applyDesignPatch(
  base: AtlasDesign | undefined,
  patch: unknown,
): DesignValidation<AtlasDesign> {
  const p = validateDesignPatch(patch);
  if (!p.ok) return p;
  const merged = pruneEmpty(mergePatch((base ?? {}) as Plain, p.value as Plain));
  const r = designSchema.safeParse(merged);
  return r.success ? { ok: true, value: r.data } : { ok: false, problems: zodProblems(r.error) };
}
