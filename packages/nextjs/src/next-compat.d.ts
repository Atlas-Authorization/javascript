/**
 * Structural shims for the two Next.js modules `compat.ts` loads lazily, so the
 * package type-checks without depending on Next's own types (same approach as
 * `next-headers.d.ts`; input-only, never emitted into `dist`).
 */
declare module 'next/server' {
  export const NextResponse: unknown;
}
declare module 'next/navigation' {
  export function redirect(url: string): never;
}
