/**
 * The registry the imperative compat helpers read: `<AtlasProvider>` publishes
 * its state here on every change. Kept dependency-free so the provider and the
 * compat module do not import each other.
 */
import { announceSessionChange, installSessionGlobal, type SessionGlobalTokenOptions } from '@atlasauth/js';
import type { AtlasUser, SessionClaims } from './types';

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/** What `getToken` mints: the session JWT by default. */
export interface GetTokenOptions {
  /** A named JWT template. */
  template?: string;
  /** An identity integration id (a preset such as `chatly`, or a custom one): its integration token. */
  for?: string;
  /** With `for: 'forumulate'` and several connected spaces: the space. */
  spaceId?: string;
  /**
   * With `for`: a per-call audience — the whole `aud` (e.g. `cookiemunch:dv-1`).
   * The integration must permit it (its `per_call_audience`); otherwise null.
   */
  audience?: string;
  /** With `for: 'cookiemunch'`: the site id; the token's `aud` is `cookiemunch:<cbid>`. */
  cbid?: string;
  /** With `for`: the integration's own per-call parameter, e.g. `{ tenant: 't1' }`. */
  audienceParams?: Record<string, string>;
  /**
   * With `for`: the Sign in with Atlas access token of a user who is not on
   * this instance (an app that signs users in with Sign in with Atlas only).
   * The integration token is minted for that user; no session is needed. The
   * call must come from a web origin of that Sign in with Atlas app.
   */
  atlasIdAccessToken?: string;
  /**
   * With `atlasIdAccessToken`: signs a DPoP proof for the request, when the
   * access token is DPoP-bound (`({ htm, htu, accessToken }) => proof`).
   */
  dpop?: (input: { htm: 'POST'; htu: string; accessToken: string }) => Promise<string> | string;
}

/**
 * An identity integration the page opts in to (`<AtlasProvider integrations>`): its id, or its id with the
 * defaults a third-party script should not have to know (`{ for: 'forumulate', spaceId: 'sp_1' }`).
 */
export type AtlasIntegrationSpec = string | ({ for: string } & Omit<GetTokenOptions, 'for' | 'template'>);

/** The slice of the provider the compat helpers read. */
export interface ActiveAtlas {
  status: AuthStatus;
  user: AtlasUser | null;
  claims: SessionClaims | null;
  getToken(options?: GetTokenOptions): Promise<string | null>;
  signOut(): Promise<unknown>;
  reload(): Promise<boolean>;
}

let active: ActiveAtlas | null = null;
let integrations: AtlasIntegrationSpec[] | null = null;

/**
 * Called by `<AtlasProvider integrations>`. With a list, `window.Atlas.session.getToken({ for })` mints only the
 * listed integrations (with their defaults); any other `for` answers null. Without one, every integration the
 * instance defines is reachable, as before.
 * @internal
 */
export function setIntegrations(next: AtlasIntegrationSpec[] | null): void {
  integrations = next;
}

/** The options a page script's `getToken(options)` really runs with, or null when it may not mint that integration. */
export function resolveGlobalTokenOptions<T extends { for?: string }>(options: T | undefined): T | undefined | null {
  if (!integrations || !options?.for) return options;
  const entry = integrations.find((i) => (typeof i === 'string' ? i : i.for) === options.for);
  if (!entry) return null;
  return typeof entry === 'string' ? options : { ...entry, ...options };
}
let unregisterGlobal: (() => void) | null = null;

/** `window.Atlas.session` reads whichever provider is mounted right now. */
function exposeGlobal(): void {
  if (unregisterGlobal || typeof window === 'undefined') return;
  unregisterGlobal = installSessionGlobal({
    getToken: async (o: SessionGlobalTokenOptions) => {
      const resolved = resolveGlobalTokenOptions(o);
      return active && resolved !== null ? active.getToken(resolved) : null;
    },
    user: () => (active?.status === 'signed_in' && active.user ? { ...active.user, external_id: (active.claims as { external_id?: string } | null)?.external_id ?? null } : null),
  });
}
const listeners = new Set<(atlas: ActiveAtlas | null) => void>();

/**
 * Called by `<AtlasProvider>` whenever its state changes, so the imperative
 * helpers can act without a hook. Not part of the public surface.
 * @internal
 */
export function publishActiveAtlas(next: ActiveAtlas | null): void {
  active = next;
  if (next) exposeGlobal();
  else {
    unregisterGlobal?.();
    unregisterGlobal = null;
  }
  if (next && next.status !== 'loading') announceSessionChange(next.status === 'signed_in' ? (next.user?.id ?? null) : null);
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // A listener's error must not break the provider's render.
    }
  }
}

export function requireActive(helper: string): ActiveAtlas {
  if (!active) {
    throw new Error(`${helper}: no <AtlasProvider> is mounted on this page.`);
  }
  return active;
}

/** The active provider's state, or null when none is mounted. */
export function getActiveAtlas(): ActiveAtlas | null {
  return active;
}


/** Subscribe to provider state changes; returns the unsubscribe. */
export function onActiveAtlasChange(listener: (atlas: ActiveAtlas | null) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
