/**
 * Structural shim for `next/headers`, so `server.ts` type-checks WITHOUT `next`
 * installed in this workspace. It is an INPUT `.d.ts`: tsc uses it for the build
 * typecheck but does not copy it into `dist`, so it never leaks into the
 * published types and can never collide with the real `next` types in a
 * consumer's app (where the genuine module resolves at runtime).
 *
 * Only the two accessors `server.ts` touches are declared, and only the members
 * it uses. In recent Next these are async, so each is typed as sync-or-Promise
 * and `server.ts` awaits them either way.
 */
declare module 'next/headers' {
  interface AtlasReadonlyCookie {
    name: string;
    value: string;
  }
  interface AtlasReadonlyCookies {
    get(name: string): AtlasReadonlyCookie | undefined;
    getAll(): AtlasReadonlyCookie[];
  }
  interface AtlasReadonlyHeaders {
    get(name: string): string | null;
  }
  export function cookies(): AtlasReadonlyCookies | Promise<AtlasReadonlyCookies>;
  export function headers(): AtlasReadonlyHeaders | Promise<AtlasReadonlyHeaders>;
}
