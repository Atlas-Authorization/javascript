/**
 * Method allow-listing.
 *
 * The embedded widget renders every method the instance has enabled. When a
 * page narrows the set with `options.methods`, we PRUNE the DOM the widget drew
 * for the disallowed ones — the widget keys every method off a stable attribute
 * or class, so this is a presentational pass, never a reach into the flow:
 *
 *   - social   → `[data-atlas-provider]` buttons + the `.atlas-embed-social`
 *                container and the `.atlas-embed-divider` that separates it.
 *   - passkey  → the `[data-atlas-passkey]` button.
 *   - password → the `.atlas-embed-field` wrapping `input[name="password"]`.
 *
 * `emailCode` / `emailLink` have no discrete button on the single-screen form
 * (they are first factors driven by the identifier step), so they follow the
 * instance configuration and are intentionally not pruned here.
 *
 * Because the widget re-renders the whole subtree on every step change, the
 * filter is re-applied by a `MutationObserver` the Lock installs, and it is
 * idempotent and defensive so a re-run or a missing node never throws.
 */
import type { AtlasLockMethod } from './options';

function removeAll(root: ParentNode, selector: string): void {
  root.querySelectorAll(selector).forEach((node) => node.remove());
}

/** Remove the method buttons/fields not present in `methods`. Null = allow all. */
export function applyMethodFilter(root: ParentNode, methods: AtlasLockMethod[] | null): void {
  if (!methods) return;
  const allow = new Set(methods);

  try {
    if (!allow.has('social')) {
      removeAll(root, '[data-atlas-provider]');
      removeAll(root, '.atlas-embed-social');
      removeAll(root, '.atlas-embed-divider');
    }
    if (!allow.has('passkey')) {
      removeAll(root, '[data-atlas-passkey]');
    }
    if (!allow.has('password')) {
      root.querySelectorAll('input[name="password"]').forEach((input) => {
        const field = input.closest('.atlas-embed-field');
        (field ?? input).remove();
      });
    }
  } catch {
    /* pruning is best-effort cosmetics; never block the flow */
  }
}
