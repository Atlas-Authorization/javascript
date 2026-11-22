import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { AtlasApiError } from '@atlasauth/backend';
import { isNotFound, type ConfigHttp } from '../config-http';
import { CliError } from '../errors';
import { canonicalize, type Json } from '../serialize';

/**
 * Pieces of `atlas plan` / `atlas apply` that sit around the per-type specs:
 * order-insensitive set fields, `requires:` on sections and entries, `code_file`,
 * the server's published limits, and the dry-run pre-flight pass.
 */

const isObj = (x: Json | undefined): x is { [k: string]: Json } => x !== null && typeof x === 'object' && !Array.isArray(x);

// ───────────────────────────── set-valued fields ─────────────────────────────

/** auth_config leaves that are unordered lists (the allowed/denied/list kinds); ordered lists (strategies, rules) are left alone. */
const AUTH_CONFIG_SET_KEYS = [
  'methods', 'deviceClasses', 'allow', 'deny', 'hints', 'allowedEmailDomains', 'groups', 'organizations', 'roles', 'userIds',
  'packageNames', 'appIds', 'list', 'allowedPrefixes', 'blockedPrefixes', 'allowedClaimNames', 'allowedScopes', 'keyTypes',
  'enabledLocales', 'allowedRedirectHosts', 'exposedScopes', 'sha256CertFingerprints', 'appleAppIds', 'authorityHints',
  'authorizationDetailsTypesSupported', 'allowedHosts', 'blockedHosts', 'trustedHosts', 'acsUrls', 'authenticatorAllowlist',
  'authenticatorBlocklist', 'blockStatuses', 'bannedPasswords', 'sanctionedCountries', 'trustDomains', 'tokenIncludedSettingsKeys',
  'mappingRules', 'deletionReminders', 'tokens', 'audiences',
] as const;

/**
 * The keys, per config section, whose array is a SET: the order the file lists them in means
 * nothing, so a re-plan after apply must not read a reordering as drift. Ordered lists (stages,
 * action bindings, strategies, rules) are never named here. Applies at any depth inside that section.
 */
export const SET_KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  instance: ['allowed_origins', ...AUTH_CONFIG_SET_KEYS],
  oauth_clients: ['redirect_uris', 'allowed_scopes', 'grant_types', 'post_logout_redirect_uris', 'claims_redirect_uris'],
  oauth_providers: ['scopes'],
  custom_oauth_providers: ['scopes'],
  connection_oauth_clients: ['scopes'],
  resource_servers: ['scopes', 'introspection_client_ids'],
  roles: ['permissions'],
  app_roles: ['permissions'],
  permissions: ['implies'],
  resource_types: ['roles', 'permissions', 'includes'],
  webhook_endpoints: ['enabled_events', 'signature_versions'],
  sso_connections: ['allowed_domains', 'oidc_scopes'],
  sso_onboarding_profiles: ['allowed_connection_types', 'intents'],
  organization_policies: ['allowedSignInMethods', 'ipAllowlist'],
  billing_plans: ['features'],
  cookie_consent: ['extra_origins', 'host_aliases'],
  migration_bridges: ['algorithms', 'cookie_names'],
  impersonation_policy: ['reason_codes'],
  groups: ['app_role_keys'],
  agent_registration: ['untrusted_scopes', 'trusted_scopes'],
  iga_birthright_rules: ['entitlement_ids'],
  iga_bundles: ['entitlement_ids'],
  billing_coupons: ['plan_ids'],
  identity_verification: ['verified_attributes'],
};

/** A canonical, order-independent text for one array element. */
const elementKey = (v: Json): string => JSON.stringify(canonicalize(v));

/**
 * `value` with every array under one of `keys` sorted, so two documents that list the same
 * members in a different order compare equal. Only the comparison and the plan output use it;
 * apply always sends the file as written.
 */
export function sortSets(value: Json, keys: ReadonlySet<string>): Json {
  if (Array.isArray(value)) return value.map((v) => sortSets(v, keys));
  if (!isObj(value)) return value;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    const inner = sortSets(v, keys);
    out[k] = keys.has(k) && Array.isArray(inner) ? [...inner].sort((a, b) => (elementKey(a) < elementKey(b) ? -1 : elementKey(a) > elementKey(b) ? 1 : 0)) : inner;
  }
  return out;
}

/** The set-valued keys of one config section (empty for a section with none). */
export function setKeysOf(type: string): ReadonlySet<string> {
  return new Set(SET_KEYS_BY_TYPE[type] ?? []);
}

// ───────────────────────────── requires ─────────────────────────────

export interface RequiresResult {
  /** The section without its `requires` keys and without the entries it skipped. */
  doc: Json;
  /** Section skipped as a whole. */
  skippedSection: boolean;
  /** Keys of the entries skipped: pruning must leave their live counterparts alone. */
  skippedKeys: Set<string>;
  /** One `skipped <type> [<key>]: VAR unset` line per skip. */
  notes: string[];
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** The variables a `requires` names. Throws on anything that is not a name or a list of names. */
function requiredNames(raw: Json | undefined, where: string): string[] {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.some((n) => typeof n !== 'string' || !VAR_NAME.test(n))) {
    throw new CliError(`${where}: requires must be a variable name or a list of variable names.`);
  }
  return list as string[];
}

const unsetOf = (names: string[], env: NodeJS.ProcessEnv) => names.filter((n) => env[n] === undefined || env[n] === '');
const noteFor = (type: string, key: string, unset: string[]) => `skipped ${type}${key ? ` ${key}` : ''}: ${unset.join(', ')} unset`;

/**
 * Apply `requires:` to one section. A section may carry `requires: [VAR]` (an object section
 * as a key; a list section as `{ requires: [...], items: [...] }`), and any list entry may carry
 * its own. When a listed variable is unset (missing or empty) the section or entry is dropped
 * with a note and is never read as a deletion.
 */
export function applyRequires(type: string, doc: Json, env: NodeJS.ProcessEnv, keyOf?: (entry: { [k: string]: Json }) => string): RequiresResult {
  const result: RequiresResult = { doc, skippedSection: false, skippedKeys: new Set(), notes: [] };
  if (!isObj(doc)) {
    if (Array.isArray(doc)) result.doc = filterEntries(type, doc, env, keyOf, result);
    return result;
  }
  let body: { [k: string]: Json } = doc;
  if ('requires' in body) {
    const unset = unsetOf(requiredNames(body.requires, `${type}`), env);
    const { requires: _requires, ...rest } = body;
    body = rest;
    if (unset.length) {
      result.skippedSection = true;
      result.notes.push(noteFor(type, '', unset));
      result.doc = null;
      return result;
    }
  }
  // `{ requires, items }`: the wrapper form of a list section (only a list section has `items` for its entries).
  const inner = keyOf && Object.keys(body).length === 1 && 'items' in body && (Array.isArray(body.items) || isObj(body.items)) ? body.items! : body;
  if (Array.isArray(inner)) result.doc = filterEntries(type, inner, env, keyOf, result);
  else if (keyOf && isObj(inner)) result.doc = filterMap(type, inner, env, keyOf, result);
  else result.doc = inner;
  return result;
}

function filterEntries(type: string, list: Json[], env: NodeJS.ProcessEnv, keyOf: ((e: { [k: string]: Json }) => string) | undefined, into: RequiresResult): Json[] {
  const out: Json[] = [];
  for (const entry of list) {
    if (!isObj(entry) || !('requires' in entry)) {
      out.push(entry);
      continue;
    }
    const { requires, ...rest } = entry;
    const unset = unsetOf(requiredNames(requires, `${type} entry`), env);
    if (!unset.length) {
      out.push(rest);
      continue;
    }
    const key = keyOf ? safeKey(keyOf, rest) : '';
    into.skippedKeys.add(key);
    into.notes.push(noteFor(type, key, unset));
  }
  return out;
}

function filterMap(type: string, map: { [k: string]: Json }, env: NodeJS.ProcessEnv, keyOf: (e: { [k: string]: Json }) => string, into: RequiresResult): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  for (const [id, entry] of Object.entries(map)) {
    if (!isObj(entry) || !('requires' in entry)) {
      out[id] = entry;
      continue;
    }
    const { requires, ...rest } = entry;
    const unset = unsetOf(requiredNames(requires, `${type} ${id}`), env);
    if (!unset.length) {
      out[id] = rest;
      continue;
    }
    const key = safeKey(keyOf, { id, ...rest });
    into.skippedKeys.add(key);
    into.notes.push(noteFor(type, key, unset));
  }
  return out;
}

const safeKey = (keyOf: (e: { [k: string]: Json }) => string, entry: { [k: string]: Json }): string => {
  try {
    return keyOf(entry);
  } catch {
    return '';
  }
};

// ───────────────────────────── code_file ─────────────────────────────

/**
 * An action's `code_file: <path>` (relative to the config) becomes its `code`. Read at plan time, so
 * the plan diffs what apply will send. A path outside the config's reach is refused: only relative paths.
 */
export function resolveCodeFiles(type: string, doc: Json, baseDir: string): Json {
  if (type !== 'actions') return doc;
  const one = (entry: Json): Json => {
    if (!isObj(entry) || entry.code_file === undefined) return entry;
    const { code_file, ...rest } = entry;
    const name = String(rest.name ?? '(no name)');
    if (typeof code_file !== 'string' || !code_file || isAbsolute(code_file)) throw new CliError(`actions ${name}: code_file must be a path relative to the config.`);
    if (rest.code !== undefined) throw new CliError(`actions ${name}: set code or code_file, not both.`);
    const file = join(baseDir, code_file);
    if (!existsSync(file)) throw new CliError(`actions ${name}: code_file ${code_file} not found (looked in ${baseDir}).`);
    return { ...rest, code: readFileSync(file, 'utf8') };
  };
  if (Array.isArray(doc)) return doc.map(one);
  if (isObj(doc) && Object.values(doc).every(isObj)) return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, one(v)]));
  return one(doc);
}

// ───────────────────────────── published limits ─────────────────────────────

/** `GET /v1/config/limits`, as the CLI uses it. */
export interface ConfigLimits {
  resource_types: { max_roles_per_type: number; key_pattern: string; name_max_length: number };
  app_roles: { max_permissions_per_role: number; max_roles_per_instance: number };
  permissions: { max_implied_per_permission: number; key_max_length: number; max_parts?: number; part_max_length?: number };
  scopes: { description_max_length: number; label_max_length: number };
}

/** The server's published limits, or null when it has none to give (an older server, or a key that cannot read them). */
export async function fetchConfigLimits(http: ConfigHttp): Promise<ConfigLimits | null> {
  try {
    const res = await http.get<{ limits?: ConfigLimits }>('/v1/config/limits');
    return res?.limits ?? null;
  } catch (err) {
    if (isNotFound(err) || (err instanceof AtlasApiError && (err.status === 401 || err.status === 403))) return null;
    throw err;
  }
}

const entriesOf = (doc: Json): Array<{ [k: string]: Json }> => {
  if (Array.isArray(doc)) return doc.filter(isObj);
  if (isObj(doc)) return Object.entries(doc).flatMap(([id, v]) => (isObj(v) ? [{ id, ...v }] : []));
  return [];
};

const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * What the file breaks among the limits the server enforces: roles per resource type, permissions per
 * role, implied permissions, key patterns and lengths. The checks are the write routes' own, run here
 * so `plan` reports them before anything is sent; errors only, never a secret's value.
 */
export function validateAgainstLimits(sections: ReadonlyArray<{ type: string; doc: Json }>, limits: ConfigLimits): string[] {
  const out: string[] = [];
  for (const { type, doc } of sections) {
    if (type === 'resource_types') {
      const keyRe = new RegExp(limits.resource_types.key_pattern);
      for (const t of entriesOf(doc)) {
        const label = `resource_types ${String(t.key ?? '(no key)')}`;
        if (typeof t.key !== 'string' || !keyRe.test(t.key)) out.push(`${label}: key must match ${limits.resource_types.key_pattern}.`);
        if (typeof t.name === 'string' && t.name.length > limits.resource_types.name_max_length) out.push(`${label}: name is ${t.name.length} characters; the limit is ${limits.resource_types.name_max_length}.`);
        const roles = Array.isArray(t.roles) ? t.roles.filter(isObj) : [];
        if (roles.length > limits.resource_types.max_roles_per_type) {
          out.push(`${label}: ${roles.length} roles; a resource type may define at most ${limits.resource_types.max_roles_per_type}.`);
        }
        const seen = new Set<string>();
        roles.forEach((r, i) => {
          const rk = r.key;
          if (typeof rk !== 'string' || !keyRe.test(rk)) out.push(`${label}: roles[${i}].key must match ${limits.resource_types.key_pattern}.`);
          else if (seen.has(rk)) out.push(`${label}: role key "${rk}" appears twice.`);
          else seen.add(rk);
        });
        for (const r of roles) for (const inc of strings(r.includes)) if (!seen.has(inc)) out.push(`${label}: role "${String(r.key)}" includes unknown role "${inc}".`);
      }
    } else if (type === 'app_roles') {
      const rows = entriesOf(doc);
      if (rows.length > limits.app_roles.max_roles_per_instance) out.push(`app_roles: ${rows.length} roles; an instance may define at most ${limits.app_roles.max_roles_per_instance}.`);
      for (const r of rows) {
        const n = strings(r.permissions).length;
        if (n > limits.app_roles.max_permissions_per_role) out.push(`app_roles ${String(r.key ?? '')}: ${n} permissions; a role may carry at most ${limits.app_roles.max_permissions_per_role}.`);
      }
    } else if (type === 'permissions') {
      for (const p of entriesOf(doc)) {
        const key = String(p.key ?? '');
        if (key.length > limits.permissions.key_max_length) out.push(`permissions ${key}: key is ${key.length} characters; the limit is ${limits.permissions.key_max_length}.`);
        const implies = strings(p.implies);
        if (implies.length > limits.permissions.max_implied_per_permission) out.push(`permissions ${key}: implies ${implies.length} permissions; the limit is ${limits.permissions.max_implied_per_permission}.`);
        if (implies.includes(key)) out.push(`permissions ${key}: a permission cannot imply itself.`);
      }
    }
  }
  return out;
}

// ───────────────────────────── dry-run pre-flight ─────────────────────────────

/** What a plan-scoped dry run needs from the http seam (see {@link switchableHttp}). */
export interface PreflightGate {
  setDryRun(on: boolean): void;
  /** Start a new plan-scoped session (the server forgets nothing it was told, so each pass needs its own). */
  begin?(): void;
  /** The server could not find the session: carry on with per-change checks. */
  dropSession?(): void;
  /** Whether every dry write of the current change was validated inside the plan's session (so its references saw the plan's earlier changes). */
  scoped?(): boolean;
}

/**
 * An http client whose writes can be switched to the server's own dry run (`?dry_run=true`: validated exactly as
 * written, then rolled back). All dry writes of one pass share a session id: the server replays the writes it
 * already validated before checking the next, so a change that refers to something an earlier change creates (or
 * deletes) is validated against the plan as a whole.
 */
export function switchableHttp(inner: ConfigHttp): { http: ConfigHttp; setDryRun(on: boolean): void } & Required<Omit<PreflightGate, 'setDryRun'>> {
  let dry = false;
  let session: string | null = null;
  let prior = 0;
  let writes = 0;
  let unscoped = false;
  const url = (path: string) => (dry ? `${path}${path.includes('?') ? '&' : '?'}dry_run=true` : path);
  const init = () => (dry && session ? { headers: { 'atlas-dry-run-session': session, ...(prior > 0 ? { 'atlas-dry-run-prior': String(prior) } : {}) } } : undefined);
  const watch = <T>(p: Promise<T>): Promise<T> =>
    dry
      ? p.then((r) => {
          const res = r as { object?: string; validated?: boolean; plan_session?: unknown } | undefined;
          if (res?.object === 'dry_run' && res.validated !== false && res.plan_session !== undefined) {
            writes += 1;
            prior += 1;
          } else unscoped = true;
          return r;
        })
      : p;
  const http: ConfigHttp = {
    // A read during a dry run sees the plan's earlier changes too (the server replays them before answering it).
    get: (path) => inner.get(path, init()),
    post: (path, body) => watch(inner.post(url(path), body, init())),
    put: (path, body) => watch(inner.put(url(path), body, init())),
    patch: (path, body) => watch(inner.patch(url(path), body, init())),
    delete: (path, body) => inner.delete(url(path), body, init()),
  };
  return {
    http,
    setDryRun(on) {
      dry = on;
      if (on) {
        writes = 0;
        unscoped = false;
      }
    },
    begin() {
      session = randomUUID();
      prior = 0;
    },
    dropSession() {
      session = null;
      prior = 0;
    },
    scoped: () => session !== null && !unscoped && writes > 0,
  };
}

export interface PreflightIssue {
  type: string;
  key: string | null;
  action: 'create' | 'update' | 'delete';
  message: string;
  status?: number;
}

export interface PreflightReport {
  /** Changes the server dry-ran. */
  checked: number;
  /** What the server would refuse. */
  errors: PreflightIssue[];
  /** Changes that could not be validated before the plan runs (they depend on something this plan creates). */
  deferred: PreflightIssue[];
  /** Changes left out, with why (an unresolved ${VAR}). */
  skipped: Array<{ type: string; key: string | null; reason: string }>;
  /** The key cannot dry-run (no write scope); nothing past that was checked. */
  unavailable: string | null;
}

interface PreflightChange {
  type: string;
  key: string;
  action: 'create' | 'update' | 'delete';
  after?: Json;
  apply: () => Promise<void>;
}

const MISSING_DEPENDENCY = /unknown|not found|does not exist|no such|must exist|no [a-z_ ]+ named/i;

const sessionLost = (err: unknown) => err instanceof AtlasApiError && err.status === 409 && /dry-run session/i.test(err.message);

/**
 * Run the whole plan against the server's dry run before anything is written, as one unit: the server replays the
 * changes it already validated before checking the next, so a reference to something an earlier change creates
 * counts as present, a reference to something an earlier change deletes counts as gone, and a name that is in
 * neither the plan nor the instance is a real error here. Only a change that could not be checked inside the
 * session (a server that does not scope dry runs, a lost session, an endpoint that answered with a plan instead of
 * a validation) and that fails on something an earlier create might have provided is deferred. A key without
 * write scope, or a server error, makes the pass unavailable rather than failing the plan.
 */
export async function runPreflight(
  changes: readonly PreflightChange[],
  gate: PreflightGate,
  typeOrder: ReadonlyMap<string, number>,
  hasPlaceholders: (c: PreflightChange) => boolean,
): Promise<PreflightReport> {
  const report: PreflightReport = { checked: 0, errors: [], deferred: [], skipped: [], unavailable: null };
  gate.begin?.();
  /** Earlier creates whose dry run did not join the session: what a dependent change may be waiting on. */
  const unscopedCreates: Array<{ order: number }> = [];
  for (const change of changes) {
    const key = change.key || null;
    if (hasPlaceholders(change)) {
      report.skipped.push({ type: change.type, key, reason: 'a ${VAR} placeholder is unresolved' });
      continue;
    }
    const order = typeOrder.get(change.type) ?? 0;
    const dependent = unscopedCreates.some((c) => c.order <= order);
    let failed = false;
    let retried = false;
    for (;;) {
      gate.setDryRun(true);
      try {
        await change.apply();
        report.checked += 1;
        break;
      } catch (err) {
        if (sessionLost(err) && !retried && gate.dropSession) {
          retried = true;
          gate.dropSession();
          continue;
        }
        failed = true;
        report.checked += 1;
        const issue: PreflightIssue = {
          type: change.type,
          key,
          action: change.action,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof AtlasApiError ? { status: err.status } : {}),
        };
        const status = err instanceof AtlasApiError ? err.status : undefined;
        if (status === 401 || status === 403) {
          report.unavailable = `the key cannot dry-run writes (${status}); the changes were not validated against the server`;
          return report;
        }
        if (status === 429) {
          report.unavailable = 'rate limited during validation; the remaining changes were not validated';
          return report;
        }
        if ((status !== undefined && status >= 500) || (dependent && (status === 404 || MISSING_DEPENDENCY.test(issue.message)))) report.deferred.push(issue);
        else report.errors.push(issue);
        break;
      } finally {
        gate.setDryRun(false);
      }
    }
    if (change.action === 'create' && (failed || !gate.scoped?.())) unscopedCreates.push({ order });
  }
  return report;
}
