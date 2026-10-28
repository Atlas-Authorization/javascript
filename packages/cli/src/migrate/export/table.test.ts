import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapTable, parseDelimited, parseTable, typedParams } from './table';

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes, embedded newlines, BOM, CRLF and sniffs the delimiter', () => {
    const csv = '﻿id;email;name\r\n1;a@b.co;"Doe; ""Jo""\nSmith"\r\n2;c@d.co;Plain\r\n';
    expect(parseDelimited(csv)).toEqual([
      { id: '1', email: 'a@b.co', name: 'Doe; "Jo"\nSmith' },
      { id: '2', email: 'c@d.co', name: 'Plain' },
    ]);
    expect(parseDelimited('a\tb\n1\t2')).toEqual([{ a: '1', b: '2' }]);
  });
  it('reads JSON arrays, wrapped lists and NDJSON', () => {
    expect(parseTable('[{"email":"a@b.co"}]')).toHaveLength(1);
    expect(parseTable('{"users":[{"email":"a@b.co"},{"email":"c@d.co"}]}')).toHaveLength(2);
    expect(parseTable('{"email":"a@b.co"}\n{"email":"c@d.co"}')).toHaveLength(2);
    expect(() => parseTable('{"a":1}\nnot json')).toThrow(/Line 2/);
  });
});

describe('mapTable', () => {
  const bcrypt = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

  it('recognises usual column names and self-describing hashes', () => {
    const set = mapTable([
      { user_id: '7', Email: 'Ada@Example.com', email_verified: 'true', first_name: 'Ada', last_name: 'L', password_hash: bcrypt, created_at: '2020-01-02T03:04:05Z', role: 'Admin; editor', is_active: '1' },
    ]);
    expect(set.list('user')[0]).toMatchObject({
      id: '7',
      emails: [{ email: 'ada@example.com', verified: true, primary: true }],
      password: { algorithm: 'bcrypt', hash: bcrypt },
      roles: ['admin', 'editor'],
      created_at: '2020-01-02T03:04:05.000Z',
    });
    expect(set.list('user')[0]!.banned).toBeUndefined();
    expect(set.list('role').map((r) => r.key).sort()).toEqual(['admin', 'editor']);
  });

  it('applies the hash-algorithm picker with salt position and encoding', () => {
    const digest = createHash('sha256').update('s4lt' + 'secret').digest('hex');
    const set = mapTable([{ email: 'a@b.co', pwd: digest, salt: 's4lt' }], {
      map: { password: 'pwd' },
      hashAlgorithm: 'sha256_salted',
      saltPosition: 'prefix',
      hashEncoding: 'hex',
    });
    expect(set.list('user')[0]!.password).toEqual({ algorithm: 'sha256_salted', hash: digest, salt: 's4lt', params: { salt_position: 'prefix', encoding: 'hex' } });
  });

  it('refuses unknown algorithms and unrecognised hashes with a reason, keeping the user', () => {
    const a = mapTable([{ email: 'a@b.co', password: 'abc123' }]);
    expect(a.list('user')).toHaveLength(1);
    expect(a.list('user')[0]!.password).toBeUndefined();
    expect(a.warnings.join(' ')).toMatch(/hash-algorithm/);
    expect(mapTable([{ email: 'a@b.co', password: 'x' }], { hashAlgorithm: 'rot13' }).warnings.join(' ')).toMatch(/unknown hash algorithm/);
  });

  it('plaintext hashes on export (PBKDF2), never writes the clear password', () => {
    const u = mapTable([{ email: 'a@b.co', password: 'hunter2' }], { hashAlgorithm: 'plaintext' }).list('user')[0]!;
    expect(u.password?.algorithm).toBe('pbkdf2');
    expect(JSON.stringify(u)).not.toContain('hunter2');
  });

  it('bans disabled rows, drops rows without an identifier and duplicate ids', () => {
    const set = mapTable([
      { email: 'a@b.co', banned: 'true' },
      { name: 'nobody' },
      { id: 'x', email: 'c@d.co' },
      { id: 'x', email: 'e@f.co' },
    ]);
    expect(set.list('user')).toHaveLength(2);
    expect(set.list('user')[0]).toMatchObject({ banned: true });
    expect(set.omitted.user!.count).toBe(2);
  });

  it('types hash params', () => {
    expect(typedParams('iterations=10000,digest=sha256,flag=true')).toEqual({ iterations: 10000, digest: 'sha256', flag: true });
  });
});
