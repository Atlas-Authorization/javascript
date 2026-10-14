import type { ToolDefinition, ToolResource, ToolVerb } from './types';
import { userTools } from './tools/users';
import { organizationTools } from './tools/organizations';
import { invitationTools } from './tools/invitations';
import { sessionTools } from './tools/sessions';
import { apiKeyTools } from './tools/api-keys';

/**
 * The complete, framework-agnostic catalogue of every tool the toolkit knows
 * how to build — before any scoping is applied. Order is stable and grouped by
 * resource so a generated listing reads top-to-bottom like the docs.
 */
export function allTools(): ToolDefinition[] {
  return [
    ...userTools(),
    ...organizationTools(),
    ...invitationTools(),
    ...sessionTools(),
    ...apiKeyTools(),
  ];
}

/** Least→most dangerous. A scope for a higher verb implies the lower ones. */
const VERB_RANK: Record<ToolVerb, number> = { read: 0, write: 1, delete: 2 };

/**
 * One `resource:verb` scope string, where either half may be the `*` wildcard:
 * `users:read`, `organizations:*`, `*:read`, `*:*`. A `write` scope grants
 * `read` too (write implies read), but `delete` — the only irreversible verb —
 * is granted ONLY by an explicit `:delete` (or `:*`) scope, never by `:write`.
 */
export type Scope = `${ToolResource | '*'}:${ToolVerb | '*'}` | (string & {});

/** Does any scope in `scopes` grant `resource:verb`? */
export function scopeGrants(scopes: readonly string[], resource: ToolResource, verb: ToolVerb): boolean {
  const needed = VERB_RANK[verb];
  return scopes.some((scope) => {
    const sep = scope.indexOf(':');
    if (sep === -1) return false;
    const r = scope.slice(0, sep);
    const v = scope.slice(sep + 1);
    if (r !== '*' && r !== resource) return false;
    if (v === '*') return true;
    const granted = VERB_RANK[v as ToolVerb];
    return granted !== undefined && granted >= needed;
  });
}

/** How a toolkit decides which tools are exposed. See {@link selectTools}. */
export interface ToolSelection {
  /**
   * An explicit allowlist of tool NAMES. When present it is authoritative: a
   * tool is exposed iff its name appears here (and `scopes` is ignored). This
   * is the most precise control — it can enable a single write while hiding
   * reads, or vice versa.
   */
  allowedTools?: readonly string[];
  /**
   * `resource:verb` scope grants. Used only when `allowedTools` is absent. A
   * tool is exposed iff some scope grants its `resource:verb`.
   */
  scopes?: readonly string[];
}

/**
 * Resolve the full catalogue down to the exposed set, SAFE BY DEFAULT:
 *
 *  1. `allowedTools` present → exactly those names (scopes ignored).
 *  2. else `scopes` present → every tool a scope grants.
 *  3. else (neither given) → reads only; NO write and NO delete tool is ever
 *     exposed. An agent cannot create, update, ban, revoke, or delete anything
 *     unless the integrator opted in through (1) or (2).
 *
 * This is the single chokepoint through which destructive capability reaches a
 * model, which is why it lives in one small, tested function.
 */
export function selectTools(selection: ToolSelection = {}): ToolDefinition[] {
  const catalogue = allTools();
  const { allowedTools, scopes } = selection;

  if (allowedTools) {
    const allow = new Set(allowedTools);
    return catalogue.filter((tool) => allow.has(tool.name));
  }
  if (scopes) {
    return catalogue.filter((tool) => scopeGrants(scopes, tool.resource, tool.verb));
  }
  return catalogue.filter((tool) => tool.readOnly);
}
