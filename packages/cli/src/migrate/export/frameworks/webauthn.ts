/**
 * Just enough CBOR and WebAuthn to pull a passkey's credential id, COSE public
 * key and sign count out of a stored registration response (attestationObject),
 * for sources that keep the response instead of the parsed key (django-allauth's
 * MFA WebAuthn authenticators).
 */

interface Decoded {
  value: unknown;
  end: number;
}

/** Decode one CBOR item at `offset` (ints, byte/text strings, arrays, maps, simple values). */
export function decodeCbor(buf: Buffer, offset = 0, depth = 0): Decoded {
  if (depth > 16) throw new Error('CBOR nesting too deep');
  if (offset >= buf.length) throw new Error('CBOR truncated');
  const initial = buf[offset]!;
  const major = initial >> 5;
  const info = initial & 31;
  let pos = offset + 1;
  const readLength = (): number => {
    if (info < 24) return info;
    if (info === 24) return buf.readUInt8(pos++);
    if (info === 25) {
      const v = buf.readUInt16BE(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      const v = buf.readUInt32BE(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      const v = Number(buf.readBigUInt64BE(pos));
      pos += 8;
      return v;
    }
    throw new Error('CBOR indefinite lengths are not supported');
  };
  switch (major) {
    case 0:
      return { value: readLength(), end: pos };
    case 1:
      return { value: -1 - readLength(), end: pos };
    case 2: {
      const n = readLength();
      if (pos + n > buf.length) throw new Error('CBOR truncated');
      return { value: buf.subarray(pos, pos + n), end: pos + n };
    }
    case 3: {
      const n = readLength();
      if (pos + n > buf.length) throw new Error('CBOR truncated');
      return { value: buf.toString('utf8', pos, pos + n), end: pos + n };
    }
    case 4: {
      const n = readLength();
      const arr: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const item = decodeCbor(buf, pos, depth + 1);
        arr.push(item.value);
        pos = item.end;
      }
      return { value: arr, end: pos };
    }
    case 5: {
      const n = readLength();
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) {
        const k = decodeCbor(buf, pos, depth + 1);
        const v = decodeCbor(buf, k.end, depth + 1);
        map.set(k.value, v.value);
        pos = v.end;
      }
      return { value: map, end: pos };
    }
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22 || info === 23) return { value: null, end: pos };
      throw new Error('CBOR float/simple values are not supported');
    default:
      throw new Error(`CBOR major type ${major} is not supported`);
  }
}

export interface ParsedCredential {
  credentialId: Buffer;
  /** The COSE_Key, byte for byte as the authenticator produced it. */
  publicKey: Buffer;
  signCount: number;
  aaguid: string;
  backedUp: boolean;
}

/** Parse `authData` with attested credential data (flag AT). */
export function parseAuthData(authData: Buffer): ParsedCredential | null {
  if (authData.length < 37 + 18) return null;
  const flags = authData[32]!;
  if (!(flags & 0x40)) return null;
  const signCount = authData.readUInt32BE(33);
  const aaguid = authData.subarray(37, 53).toString('hex');
  const idLength = authData.readUInt16BE(53);
  const idEnd = 55 + idLength;
  if (idEnd > authData.length) return null;
  const credentialId = authData.subarray(55, idEnd);
  const key = decodeCbor(authData, idEnd);
  return {
    credentialId,
    publicKey: authData.subarray(idEnd, key.end),
    signCount,
    aaguid: `${aaguid.slice(0, 8)}-${aaguid.slice(8, 12)}-${aaguid.slice(12, 16)}-${aaguid.slice(16, 20)}-${aaguid.slice(20)}`,
    backedUp: Boolean(flags & 0x10),
  };
}

/** The credential inside a base64url attestationObject. */
export function parseAttestationObject(b64url: string): ParsedCredential | null {
  try {
    const decoded = decodeCbor(Buffer.from(b64url.replace(/\+/g, '-').replace(/\//g, '_'), 'base64url')).value;
    if (!(decoded instanceof Map)) return null;
    const authData = decoded.get('authData');
    return Buffer.isBuffer(authData) ? parseAuthData(authData) : null;
  } catch {
    return null;
  }
}
