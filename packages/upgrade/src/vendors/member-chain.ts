/** `a.b.c` (non-computed member chain on an identifier) → `['a','b','c']`, else null. */
export function memberChain(node: unknown): string[] | null {
  const names: string[] = [];
  let cur = node as { type?: string; computed?: boolean; object?: unknown; property?: { type?: string; name?: string }; name?: string };
  while (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
    if (cur.computed || cur.property?.type !== 'Identifier' || !cur.property.name) return null;
    names.unshift(cur.property.name);
    cur = cur.object as typeof cur;
  }
  return cur.type === 'Identifier' && cur.name ? [cur.name, ...names] : null;
}
