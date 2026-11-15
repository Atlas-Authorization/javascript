/**
 * Cedar extension types: `decimal` and `ip`.
 * Spec: https://docs.cedarpolicy.com/policies/syntax-datatypes.html (decimal, ipaddr).
 *
 *   decimal("1.23")  at most 4 fractional digits, value * 10^4 must fit a signed 64-bit integer;
 *                    methods lessThan, lessThanOrEqual, greaterThan, greaterThanOrEqual.
 *   ip("10.0.0.0/8") IPv4 or IPv6 address with an optional prefix length;
 *                    methods isIpv4, isIpv6, isLoopback, isMulticast, isInRange.
 */

export class AbacExtError extends Error {}

export class AbacDecimal {
  constructor(readonly scaled: bigint) {}
  toString(): string {
    const neg = this.scaled < 0n;
    const abs = neg ? -this.scaled : this.scaled;
    return `${neg ? '-' : ''}${abs / 10000n}.${(abs % 10000n).toString().padStart(4, '0')}`;
  }
}

export class AbacIp {
  constructor(
    readonly v6: boolean,
    readonly addr: bigint,
    readonly prefix: number,
    /** The text it was written as (for re-printing). */
    readonly text: string = '',
  ) {}
  get bits(): number {
    return this.v6 ? 128 : 32;
  }
  toString(): string {
    return `${this.v6 ? 'v6' : 'v4'}:${this.addr.toString(16)}/${this.prefix}`;
  }
}

export type AbacExt = AbacDecimal | AbacIp;

const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);

export function parseDecimal(s: string): AbacDecimal {
  const m = /^(-?)(\d+)\.(\d{1,4})$/.exec(s);
  if (!m) throw new AbacExtError(`"${s}" is not a valid decimal (digits, a point, then 1 to 4 fractional digits).`);
  const scaled = (m[1] ? -1n : 1n) * (BigInt(m[2]!) * 10000n + BigInt(m[3]!.padEnd(4, '0')));
  if (scaled > I64_MAX || scaled < I64_MIN) throw new AbacExtError(`"${s}" is out of range for a decimal.`);
  return new AbacDecimal(scaled);
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith('0')) || Number(p) > 255) return null;
    out = (out << 8n) | BigInt(p);
  }
  return out;
}

function parseV6(s: string): bigint | null {
  if (s.includes('.')) {
    // ::ffff:1.2.3.4 style tail
    const i = s.lastIndexOf(':');
    const v4 = parseV4(s.slice(i + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, i + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  let out = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(`0x${g}`);
  }
  return out;
}

export function parseIp(s: string): AbacIp {
  const [a, p, ...rest] = s.split('/');
  if (rest.length || a === undefined) throw new AbacExtError(`"${s}" is not a valid IP address.`);
  const v6 = a.includes(':');
  const addr = v6 ? parseV6(a) : parseV4(a);
  if (addr === null) throw new AbacExtError(`"${s}" is not a valid IP address.`);
  const bits = v6 ? 128 : 32;
  let prefix = bits;
  if (p !== undefined) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > bits) throw new AbacExtError(`"${s}" has an invalid prefix length.`);
    prefix = Number(p);
  }
  return new AbacIp(v6, addr, prefix, s);
}

export function extConstructor(name: string, arg: unknown): AbacExt {
  if (typeof arg !== 'string') throw new AbacExtError(`${name}() takes a string.`);
  return name === 'decimal' ? parseDecimal(arg) : parseIp(arg);
}

export function extEqual(a: AbacExt, b: AbacExt): boolean {
  if (a instanceof AbacDecimal) return b instanceof AbacDecimal && a.scaled === b.scaled;
  return b instanceof AbacIp && a.v6 === b.v6 && a.addr === b.addr && a.prefix === b.prefix;
}

/** The network a possibly-prefixed address denotes: [first, last]. */
function span(ip: AbacIp): [bigint, bigint] {
  const host = BigInt(ip.bits - ip.prefix);
  const first = (ip.addr >> host) << host;
  return [first, first | ((1n << host) - 1n)];
}

const inRange = (x: AbacIp, lo: bigint, hi: bigint, v6: boolean) => x.v6 === v6 && span(x)[0] >= lo && span(x)[1] <= hi;

export const EXT_METHODS = ['lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'isIpv4', 'isIpv6', 'isLoopback', 'isMulticast', 'isInRange'] as const;

export function extMethod(name: string, recv: AbacExt, args: unknown[]): boolean {
  if (recv instanceof AbacDecimal) {
    const o = args[0];
    if (args.length !== 1 || !(o instanceof AbacDecimal)) throw new AbacExtError(`.${name}() takes one decimal.`);
    switch (name) {
      case 'lessThan':
        return recv.scaled < o.scaled;
      case 'lessThanOrEqual':
        return recv.scaled <= o.scaled;
      case 'greaterThan':
        return recv.scaled > o.scaled;
      case 'greaterThanOrEqual':
        return recv.scaled >= o.scaled;
    }
    throw new AbacExtError(`.${name}() is not a decimal method.`);
  }
  switch (name) {
    case 'isIpv4':
      return !recv.v6;
    case 'isIpv6':
      return recv.v6;
    case 'isLoopback':
      return recv.v6 ? inRange(recv, 1n, 1n, true) : inRange(recv, 0x7f000000n, 0x7fffffffn, false);
    case 'isMulticast':
      return recv.v6 ? inRange(recv, 0xffn << 120n, (1n << 128n) - 1n, true) : inRange(recv, 0xe0000000n, 0xefffffffn, false);
    case 'isInRange': {
      const r = args[0];
      if (args.length !== 1 || !(r instanceof AbacIp)) throw new AbacExtError('.isInRange() takes one ip.');
      const [lo, hi] = span(r);
      return inRange(recv, lo, hi, r.v6);
    }
  }
  throw new AbacExtError(`.${name}() is not an ip method.`);
}
