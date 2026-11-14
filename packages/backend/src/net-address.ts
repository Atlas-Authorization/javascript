// The address classifier of the Atlas server's outbound SSRF guard, kept identical here so the
// local Web Bot Auth verifier refuses exactly the destinations the server does. Node only.
import { isIP } from 'node:net';

/**
 * Why an address is not a public internet address. `undefined` from
 * {@link classifySpecialAddress} means "public".
 */
export type SpecialAddressReason =
  | 'loopback'
  | 'private_address'
  | 'link_local'
  | 'multicast'
  | 'reserved';

/**
 * Classify one IP literal against the RFC 6890 special-purpose registries
 * (v4 and v6). Anything that is not a plain public unicast address is refused:
 * loopback, RFC 1918, CGNAT, link-local (incl. the 169.254.169.254 metadata
 * service), ULA, multicast, documentation/benchmark ranges, the unspecified
 * address, and v6 forms that EMBED a v4 address (v4-mapped, v4-compatible,
 * NAT64 64:ff9b::/96, 6to4 2002::/16, Teredo 2001::/32) are judged by the
 * embedded v4 address or refused outright.
 *
 * Works on the parsed bytes rather than on string prefixes, so every spelling
 * of an address (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, `[::1]`) lands on
 * the same verdict. A string that is not an IP literal returns `undefined`
 * (it is a hostname, which the caller must resolve and classify).
 */
export function classifySpecialAddress(value: string): SpecialAddressReason | undefined {
  const literal = value.replace(/^\[|\]$/g, '').split('%')[0]!;
  const kind = isIP(literal);
  if (kind === 4) return classifyV4(v4Bytes(literal));
  if (kind === 6) return classifyV6(v6Bytes(literal));
  return undefined;
}

/** True when `value` is an IP literal (v4 or v6, brackets allowed). */
export function isIpLiteral(value: string): boolean {
  return isIP(value.replace(/^\[|\]$/g, '').split('%')[0]!) !== 0;
}

function v4Bytes(s: string): number[] {
  return s.split('.').map(Number);
}

function classifyV4(b: number[]): SpecialAddressReason | undefined {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return 'reserved'; // "this network" 0.0.0.0/8
  if (a === 10) return 'private_address';
  if (a === 100 && c >= 64 && c <= 127) return 'private_address'; // CGNAT 100.64/10
  if (a === 127) return 'loopback';
  if (a === 169 && c === 254) return 'link_local'; // incl. 169.254.169.254 metadata
  if (a === 172 && c >= 16 && c <= 31) return 'private_address';
  if (a === 192 && c === 0 && b[2] === 0) return 'reserved'; // IETF protocol assignments
  if (a === 192 && c === 0 && b[2] === 2) return 'reserved'; // TEST-NET-1
  if (a === 192 && c === 88 && b[2] === 99) return 'reserved'; // 6to4 relay anycast
  if (a === 192 && c === 168) return 'private_address';
  if (a === 198 && (c === 18 || c === 19)) return 'reserved'; // benchmarking
  if (a === 198 && c === 51 && b[2] === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && c === 0 && b[2] === 113) return 'reserved'; // TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // 240/4 + broadcast
  return undefined;
}

/** Expand any valid v6 literal (incl. a trailing dotted v4) to its 16 bytes. */
function v6Bytes(s: string): number[] {
  let text = s.toLowerCase();
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail.push(...v4Bytes(dotted[1]!));
    text = text.slice(0, -dotted[1]!.length);
    // `::ffff:1.2.3.4` leaves `::ffff:`; a trailing single colon is part of the
    // group separator, not an empty group.
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const groupsNeeded = 8 - tail.length / 2;
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').filter(Boolean) : []);
  const h = parse(head);
  const r = parse(rest);
  const fill = rest === undefined ? [] : new Array(groupsNeeded - h.length - r.length).fill('0');
  const groups = [...h, ...fill, ...r];
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return [...bytes, ...tail];
}

function classifyV6(b: number[]): SpecialAddressReason | undefined {
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  // ::/128 unspecified, ::1/128 loopback.
  if (zeroUpTo(15)) return b[15] === 1 ? 'loopback' : 'reserved';
  // ::ffff:0:0/96 v4-mapped → judge the embedded v4 address.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)) ?? undefined;
  // ::/96 deprecated v4-compatible — never a legitimate destination.
  if (zeroUpTo(12)) return 'reserved';
  // 64:ff9b::/96 NAT64 (and 64:ff9b:1::/48 local-use) — judge the embedded v4,
  // but the local-use prefix is never public.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0 && b[5] === 1) return 'private_address';
    return classifyV4(b.slice(12));
  }
  // 100::/64 discard-only.
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return 'reserved';
  if (b[0] === 0x20 && b[1] === 0x01) {
    // 2001:db8::/32 documentation.
    if (b[2] === 0x0d && b[3] === 0xb8) return 'reserved';
    // 2001::/23 IETF protocol assignments (Teredo 2001::/32, ORCHID, …): the
    // embedded endpoint is obfuscated, so refuse rather than decode.
    if (b[2]! < 0x02) return 'reserved';
  }
  // 2002::/16 6to4 — the next 4 bytes are the embedded v4 address.
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)) ?? undefined;
  // fc00::/7 unique local (the v6 RFC 1918).
  if ((b[0]! & 0xfe) === 0xfc) return 'private_address';
  // fe80::/10 link-local, fec0::/10 deprecated site-local.
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link_local';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'private_address';
  // ff00::/8 multicast.
  if (b[0] === 0xff) return 'multicast';
  return undefined;
}
