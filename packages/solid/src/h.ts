import rawH from 'solid-js/h';
import type { JSX } from 'solid-js';

/**
 * `solid-js/h` is the runtime hyperscript — it lets this package author
 * components WITHOUT JSX, so the build is a plain `tsc` (no Babel/vite-plugin-
 * solid transform) exactly like `@atlasauth/vue`'s `h()` render functions.
 *
 * Its published types declare the output as a thunk (`() => Node`), which is how
 * Solid carries a reactive node. At runtime Solid unwraps that function
 * everywhere it accepts children — `insert`, `render`, `createComponent` — so it
 * IS a valid reactive `JSX.Element`. We retype `h` to say so, which keeps every
 * component signature returning an honest `JSX.Element` instead of a thunk.
 */
export const h = rawH as unknown as (
  type: unknown,
  props?: unknown,
  ...children: unknown[]
) => JSX.Element;
