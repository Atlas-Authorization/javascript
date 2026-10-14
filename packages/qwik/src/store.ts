import type { NoSerialize } from '@builder.io/qwik';
import type { AtlasClient } from './client';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasSnapshot,
  AtlasUser,
  AuthStatus,
  SessionClaims,
} from './types';

/**
 * The reactive Qwik store placed in context by `<AtlasProvider>`.
 *
 * Everything on it is a plain, serializable value EXCEPT `client`, which is the
 * live `AtlasClient` wrapped in `noSerialize`. Qwik serializes a store to ship
 * SSR state to the browser and to resume lazily-loaded QRLs; the client holds
 * closures, a `TokenCache` and a refresh timer and cannot survive that. So the
 * provider re-creates the client on the client side (in `useVisibleTask$`) and
 * stores it `noSerialize`d — on the server, and after a serialization round
 * trip, `client` reads back as `undefined`, which the hooks tolerate.
 */
export interface AtlasStore extends AtlasSnapshot {
  /** The instance publishable key — a plain string the widgets read. */
  publishableKey: string;
  /** The instance FAPI origin — a plain string the widgets read. */
  frontendApi: string;
  /** The live client, or `undefined` on the server / before the visible task. */
  client: NoSerialize<AtlasClient> | undefined;
}

/** The initial, pre-boot store value. `status` is `loading`, not signed-out. */
export function initialStore(publishableKey: string, frontendApi: string): AtlasStore {
  return {
    status: 'loading',
    user: null,
    session: null,
    claims: null,
    memberships: [],
    publishableKey,
    frontendApi,
    client: undefined,
  };
}

/**
 * Copy a snapshot into the store in place. This is the function the provider's
 * `subscribe` callback runs on every transition; factored out so it can be unit
 * tested without rendering a Qwik component.
 */
export function applySnapshot(store: AtlasStore, snapshot: AtlasSnapshot): void {
  store.status = snapshot.status;
  store.user = snapshot.user;
  store.session = snapshot.session;
  store.claims = snapshot.claims;
  store.memberships = snapshot.memberships;
}

// --- Pure selectors -------------------------------------------------------
// The hooks are one-liners over these so the derivation logic is testable with
// a plain store object, no Qwik context required.

export const isLoaded = (store: AtlasStore): boolean => store.status !== 'loading';
export const isSignedIn = (store: AtlasStore): boolean => store.status === 'signed_in';
export const userId = (store: AtlasStore): string | null => store.claims?.sub ?? null;
export const sessionId = (store: AtlasStore): string | null => store.claims?.sid ?? null;
export const orgId = (store: AtlasStore): string | null =>
  (store.claims?.org_id as string | undefined) ?? null;
export const orgRole = (store: AtlasStore): string | null =>
  (store.claims?.org_role as string | undefined) ?? null;
export const currentUser = (store: AtlasStore): AtlasUser | null => store.user;
export const currentSession = (store: AtlasStore): AtlasSession | null => store.session;
export const currentClaims = (store: AtlasStore): SessionClaims | null => store.claims;
export const currentMemberships = (store: AtlasStore): AtlasOrganizationMembership[] =>
  store.memberships;
export const currentStatus = (store: AtlasStore): AuthStatus => store.status;
