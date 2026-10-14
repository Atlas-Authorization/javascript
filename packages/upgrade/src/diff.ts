/**
 * A tiny line-level unified diff, used to show what `--dry` *would* change.
 *
 * We hand-roll this (rather than add a `diff` dependency) to keep the package
 * dependency-light, as the brief requires. It is an LCS line diff — correct, if
 * not as compact as Myers — which is plenty for the small, localised edits a
 * codemod produces.
 */

/**
 * Longest-common-subsequence length table over two line arrays. `table[i][k]`
 * is the LCS length of `a[i..]` and `b[k..]`. Rows are captured into locals so
 * the code type-checks under `noUncheckedIndexedAccess`.
 */
function lcsLengths(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let k = b.length - 1; k >= 0; k--) {
      row[k] = a[i] === b[k] ? next[k + 1]! + 1 : Math.max(next[k]!, row[k + 1]!);
    }
  }
  return table;
}

/**
 * Produce a unified-style diff of `before` -> `after` for `label`. Returns an
 * empty string when the two are identical.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const table = lcsLengths(a, b);

  const lines: string[] = [`--- ${label}`, `+++ ${label}`];
  let i = 0;
  let k = 0;
  while (i < a.length && k < b.length) {
    if (a[i] === b[k]) {
      lines.push(`  ${a[i]}`);
      i++;
      k++;
    } else if (table[i + 1]![k]! >= table[i]![k + 1]!) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[k]}`);
      k++;
    }
  }
  while (i < a.length) lines.push(`- ${a[i++]}`);
  while (k < b.length) lines.push(`+ ${b[k++]}`);
  return lines.join('\n');
}
