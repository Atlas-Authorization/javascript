/**
 * A tiny JSON shape language for expected answers.
 *
 *  - a string names a type or a union of them: `"string"`, `"number"`,
 *    `"boolean"`, `"object"`, `"array"`, `"null"`, `"any"`, `"string|null"`;
 *  - an object is a shape of required keys; a key ending in `?` is optional;
 *  - a one-element array is "an array whose every item has this shape".
 *
 * Extra keys are always allowed: a server may answer with more than the
 * protocol requires.
 */
export type Shape = string | { [key: string]: Shape } | [Shape];

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** The problems with `value` against `shape`, as readable paths (empty = it matches). */
export function matchShape(value: unknown, shape: Shape, path = '$'): string[] {
  if (typeof shape === 'string') {
    const allowed = shape.split('|');
    if (allowed.includes('any')) return [];
    return allowed.includes(typeOf(value)) ? [] : [`${path}: expected ${shape}, got ${typeOf(value)}`];
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${path}: expected array, got ${typeOf(value)}`];
    return value.flatMap((item, i) => matchShape(item, shape[0], `${path}[${i}]`));
  }
  if (typeOf(value) !== 'object') return [`${path}: expected object, got ${typeOf(value)}`];
  const obj = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const [rawKey, sub] of Object.entries(shape)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    if (!(key in obj) || obj[key] === undefined) {
      if (!optional) problems.push(`${path}.${key}: missing`);
      continue;
    }
    problems.push(...matchShape(obj[key], sub, `${path}.${key}`));
  }
  return problems;
}
