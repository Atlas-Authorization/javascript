'use client';

/**
 * Firebase Auth (`firebase/auth`, `react-firebase-hooks/auth`) compatibility
 * helpers. `atlas migrate code --from firebase` rewrites the session-reading
 * half of the Firebase client SDK onto these, keeping its call shapes: the
 * `auth` argument is accepted and ignored (the session is the `<AtlasProvider>`
 * on the page), observers get a `User`-shaped object, and `getIdToken(user)`
 * resolves the Atlas session JWT.
 *
 * `uid` is the ATLAS user id. A database keyed on Firebase uids should look
 * users up by their external id (Atlas keeps the Firebase uid there) or be
 * re-keyed; `firebaseUid` carries the old id when the import recorded it.
 */
import { useEffect, useState } from 'react';
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import { displayName, primaryEmail } from './compat';
import type { AtlasUser, SessionClaims } from './types';
import { getActiveAtlas, onActiveAtlasChange, requireActive, type ActiveAtlas } from './active-atlas';

/** The fields of a Firebase `User` apps read, plus the token methods. */
export interface FirebaseCompatUser {
  uid: string;
  /** The Firebase uid this user had before the move, when the import kept it. */
  firebaseUid: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
  isAnonymous: false;
  providerId: 'atlas';
  tenantId: null;
  metadata: { creationTime?: string; lastSignInTime?: string };
  providerData: Array<{ providerId: string; uid: string; email: string | null }>;
  /** The Atlas session JWT (the ID-token analogue). */
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<FirebaseCompatIdTokenResult>;
  reload(): Promise<void>;
  toJSON(): Record<string, unknown>;
}

export interface FirebaseCompatIdTokenResult {
  token: string;
  claims: Record<string, unknown>;
  expirationTime: string;
  issuedAtTime: string;
  authTime: string;
  signInProvider: 'atlas';
  signInSecondFactor: string | null;
}

function legacyUid(user: AtlasUser): string | null {
  const meta = user.public_metadata ?? {};
  for (const key of ['firebase_uid', 'external_id', 'legacy_id']) {
    const v = meta[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

async function tokenOf(atlas: ActiveAtlas): Promise<string> {
  const token = await atlas.getToken();
  if (!token) throw new Error('getIdToken: the user is signed out.');
  return token;
}

function isoFromSeconds(v: unknown): string {
  return new Date(typeof v === 'number' ? v * 1000 : Date.now()).toUTCString();
}

/** Project an Atlas user onto Firebase's `User` shape (null when signed out). */
export function firebaseUserFrom(user: AtlasUser | null, atlas: ActiveAtlas | null = getActiveAtlas()): FirebaseCompatUser | null {
  if (!user) return null;
  const email = primaryEmail(user);
  const phone = (user.phone_numbers ?? []).find((p) => p.primary) ?? user.phone_numbers?.[0];
  const claims: SessionClaims | null = atlas?.claims ?? null;
  const live = () => atlas ?? requireActive('FirebaseCompatUser');
  const projected: FirebaseCompatUser = {
    uid: user.id,
    firebaseUid: legacyUid(user),
    email: email?.address ?? null,
    emailVerified: email?.verified ?? false,
    displayName: displayName(user),
    photoURL: user.image_url,
    phoneNumber: phone?.phone_number ?? null,
    isAnonymous: false,
    providerId: 'atlas',
    tenantId: null,
    metadata: {},
    providerData: email ? [{ providerId: 'password', uid: email.address, email: email.address }] : [],
    getIdToken: () => tokenOf(live()),
    async getIdTokenResult() {
      const a = live();
      const token = await tokenOf(a);
      const c = (a.claims ?? claims ?? {}) as Record<string, unknown>;
      return {
        token,
        claims: c,
        expirationTime: isoFromSeconds(c.exp),
        issuedAtTime: isoFromSeconds(c.iat),
        authTime: isoFromSeconds(c.auth_time ?? c.iat),
        signInProvider: 'atlas',
        signInSecondFactor: null,
      };
    },
    async reload() {
      await live().reload();
    },
    toJSON() {
      const { getIdToken: _a, getIdTokenResult: _b, reload: _c, toJSON: _d, ...plain } = projected;
      return plain as unknown as Record<string, unknown>;
    },
  };
  return projected;
}

type Observer = ((user: FirebaseCompatUser | null) => void) | { next?: (user: FirebaseCompatUser | null) => void };

function notify(observer: Observer, user: FirebaseCompatUser | null): void {
  if (typeof observer === 'function') observer(user);
  else observer.next?.(user);
}

function observe(observer: Observer, everyTokenChange: boolean): () => void {
  let lastStatus: string | null = null;
  let lastId: string | null = null;
  let lastExp: unknown = null;
  const listener = (atlas: ActiveAtlas | null) => {
    if (!atlas || atlas.status === 'loading') return;
    const id = atlas.status === 'signed_in' ? (atlas.user?.id ?? null) : null;
    const exp = atlas.claims?.exp ?? null;
    const changed = lastStatus === null || id !== lastId || (everyTokenChange && exp !== lastExp);
    lastStatus = atlas.status;
    lastId = id;
    lastExp = exp;
    if (changed) notify(observer, atlas.status === 'signed_in' ? firebaseUserFrom(atlas.user, atlas) : null);
  };
  const unsubscribe = onActiveAtlasChange(listener);
  const current = getActiveAtlas();
  if (current) listener(current);
  return unsubscribe;
}

/** `onAuthStateChanged(auth, next)`: fires on sign-in and sign-out. Returns the unsubscribe. */
export function onFirebaseAuthStateChangedCompat(_auth: unknown, next: Observer, _error?: unknown): () => void {
  return observe(next, false);
}

/** `onIdTokenChanged(auth, next)`: also fires when the session token is refreshed. */
export function onFirebaseIdTokenChangedCompat(_auth: unknown, next: Observer, _error?: unknown): () => void {
  return observe(next, true);
}

/** `signOut(auth)`. */
export async function firebaseSignOutCompat(_auth?: unknown): Promise<void> {
  await requireActive('firebaseSignOutCompat').signOut();
}

/** `getIdToken(user, forceRefresh)`: the Atlas session JWT. */
export async function getFirebaseIdTokenCompat(_user?: unknown, _forceRefresh?: boolean): Promise<string> {
  return tokenOf(requireActive('getFirebaseIdTokenCompat'));
}

/** `auth.currentUser`, read imperatively. */
export function getFirebaseCurrentUserCompat(): FirebaseCompatUser | null {
  const atlas = getActiveAtlas();
  return atlas?.status === 'signed_in' ? firebaseUserFrom(atlas.user, atlas) : null;
}

/**
 * `signInWithRedirect(auth, provider)`: sends the browser to your Atlas
 * sign-in page (social buttons there replace the provider object), returning
 * to the current page afterwards.
 */
export async function firebaseSignInWithRedirectCompat(_auth?: unknown, _provider?: unknown, options: { signInUrl?: string } = {}): Promise<void> {
  const back = typeof window !== 'undefined' ? window.location.href : undefined;
  navigateTo(withRedirect(options.signInUrl ?? '/sign-in', back));
}

/** `useAuthState(auth)` from react-firebase-hooks: `[user, loading, error]`. */
export function useFirebaseAuthStateCompat(_auth?: unknown): [FirebaseCompatUser | null | undefined, boolean, undefined] {
  const atlas = useAtlas();
  if (atlas.status === 'loading') return [undefined, true, undefined];
  return [atlas.status === 'signed_in' ? firebaseUserFrom(atlas.user, getActiveAtlas()) : null, false, undefined];
}

/** `useIdToken(auth)` from react-firebase-hooks: `[user, loading, error]`, re-rendering on token refresh. */
export function useFirebaseIdTokenCompat(_auth?: unknown): [FirebaseCompatUser | null | undefined, boolean, undefined] {
  const state = useFirebaseAuthStateCompat();
  const [, setTick] = useState(0);
  useEffect(() => observe(() => setTick((t) => t + 1), true), []);
  return state;
}
