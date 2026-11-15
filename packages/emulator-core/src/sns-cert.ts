/**
 * The X.509 certificate the emulator "serves" as Amazon SNS's signing certificate. Amazon signs each SNS message with a private
 * key and tells the receiver where to fetch the matching certificate (`SigningCertURL`); the receiver checks the URL is an
 * `sns.<region>.amazonaws.com` HTTPS URL, fetches the certificate and verifies the signature against its public key. The emulator
 * builds a real self-signed certificate (hand-encoded DER, Web Crypto only, no node: imports) around its test RSA key, and the
 * URL resolves to it without any network access.
 */
const enc = new TextEncoder();

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function toPem(label: string, der: Uint8Array): string {
  return `-----BEGIN ${label}-----\n${(toB64(der).match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
}
/** The DER inside a PEM block with this label, or null. */
export function fromPem(pem: string, label: string): Uint8Array | null {
  const m = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`).exec(pem);
  if (!m) return null;
  try {
    return fromB64(m[1]!.replace(/\s+/g, ''));
  } catch {
    return null;
  }
}

// ── DER ──
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const lenBytes = (n: number): Uint8Array => (n < 0x80 ? Uint8Array.of(n) : n < 0x100 ? Uint8Array.of(0x81, n) : Uint8Array.of(0x82, n >> 8, n & 0xff));
const tlv = (tag: number, ...body: Uint8Array[]): Uint8Array => {
  const v = cat(...body);
  return cat(Uint8Array.of(tag), lenBytes(v.length), v);
};
const SHA256_WITH_RSA = tlv(0x30, Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), Uint8Array.of(0x05, 0x00));
const name = (cn: string): Uint8Array => tlv(0x30, tlv(0x31, tlv(0x30, Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x03), tlv(0x0c, enc.encode(cn)))));

/** A self-signed certificate (PEM) for an RSA key pair, valid 2020-2049, subject `sns.us-east-1.amazonaws.com`. */
export async function selfSignedCertificate(spki: Uint8Array, pkcs8: Uint8Array): Promise<string> {
  const subject = name('sns.us-east-1.amazonaws.com');
  const tbs = tlv(
    0x30,
    tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
    tlv(0x02, Uint8Array.of(0x01, 0x5c, 0x3a, 0x7e)),
    SHA256_WITH_RSA,
    subject,
    tlv(0x30, tlv(0x17, enc.encode('200101000000Z')), tlv(0x17, enc.encode('491231235959Z'))),
    subject,
    spki,
  );
  const key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, tbs as BufferSource));
  return toPem('CERTIFICATE', tlv(0x30, tbs, SHA256_WITH_RSA, tlv(0x03, Uint8Array.of(0), sig)));
}

interface Node {
  tag: number;
  start: number;
  value: number;
  end: number;
}
function read(b: Uint8Array, p: number): Node | null {
  if (p + 2 > b.length) return null;
  let len = b[p + 1]!;
  let value = p + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + 2 + n > b.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[p + 2 + i]!;
    value = p + 2 + n;
  }
  return value + len <= b.length ? { tag: b[p]!, start: p, value, end: value + len } : null;
}
/** The SubjectPublicKeyInfo of a certificate PEM, or null when it is not a parseable certificate. */
export function certificatePublicKey(pem: string): Uint8Array | null {
  const der = fromPem(pem, 'CERTIFICATE');
  if (!der) return null;
  const cert = read(der, 0);
  const tbs = cert && cert.tag === 0x30 ? read(der, cert.value) : null;
  if (!tbs || tbs.tag !== 0x30) return null;
  let p = tbs.value;
  const kids: Node[] = [];
  while (p < tbs.end) {
    const n = read(der, p);
    if (!n) return null;
    kids.push(n);
    p = n.end;
  }
  const off = kids[0]?.tag === 0xa0 ? 1 : 0; // [0] version is optional (v1)
  const spki = kids[off + 5]; // serial, sigAlg, issuer, validity, subject, spki
  return spki && spki.tag === 0x30 ? der.slice(spki.start, spki.end) : null;
}

/** The only place SNS serves certificates from the emulator's point of view: the path of the built-in certificate. */
export const SNS_CERT_PATH = '/SimpleNotificationService-emulator.pem';
