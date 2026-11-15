/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Provider delivery callbacks: how each provider signs them, how the emulator verifies them, what they say, and the
 * helper that builds a correctly signed (or deliberately tampered) callback for a test. Pure functions on Web Crypto
 * (no node: imports, so the engine still runs in a browser worker). The route glue and the ledger live in
 * handlers/messaging.ts.
 *
 *   resend       Svix signature (HMAC-SHA256 over id.timestamp.body) with a whsec_ secret, 5 minute tolerance
 *   mailgun      HMAC-SHA256 of timestamp+token with the HTTP webhook signing key
 *   ses          Amazon SNS message signature + the instance URL token; the signature is checked against the X.509 certificate
 *                SigningCertURL names (an sns.<region>.amazonaws.com HTTPS URL), served by the emulator (see sns-cert.ts)
 *   sendgrid     ECDSA P-256 over timestamp+body with the account's public key, else the URL token
 *   twilio       X-Twilio-Signature: base64 HMAC-SHA1 over the URL and the sorted form fields, with the SMS provider's auth token
 *   vonage       `sig` over the sorted parameters (md5hash, md5, sha1, sha256, sha512), else the URL token
 *   messagebird  MessageBird-Signature: base64 HMAC-SHA256 over timestamp, sorted query and sha256(body), else the URL token
 *   brevo, smtp2go, postmark   a token derived for this instance (bearer, basic-auth password or ?t=)
 */
import { certificatePublicKey, selfSignedCertificate } from './sns-cert';
const enc = new TextEncoder();
const FIVE_MINUTES = 5 * 60;

export type EventStatus = 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed';
export interface DeliveryEvent {
  channel: 'email' | 'sms';
  provider: string;
  messageIds: string[];
  status: EventStatus;
  bounceType?: 'hard' | 'soft' | 'unknown';
  recipient?: string;
  detail?: string;
  /** Epoch milliseconds. */
  at: number;
  suppress?: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'invalid';
}

// ── bytes and hashes ──
const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const cat = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const bytes = (v: string | Uint8Array): Uint8Array => (typeof v === 'string' ? enc.encode(v) : v);
const subtle = (): SubtleCrypto => crypto.subtle;
export const sha256Hex = async (v: string | Uint8Array): Promise<string> => hex(new Uint8Array(await subtle().digest('SHA-256', bytes(v) as BufferSource)));
/** Constant-time string comparison. */
const eq = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** MD5 (Web Crypto has none; Vonage's `md5` and `md5hash` signatures need it). */
function md5(input: Uint8Array): Uint8Array {
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const total = (((input.length + 8) >>> 6) + 1) * 64;
  const padded = new Uint8Array(total);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, (input.length * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor(input.length / 2 ** 29), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < total; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) ((F = (B & C) | (~B & D)), (g = i));
      else if (i < 32) ((F = (D & B) | (~D & C)), (g = (5 * i + 1) % 16));
      else if (i < 48) ((F = B ^ C ^ D), (g = (3 * i + 5) % 16));
      else ((F = C ^ (B | ~D)), (g = (7 * i) % 16));
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      const s = S[(i >> 4) * 4 + (i % 4)]!;
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w, true));
  return out;
}
const hmacMd5 = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  const k = key.length > 64 ? md5(key) : key;
  const ip = new Uint8Array(64 + data.length);
  const op = new Uint8Array(80);
  for (let i = 0; i < 64; i++) {
    ip[i] = (k[i] ?? 0) ^ 0x36;
    op[i] = (k[i] ?? 0) ^ 0x5c;
  }
  ip.set(data, 64);
  op.set(md5(ip), 64);
  return md5(op);
};
type HashName = 'md5' | 'sha1' | 'sha256' | 'sha512';
const SUBTLE_HASH: Record<string, string> = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' };
async function hmac(alg: HashName, key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  if (alg === 'md5') return hmacMd5(bytes(key), bytes(data));
  const k = await subtle().importKey('raw', bytes(key) as BufferSource, { name: 'HMAC', hash: SUBTLE_HASH[alg]! }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, bytes(data) as BufferSource));
}

// ── ECDSA signature encodings (SendGrid sends ASN.1 DER, Web Crypto wants r||s) ──
function derToRaw(der: Uint8Array): Uint8Array {
  let p = der[1]! & 0x80 ? 2 + (der[1]! & 0x7f) : 2;
  const ints: Uint8Array[] = [];
  for (let n = 0; n < 2; n++) {
    if (der[p] !== 2) throw new Error('bad DER');
    const len = der[p + 1]!;
    let v = der.slice(p + 2, p + 2 + len);
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error('bad DER');
    ints.push(cat(new Uint8Array(32 - v.length), v));
    p += 2 + len;
  }
  return cat(ints[0]!, ints[1]!);
}
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < 31 && x[i] === 0) i++;
    let v: Uint8Array = x.slice(i);
    if (v[0]! & 0x80) v = cat([0], v);
    return cat([2, v.length], v);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat([0x30, body.length], body);
}

// ── the emulator's own test keys (lazy: an RSA key is slow to make) ──
export interface TestKeys {
  ec(): Promise<{ publicB64: string; privateKey: CryptoKey }>;
  rsa(): Promise<{ publicB64: string; pkcs8: Uint8Array; certPem: string }>;
}
export function testKeys(): TestKeys {
  let ec: Promise<any> | undefined;
  let rsa: Promise<any> | undefined;
  return {
    ec: () =>
      (ec ??= (async () => {
        const p = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as any;
        return { publicB64: toB64(new Uint8Array(await subtle().exportKey('spki', p.publicKey))), privateKey: p.privateKey };
      })()),
    rsa: () =>
      (rsa ??= (async () => {
        const p = (await subtle().generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as any;
        const spki = new Uint8Array(await subtle().exportKey('spki', p.publicKey));
        const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', p.privateKey));
        return { publicB64: toB64(spki), pkcs8, certPem: await selfSignedCertificate(spki, pkcs8) };
      })()),
  };
}

/** The test signing secret the emulator uses for a provider when none was stored (stable per instance). */
export async function testSecret(instanceId: string, provider: string): Promise<string> {
  const h = await sha256Hex(`atlas-emulator:${instanceId}:${provider}`);
  if (provider === 'resend') return `whsec_${toB64(fromHex(h).slice(0, 24))}`;
  if (provider === 'vonage') return `sha256:${h.slice(0, 32)}`;
  return h.slice(0, 32);
}
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
/** The URL token of the providers that cannot sign (and the fallback when no signing secret is stored). */
export const receiverToken = async (instanceId: string, provider: string): Promise<string> => toB64(fromHex(await sha256Hex(`atlas:message-receiver:${provider}:v1:${instanceId}`))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── parsing helpers ──
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
let NOW = 0;
function when(v: unknown, fallback: number = NOW): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string' && v) {
    const n = Number(v);
    const t = Number.isFinite(n) && /^\d+(\.\d+)?$/.test(v) ? (n > 1e12 ? n : n * 1000) : Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}
export function idVariants(id: unknown): string[] {
  const s = typeof id === 'string' ? id.trim() : '';
  if (!s) return [];
  const bare = s.replace(/^<|>$/g, '');
  return [...new Set([s, bare, `<${bare}>`])];
}
const stringify = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)]));
const form = (raw: string): Record<string, string> => Object.fromEntries(new URLSearchParams(raw));

// ── verification primitives ──
export async function verifySvix(i: { secret: string; id: string; timestamp: string; signatureHeader: string; body: string; now: number }): Promise<boolean> {
  const ts = Number(i.timestamp);
  if (!Number.isFinite(ts) || Math.abs(i.now - ts) > FIVE_MINUTES) return false;
  try {
    const expected = toB64(await hmac('sha256', fromB64(i.secret.replace(/^whsec_/, '')), `${i.id}.${i.timestamp}.${i.body}`));
    return i.signatureHeader.split(' ').some((part) => {
      const [v, sig] = part.split(',');
      return v === 'v1' && !!sig && eq(sig, expected);
    });
  } catch {
    return false;
  }
}
const mailgunSig = async (key: string, ts: string, token: string): Promise<string> => hex(await hmac('sha256', key, ts + token));
async function verifyMailgun(key: string, sig: Record<string, unknown>, now: number): Promise<boolean> {
  const timestamp = str(sig.timestamp) ?? (typeof sig.timestamp === 'number' ? String(sig.timestamp) : undefined);
  const token = str(sig.token);
  const signature = str(sig.signature);
  if (!timestamp || !token || !signature) return false;
  if (Math.abs(now - Number(timestamp)) > FIVE_MINUTES) return false;
  return eq(await mailgunSig(key, timestamp, token), signature.toLowerCase());
}
async function verifySendgrid(publicKey: string, signature: string, timestamp: string, body: string, now: number): Promise<boolean> {
  if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > FIVE_MINUTES) return false;
  try {
    const key = await subtle().importKey('spki', fromB64(publicKey.replace(/\s+/g, '')) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromB64(signature)) as BufferSource, enc.encode(timestamp + body) as BufferSource);
  } catch {
    return false;
  }
}
const twilioSig = async (token: string, url: string, params: Record<string, string>): Promise<string> => toB64(await hmac('sha1', token, url + Object.keys(params).sort().map((k) => k + params[k]).join('')));
const vonageBase = (params: Record<string, string>): string => Object.keys(params).filter((k) => k !== 'sig').sort().map((k) => `&${k}=${String(params[k]).replace(/[&=]/g, '_')}`).join('');
async function vonageSig(spec: string, params: Record<string, string>): Promise<string> {
  const m = /^(md5hash|md5|sha1|sha256|sha512):(.*)$/s.exec(spec);
  const algorithm = m?.[1] ?? 'sha256';
  const secret = m ? m[2]! : spec;
  const base = vonageBase(params);
  return hex(algorithm === 'md5hash' ? md5(enc.encode(base + secret)) : await hmac(algorithm as HashName, secret, base));
}
async function verifyVonage(spec: string, params: Record<string, string>, now: number): Promise<boolean> {
  if (!params.sig) return false;
  if (params.timestamp && Math.abs(now - Number(params.timestamp)) > FIVE_MINUTES) return false;
  return eq((await vonageSig(spec, params)).toLowerCase(), params.sig.toLowerCase());
}
const messageBirdSig = async (key: string, ts: string, query: Record<string, string>, body: string): Promise<string> => {
  const qs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`).join('&');
  return toB64(await hmac('sha256', key, `${ts}\n${qs}\n${await sha256Hex(body)}`));
};
async function verifyMessageBird(key: string, signature: string, timestamp: string, query: Record<string, string>, body: string, now: number): Promise<boolean> {
  if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > FIVE_MINUTES) return false;
  return eq(await messageBirdSig(key, timestamp, query, body), signature);
}

// ── Amazon SNS ──
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
function snsUrlAllowed(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443');
  } catch {
    return false;
  }
}
export function snsStringToSign(m: Record<string, unknown>): string | null {
  const fields = m.Type === 'Notification' ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'] : m.Type === 'SubscriptionConfirmation' || m.Type === 'UnsubscribeConfirmation' ? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] : null;
  if (!fields) return null;
  let out = '';
  for (const f of fields) {
    if (typeof m[f] !== 'string') return null;
    out += `${f}\n${m[f]}\n`;
  }
  return out;
}
/** Where the emulator's SNS signing key is "served"; any other SNS host fails like an unreachable certificate. */
export const SNS_CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-emulator.pem';
/** Same rules as the real receiver: the URL must be an SNS host over HTTPS, the certificate is fetched from it (a URL that serves none fails) and the signature is checked against its public key. */
async function verifySns(m: Record<string, unknown>, fetchCertificate: (url: string) => Promise<string | null>): Promise<boolean> {
  const toSign = snsStringToSign(m);
  if (!toSign || typeof m.Signature !== 'string' || !snsUrlAllowed(m.SigningCertURL)) return false;
  if (m.SignatureVersion !== '1' && m.SignatureVersion !== '2') return false;
  try {
    const pem = await fetchCertificate(m.SigningCertURL);
    const spki = pem ? certificatePublicKey(pem) : null;
    if (!spki) return false;
    const key = await subtle().importKey('spki', spki as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: m.SignatureVersion === '2' ? 'SHA-256' : 'SHA-1' }, false, ['verify']);
    return await subtle().verify('RSASSA-PKCS1-v1_5', key, fromB64(m.Signature) as BufferSource, enc.encode(toSign) as BufferSource);
  } catch {
    return false;
  }
}
async function signSns(m: Record<string, string>, pkcs8: Uint8Array, salt: string): Promise<string> {
  const key = await subtle().importKey('pkcs8', pkcs8 as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return toB64(new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', key, enc.encode(snsStringToSign(m)! + salt))));
}

// ── tokens ──
export function presentedTokens(headers: Headers, query: Record<string, string>): string[] {
  const out: string[] = [];
  const h = headers.get('authorization') ?? '';
  if (h.startsWith('Bearer ')) out.push(h.slice(7).trim());
  if (h.startsWith('Basic ')) {
    try {
      const d = atob(h.slice(6));
      const i = d.indexOf(':');
      out.push(i >= 0 ? d.slice(i + 1) : d);
    } catch {
      /* not base64: no credential */
    }
  }
  for (const k of ['t', 'token']) if (query[k]) out.push(query[k]!);
  return out;
}

// ── parsers: what each provider's callback says ──
const evBase = (provider: string, channel: 'email' | 'sms', ids: unknown, at: number, recipient?: string) => ({ channel, provider, messageIds: idVariants(ids), at, ...(recipient ? { recipient } : {}) });

function parseSes(message: unknown): DeliveryEvent[] {
  const m = obj(message);
  const kind = str(m.notificationType) ?? str(m.eventType);
  const mail = obj(m.mail);
  const base = evBase('ses', 'email', mail.messageId, when(obj(m.bounce).timestamp ?? obj(m.complaint).timestamp ?? obj(m.delivery).timestamp ?? mail.timestamp));
  const list = (v: unknown, key: string) => (Array.isArray(v) ? v : []).map((r) => str(obj(r)[key])).filter((x): x is string => !!x);
  if (kind === 'Bounce') {
    const b = obj(m.bounce);
    const permanent = str(b.bounceType) === 'Permanent';
    const type = permanent ? 'hard' : str(b.bounceType) === 'Transient' ? 'soft' : 'unknown';
    const detail = str(b.bounceSubType) ?? str(b.bounceType);
    const rs = list(b.bouncedRecipients, 'emailAddress');
    return (rs.length ? rs : [undefined]).map((recipient) => ({ ...base, status: 'bounced' as const, bounceType: type as 'hard' | 'soft' | 'unknown', ...(recipient ? { recipient } : {}), ...(detail ? { detail } : {}), ...(permanent && recipient ? { suppress: 'hard_bounce' as const } : {}) }));
  }
  if (kind === 'Complaint') {
    const c = obj(m.complaint);
    const rs = list(c.complainedRecipients, 'emailAddress');
    return (rs.length ? rs : [undefined]).map((recipient) => ({ ...base, status: 'complained' as const, ...(recipient ? { recipient, suppress: 'complaint' as const } : {}), ...(str(c.complaintFeedbackType) ? { detail: str(c.complaintFeedbackType) } : {}) }));
  }
  if (kind === 'Delivery') {
    const rs = (Array.isArray(obj(m.delivery).recipients) ? (obj(m.delivery).recipients as unknown[]) : []).filter((x): x is string => typeof x === 'string');
    return (rs.length ? rs : [undefined]).map((recipient) => ({ ...base, status: 'delivered' as const, ...(recipient ? { recipient } : {}) }));
  }
  if (kind === 'Send') return [{ ...base, status: 'sent' }];
  if (kind === 'Reject' || kind === 'Rendering Failure') return [{ ...base, status: 'failed', detail: str(obj(m.reject).reason) ?? kind }];
  return [];
}

function parseBrevo(body: unknown): DeliveryEvent[] {
  const out: DeliveryEvent[] = [];
  for (const raw of Array.isArray(body) ? body : [body]) {
    const e = obj(raw);
    const name = str(e.event);
    if (!name) continue;
    const base = evBase('brevo', 'email', e['message-id'] ?? e.messageId, when(e.ts_event ?? e.ts ?? e.date), str(e.email));
    const reason = str(e.reason);
    const d = reason ? { detail: reason } : {};
    if (name === 'request' || name === 'sent') out.push({ ...base, status: 'sent' });
    else if (name === 'delivered') out.push({ ...base, status: 'delivered' });
    else if (['hard_bounce', 'hardBounce', 'blocked', 'invalid_email', 'invalid'].includes(name)) out.push({ ...base, status: 'bounced', bounceType: 'hard', ...d, ...(base.recipient ? { suppress: name.startsWith('invalid') ? ('invalid' as const) : ('hard_bounce' as const) } : {}) });
    else if (['soft_bounce', 'softBounce', 'deferred'].includes(name)) out.push({ ...base, status: 'bounced', bounceType: 'soft', ...d });
    else if (name === 'spam' || name === 'complaint') out.push({ ...base, status: 'complained', ...(base.recipient ? { suppress: 'complaint' as const } : {}) });
    else if ((name === 'unsubscribe' || name === 'unsubscribed') && base.recipient) out.push({ ...base, status: 'complained', detail: 'unsubscribe', suppress: 'unsubscribe' });
    else if (name === 'error') out.push({ ...base, status: 'failed', ...d });
  }
  return out;
}

function parseMailgun(body: unknown): DeliveryEvent[] {
  const data = obj(obj(body)['event-data']);
  const event = str(data.event);
  if (!event) return [];
  const base = evBase('mailgun', 'email', obj(obj(data.message).headers)['message-id'] ?? data.id, when(data.timestamp), str(data.recipient));
  const ds = obj(data['delivery-status']);
  const detail = str(ds.description) ?? str(ds.message) ?? str(data.reason);
  if (event === 'accepted') return [{ ...base, status: 'sent' }];
  if (event === 'delivered') return [{ ...base, status: 'delivered' }];
  if (event === 'failed') {
    const permanent = str(data.severity) === 'permanent';
    return [{ ...base, status: 'bounced', bounceType: permanent ? 'hard' : 'soft', ...(detail ? { detail } : {}), ...(permanent && base.recipient ? { suppress: 'hard_bounce' as const } : {}) }];
  }
  if (event === 'complained') return [{ ...base, status: 'complained', ...(base.recipient ? { suppress: 'complaint' as const } : {}) }];
  if (event === 'unsubscribed') return base.recipient ? [{ ...base, status: 'complained', detail: 'unsubscribe', suppress: 'unsubscribe' }] : [];
  return [];
}

function parseSmtp2go(body: unknown): DeliveryEvent[] {
  const out: DeliveryEvent[] = [];
  for (const raw of Array.isArray(body) ? body : [body]) {
    const e = obj(raw);
    const event = str(e.event);
    if (!event) continue;
    const rcpt = str(e.rcpt) ?? str(e.email);
    const base = evBase('smtp2go', 'email', e.email_id, when(e.sendtime ?? e.time), rcpt);
    const reason = str(e.message) ?? str(e.reason);
    if (event === 'processed') out.push({ ...base, status: 'sent' });
    else if (event === 'delivered') out.push({ ...base, status: 'delivered' });
    else if (event === 'bounce' || event === 'reject') {
      const hard = event === 'reject' || str(e.bounce) === 'hard';
      out.push({ ...base, status: 'bounced', bounceType: hard ? 'hard' : 'soft', ...(reason ? { detail: reason } : {}), ...(hard && rcpt ? { suppress: 'hard_bounce' as const } : {}) });
    } else if (event === 'spam') out.push({ ...base, status: 'complained', ...(rcpt ? { suppress: 'complaint' as const } : {}) });
    else if (event === 'unsubscribe' && rcpt) out.push({ ...base, status: 'complained', detail: 'unsubscribe', suppress: 'unsubscribe' });
  }
  return out;
}

function parsePostmark(body: unknown): DeliveryEvent[] {
  const e = obj(body);
  const type = str(e.RecordType);
  const recipient = str(e.Email) ?? str(e.Recipient);
  const base = evBase('postmark', 'email', e.MessageID, when(e.BouncedAt ?? e.DeliveredAt ?? e.ReceivedAt), recipient);
  if (type === 'Delivery') return [{ ...base, status: 'delivered' }];
  if (type === 'Bounce') {
    const name = str(e.Type) ?? '';
    const hard = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Blocked'].includes(name);
    return [{ ...base, status: 'bounced', bounceType: hard ? 'hard' : 'soft', ...(name ? { detail: name } : {}), ...(hard && recipient ? { suppress: 'hard_bounce' as const } : {}) }];
  }
  if (type === 'SpamComplaint') return [{ ...base, status: 'complained', ...(recipient ? { suppress: 'complaint' as const } : {}) }];
  if (type === 'SubscriptionChange' && e.SuppressSending === true && recipient) return [{ ...base, status: 'complained', detail: 'unsubscribe', suppress: 'unsubscribe' }];
  return [];
}

function parseSendgrid(body: unknown): DeliveryEvent[] {
  const out: DeliveryEvent[] = [];
  for (const raw of Array.isArray(body) ? body : []) {
    const e = obj(raw);
    const event = str(e.event);
    const recipient = str(e.email);
    if (!event) continue;
    const base = { ...evBase('sendgrid', 'email', undefined, when(e.timestamp), recipient), messageIds: [...idVariants(str(e.sg_message_id)?.split('.')[0]), ...idVariants(e['smtp-id'])] };
    const reason = str(e.reason);
    if (event === 'processed') out.push({ ...base, status: 'sent' });
    else if (event === 'delivered') out.push({ ...base, status: 'delivered' });
    else if (event === 'bounce' || event === 'blocked') {
      const hard = event === 'bounce' && str(e.type) !== 'blocked';
      out.push({ ...base, status: 'bounced', bounceType: hard ? 'hard' : 'soft', ...(reason ? { detail: reason } : {}), ...(hard && recipient ? { suppress: 'hard_bounce' as const } : {}) });
    } else if (event === 'dropped') out.push({ ...base, status: 'failed', ...(reason ? { detail: reason } : {}) });
    else if (event === 'spamreport') out.push({ ...base, status: 'complained', ...(recipient ? { suppress: 'complaint' as const } : {}) });
    else if ((event === 'unsubscribe' || event === 'group_unsubscribe') && recipient) out.push({ ...base, status: 'complained', detail: 'unsubscribe', suppress: 'unsubscribe' });
  }
  return out;
}

function parseResend(body: unknown): DeliveryEvent[] {
  const e = obj(body);
  const type = str(e.type);
  const d = obj(e.data);
  const to = Array.isArray(d.to) && typeof d.to[0] === 'string' ? (d.to[0] as string) : undefined;
  const base = evBase('resend', 'email', d.email_id, when(e.created_at ?? d.created_at), to);
  if (type === 'email.sent') return [{ ...base, status: 'sent' }];
  if (type === 'email.delivered') return [{ ...base, status: 'delivered' }];
  if (type === 'email.failed') return [{ ...base, status: 'failed', ...(str(d.reason) ? { detail: str(d.reason) } : {}) }];
  if (type === 'email.bounced') {
    const bt = (str(obj(d.bounce).type) ?? '').toLowerCase();
    const hard = bt === 'permanent' || bt === 'hard';
    return [{ ...base, status: 'bounced', bounceType: hard ? 'hard' : bt === 'transient' || bt === 'soft' ? 'soft' : 'unknown', ...(str(obj(d.bounce).message) ? { detail: str(obj(d.bounce).message) } : {}), ...(hard && to ? { suppress: 'hard_bounce' as const } : {}) }];
  }
  if (type === 'email.complained') return [{ ...base, status: 'complained', ...(to ? { recipient: to, suppress: 'complaint' as const } : {}) }];
  return [];
}

function parseTwilio(p: Record<string, string>): DeliveryEvent[] {
  const status = p.MessageStatus ?? p.SmsStatus;
  const sid = p.MessageSid ?? p.SmsSid;
  if (!status || !sid) return [];
  const to = (p.To ?? '').replace(/^whatsapp:/, '') || undefined;
  const base = evBase('twilio', 'sms', sid, NOW, to);
  const code = p.ErrorCode;
  if (status === 'sent') return [{ ...base, status: 'sent' }];
  if (status === 'delivered' || status === 'read') return [{ ...base, status: 'delivered' }];
  if (status === 'failed' || status === 'undelivered') {
    const invalid = code === '21211' || code === '21614' || code === '30006';
    return [{ ...base, status: 'failed', detail: code ? `error ${code}` : status, ...(to && invalid ? { suppress: 'invalid' as const } : {}), ...(to && code === '21610' ? { suppress: 'unsubscribe' as const } : {}) }];
  }
  return [];
}

function parseVonage(p: Record<string, string>): DeliveryEvent[] {
  const id = p.messageId ?? p['message-id'];
  const status = p.status;
  if (!id || !status) return [];
  const to = p.msisdn ? (p.msisdn.startsWith('+') ? p.msisdn : `+${p.msisdn}`) : undefined;
  const base = evBase('vonage', 'sms', id, when(p['message-timestamp'] ?? p.scts), to);
  const code = p['err-code'];
  if (status === 'delivered') return [{ ...base, status: 'delivered' }];
  if (status === 'accepted' || status === 'buffered') return [{ ...base, status: 'sent' }];
  if (['failed', 'rejected', 'expired', 'unknown'].includes(status)) {
    const invalid = code === '1' || code === '9' || code === '13';
    return [{ ...base, status: 'failed', detail: `${status}${code && code !== '0' ? ` (error ${code})` : ''}`, ...(to && invalid ? { suppress: 'invalid' as const } : {}) }];
  }
  return [];
}

function parseMessageBird(p: Record<string, string>): DeliveryEvent[] {
  const id = p.id;
  const status = p.status;
  if (!id || !status) return [];
  const to = p.recipient ? (p.recipient.startsWith('+') ? p.recipient : `+${p.recipient}`) : undefined;
  const base = evBase('messagebird', 'sms', id, when(p.statusDatetime), to);
  if (status === 'sent' || status === 'buffered' || status === 'scheduled') return [{ ...base, status: 'sent' }];
  if (status === 'delivered') return [{ ...base, status: 'delivered' }];
  if (status === 'delivery_failed' || status === 'expired') {
    const reason = p.statusReason ?? status;
    const invalid = p.statusErrorCode === '8' || p.statusErrorCode === '9' || reason === 'unknown subscriber';
    return [{ ...base, status: 'failed', detail: reason, ...(to && invalid ? { suppress: 'invalid' as const } : {}) }];
  }
  return [];
}

// ── verifying a callback ──
export interface CallbackIn {
  provider: string;
  raw: string;
  contentType: string;
  headers: Headers;
  query: Record<string, string>;
  /** Every public URL the sender could have signed (Twilio signs the URL). */
  urls: string[];
  /** The stored verification secret (signing key, public key, whsec_, topic ARNs), or null. */
  secret: string | null;
  token: string;
  /** Auth tokens of the instance's Twilio SMS providers. */
  twilioTokens: string[];
  /** The certificate (PEM) an SNS `SigningCertURL` serves, or null when nothing is served there. */
  snsCertificate: (url: string) => Promise<string | null>;
  /** Epoch seconds. */
  now: number;
}
export type CallbackOut = { ok: false; why: string; malformed?: boolean; message?: string } | { ok: true; events: DeliveryEvent[]; id: string; confirmed?: boolean; subscribeUrl?: string };

/** Verify one callback with the provider's own scheme and say what it reports. Never throws. */
export async function verifyCallback(i: CallbackIn): Promise<CallbackOut> {
  NOW = i.now * 1000;
  const bad = (why: string, message?: string): CallbackOut => ({ ok: false, why, ...(message ? { message } : {}) });
  const malformed: CallbackOut = { ok: false, why: 'malformed body', malformed: true };
  const json = (): unknown => {
    try {
      return JSON.parse(i.raw);
    } catch {
      return undefined;
    }
  };
  const tokenOk = presentedTokens(i.headers, i.query).some((p) => eq(p, i.token));
  const digest = async () => (await sha256Hex(i.raw)).slice(0, 32);
  const h = (n: string) => i.headers.get(n) ?? '';
  const asParams = (): Record<string, string> => (i.raw ? (i.contentType.includes('json') ? stringify(json()) : form(i.raw)) : {});
  switch (i.provider) {
    case 'ses': {
      if (!tokenOk) return bad('bad token');
      const sns = json() as Record<string, any> | undefined;
      if (!sns || typeof sns !== 'object') return bad('unreadable body');
      if (!(await verifySns(sns, i.snsCertificate))) return bad('SNS signature did not verify');
      const topics = i.secret?.split(',').map((t) => t.trim()).filter(Boolean) ?? [];
      if (topics.length && (!sns.TopicArn || !topics.includes(sns.TopicArn))) return bad('topic not accepted');
      const id = String(sns.MessageId ?? (await digest()));
      if (sns.Type === 'SubscriptionConfirmation') return { ok: true, events: [], id, confirmed: true, ...(snsUrlAllowed(sns.SubscribeURL) ? { subscribeUrl: sns.SubscribeURL } : {}) };
      if (sns.Type !== 'Notification' || typeof sns.Message !== 'string') return { ok: true, events: [], id };
      let inner: unknown;
      try {
        inner = JSON.parse(sns.Message);
      } catch {
        inner = undefined;
      }
      return { ok: true, events: parseSes(inner), id };
    }
    case 'mailgun': {
      const body = json() as { signature?: Record<string, unknown> } | undefined;
      if (!i.secret || !body || !(await verifyMailgun(i.secret, body.signature ?? {}, i.now))) return bad('signature did not verify');
      return { ok: true, events: parseMailgun(body), id: String(body.signature?.token ?? (await digest())) };
    }
    case 'smtp2go':
    case 'postmark': {
      if (!tokenOk) return bad('bad token');
      const body = json();
      if (body === undefined) return malformed;
      return { ok: true, events: i.provider === 'smtp2go' ? parseSmtp2go(body) : parsePostmark(body), id: await digest() };
    }
    case 'sendgrid': {
      if (i.secret) {
        const sig = h('x-twilio-email-event-webhook-signature');
        const ts = h('x-twilio-email-event-webhook-timestamp');
        if (!sig || !ts || !(await verifySendgrid(i.secret, sig, ts, i.raw, i.now))) return bad('signature did not verify');
      } else if (!tokenOk) return bad('bad token');
      const body = json();
      if (body === undefined) return malformed;
      return { ok: true, events: parseSendgrid(body), id: await digest() };
    }
    case 'twilio': {
      const sig = h('x-twilio-signature');
      const params = form(i.raw);
      let ok = false;
      if (sig) for (const t of i.twilioTokens) for (const u of i.urls) ok ||= eq(await twilioSig(t, u, params), sig);
      if (!ok) return bad('signature did not verify');
      return { ok: true, events: parseTwilio(params), id: `${params.MessageSid ?? params.SmsSid ?? ''}:${params.MessageStatus ?? params.SmsStatus ?? ''}` };
    }
    case 'vonage': {
      const params = { ...i.query, ...asParams() };
      const verified = i.secret ? await verifyVonage(i.secret, params, i.now) : tokenOk;
      if (!verified) return bad(i.secret ? 'signature did not verify' : 'bad token');
      delete params.t;
      delete params.token;
      return { ok: true, events: parseVonage(params), id: `${params.messageId ?? params['message-id'] ?? ''}:${params.status ?? ''}` };
    }
    case 'messagebird': {
      let verified: boolean;
      if (i.secret) {
        const sig = h('messagebird-signature');
        const ts = h('messagebird-request-timestamp');
        verified = Boolean(sig && ts && (await verifyMessageBird(i.secret, sig, ts, i.query, i.raw, i.now)));
      } else verified = tokenOk;
      if (!verified) return bad(i.secret ? 'signature did not verify' : 'bad token');
      const params = { ...i.query, ...asParams() };
      return { ok: true, events: parseMessageBird(params), id: `${params.id ?? ''}:${params.status ?? ''}` };
    }
    case 'resend': {
      const pick = (n: string) => h(`svix-${n}`) || h(`webhook-${n}`);
      const [id, ts, sig] = [pick('id'), pick('timestamp'), pick('signature')];
      if (!i.secret || !id || !ts || !sig || !(await verifySvix({ secret: i.secret, id, timestamp: ts, signatureHeader: sig, body: i.raw, now: i.now }))) return bad('signature did not verify');
      const body = json();
      if (body === undefined) return { ok: false, why: 'malformed body', malformed: true, message: 'Request body is not valid JSON.' };
      return { ok: true, events: parseResend(body), id };
    }
    case 'brevo': {
      const auth = h('authorization');
      if (!eq(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', i.token)) return bad('bad token', 'Invalid webhook token.');
      const body = json();
      return { ok: true, events: parseBrevo(body ?? []), id: await digest() };
    }
    default:
      return bad('unknown provider');
  }
}

// ── building a callback (for tests and integrators) ──
export interface PrepIn {
  provider: string;
  event: EventStatus;
  bounce: 'hard' | 'soft';
  messageId: string;
  recipient: string;
  detail?: string;
  /** The signing secret to use, or null for the URL-token mode of the providers that have one. */
  secret: string | null;
  token: string;
  /** The public URL the callback is posted to, without a query. */
  url: string;
  now: number;
  /** Appended to what is signed, so the signature is well formed but wrong (a tampered callback). */
  salt: string;
  topic: string;
  keys: TestKeys;
}
export interface Prepared {
  content_type: string;
  body: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export async function prepareCallback(p: PrepIn): Promise<Prepared> {
  const { event, messageId: id, recipient: to, now, salt } = p;
  const hard = p.bounce === 'hard';
  const iso = new Date(now * 1000).toISOString();
  const json = (v: unknown, headers: Record<string, string> = {}, query: Record<string, string> = {}): Prepared => ({ content_type: 'application/json', body: JSON.stringify(v), headers, query });
  const urlform = (v: Record<string, string>, headers: Record<string, string> = {}): Prepared => ({ content_type: 'application/x-www-form-urlencoded', body: new URLSearchParams(v).toString(), headers, query: {} });
  const tokenAuth = (token = p.token) => ({ authorization: `Bearer ${token}`, ...(salt ? { authorization: `Bearer ${token}x` } : {}) });
  const pick = <T>(m: Record<EventStatus, T>): T => m[event];
  switch (p.provider) {
    case 'resend': {
      const body = JSON.stringify({ type: pick({ sent: 'email.sent', delivered: 'email.delivered', bounced: 'email.bounced', complained: 'email.complained', failed: 'email.failed' }), created_at: iso, data: { email_id: id, from: 'noreply@emulator.test', to: [to], bounce: { type: hard ? 'Permanent' : 'Transient', message: p.detail ?? 'bounced' }, reason: p.detail ?? 'failed' } });
      const msgId = `msg_${(await sha256Hex(`${id}:${event}:${now}:${Math.random()}`)).slice(0, 24)}`;
      const sig = toB64(await hmac('sha256', fromB64(p.secret!.replace(/^whsec_/, '')), `${msgId}.${now}.${body}${salt}`));
      return { content_type: 'application/json', body, headers: { 'svix-id': msgId, 'svix-timestamp': String(now), 'svix-signature': `v1,${sig}` }, query: {} };
    }
    case 'mailgun': {
      const token = (await sha256Hex(`${id}:${event}:${Math.random()}`)).slice(0, 50);
      const failed = event === 'bounced' || event === 'failed';
      return json({ signature: { timestamp: String(now), token, signature: await mailgunSig(p.secret!, String(now), token + salt) }, 'event-data': { event: pick({ sent: 'accepted', delivered: 'delivered', bounced: 'failed', complained: 'complained', failed: 'failed' }), id: `evt_${token.slice(0, 12)}`, recipient: to, timestamp: now, ...(failed ? { severity: event === 'bounced' && hard ? 'permanent' : 'temporary' } : {}), message: { headers: { 'message-id': id } }, 'delivery-status': { description: p.detail ?? event } } });
    }
    case 'brevo':
      return json({ event: pick({ sent: 'request', delivered: 'delivered', bounced: hard ? 'hard_bounce' : 'soft_bounce', complained: 'spam', failed: 'error' }), 'message-id': id, email: to, ts_event: now, ...(p.detail ? { reason: p.detail } : {}) }, tokenAuth());
    case 'postmark':
      return json({ RecordType: pick({ sent: 'Delivery', delivered: 'Delivery', bounced: 'Bounce', complained: 'SpamComplaint', failed: 'Bounce' }), MessageID: id, Email: to, Type: event === 'bounced' && hard ? 'HardBounce' : 'Transient', BouncedAt: iso, DeliveredAt: iso }, { authorization: `Basic ${btoa(`atlas:${p.token}${salt ? 'x' : ''}`)}` });
    case 'smtp2go':
      return json({ event: pick({ sent: 'processed', delivered: 'delivered', bounced: 'bounce', complained: 'spam', failed: 'bounce' }), email_id: id, rcpt: to, bounce: event === 'bounced' && hard ? 'hard' : 'soft', sendtime: iso, ...(p.detail ? { message: p.detail } : {}) }, tokenAuth());
    case 'sendgrid': {
      const body = JSON.stringify([{ event: pick({ sent: 'processed', delivered: 'delivered', bounced: 'bounce', complained: 'spamreport', failed: 'dropped' }), email: to, sg_message_id: `${id}.filter0001`, timestamp: now, ...(event === 'bounced' && !hard ? { type: 'blocked' } : {}), ...(p.detail ? { reason: p.detail } : {}) }]);
      if (p.secret === null) return { content_type: 'application/json', body, headers: tokenAuth(), query: {} };
      const { privateKey } = await p.keys.ec();
      const raw = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(String(now) + body + salt)));
      return { content_type: 'application/json', body, headers: { 'x-twilio-email-event-webhook-signature': toB64(rawToDer(raw)), 'x-twilio-email-event-webhook-timestamp': String(now) }, query: {} };
    }
    case 'ses': {
      const mail = { messageId: id, timestamp: iso };
      const inner = pick<Record<string, unknown>>({
        sent: { notificationType: 'Send', mail },
        delivered: { notificationType: 'Delivery', mail, delivery: { recipients: [to], timestamp: iso } },
        bounced: { notificationType: 'Bounce', mail, bounce: { bounceType: hard ? 'Permanent' : 'Transient', bounceSubType: p.detail ?? 'General', bouncedRecipients: [{ emailAddress: to }], timestamp: iso } },
        complained: { notificationType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: to }], complaintFeedbackType: p.detail ?? 'abuse', timestamp: iso } },
        failed: { notificationType: 'Reject', mail, reject: { reason: p.detail ?? 'Rejected' } },
      });
      const sns: Record<string, string> = { Type: 'Notification', MessageId: `sns_${(await sha256Hex(`${id}:${event}:${Math.random()}`)).slice(0, 24)}`, TopicArn: p.topic, Message: JSON.stringify(inner), Timestamp: iso, SignatureVersion: '2', SigningCertURL: SNS_CERT_URL };
      sns.Signature = await signSns(sns, (await p.keys.rsa()).pkcs8, salt);
      return json(sns, {}, { t: p.token });
    }
    case 'twilio': {
      const params: Record<string, string> = { MessageSid: id, MessageStatus: pick({ sent: 'sent', delivered: 'delivered', bounced: 'undelivered', complained: 'failed', failed: 'failed' }), To: to };
      if (event === 'bounced') params.ErrorCode = '30006';
      else if (event === 'complained') params.ErrorCode = '21610';
      return urlform(params, { 'x-twilio-signature': await twilioSig(p.secret!, p.url + salt, params) });
    }
    case 'vonage': {
      const params: Record<string, string> = { messageId: id, status: pick({ sent: 'accepted', delivered: 'delivered', bounced: 'failed', complained: 'failed', failed: 'failed' }), msisdn: to.replace(/^\+/, ''), 'message-timestamp': iso, 'err-code': event === 'delivered' || event === 'sent' ? '0' : event === 'failed' ? '5' : '1', timestamp: String(now) };
      if (p.secret === null) return urlform(params, tokenAuth());
      return urlform({ ...params, sig: (await vonageSig(p.secret, params)).replace(/^./, (c) => (salt ? (c === '0' ? '1' : '0') : c)) });
    }
    case 'messagebird': {
      const params: Record<string, string> = { id, status: pick({ sent: 'sent', delivered: 'delivered', bounced: 'delivery_failed', complained: 'delivery_failed', failed: 'delivery_failed' }), recipient: to.replace(/^\+/, ''), statusDatetime: iso, ...(event === 'bounced' || event === 'complained' ? { statusErrorCode: '9', statusReason: 'unknown subscriber' } : {}) };
      const out = urlform(params);
      out.headers = p.secret === null ? tokenAuth() : { 'messagebird-signature': await messageBirdSig(p.secret, String(now), {}, out.body + salt), 'messagebird-request-timestamp': String(now) };
      return out;
    }
    default:
      throw new Error(`unknown provider ${p.provider}`);
  }
}
