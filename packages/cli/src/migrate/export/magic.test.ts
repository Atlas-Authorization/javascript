import { describe, expect, it } from 'vitest';
import { exportMagic, mapMagicUser } from './magic';

/**
 * Magic's dashboard export is a CSV with the user's email and sign-up / last
 * login times; the issuer (`did:ethr:0x…`, the `iss` of a DID token) is what
 * the Admin SDK reports for a user. Header spelling varies, so columns are
 * matched case- and punctuation-insensitively.
 */
const ISS_A = 'did:ethr:0x1111111111111111111111111111111111111111';
const ISS_B = 'did:ethr:0x2222222222222222222222222222222222222222';

const CSV = ['Email,Sign Up Time,Last Login Time', 'Jane@Acme.example,2024-01-02T03:04:05Z,2024-02-03T00:00:00Z', 'bob@acme.example,1700000000,', ',,', 'bad,,'].join('\n');

describe('exportMagic', () => {
  it('imports the dashboard CSV by email, verified, with times, and warns about missing issuers and wallets', () => {
    const set = exportMagic({ usersText: CSV });
    expect(set.list('user')).toEqual([
      {
        id: 'jane@acme.example',
        emails: [{ email: 'jane@acme.example', verified: true, primary: true }],
        created_at: Date.parse('2024-01-02T03:04:05Z'),
        last_sign_in_at: Date.parse('2024-02-03T00:00:00Z'),
      },
      { id: 'bob@acme.example', emails: [{ email: 'bob@acme.example', verified: true, primary: true }], created_at: 1700000000000 },
    ]);
    // the blank ",," row is dropped by the CSV reader; only "bad" is omitted
    expect(set.omitted.user!.count).toBe(1);
    expect(set.warnings.some((w) => w.startsWith('2 user(s) have no Magic issuer'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('wallet keys'))).toBe(true);
  });

  it('uses the issuer as the user id when the export carries it or an issuers file maps it', () => {
    const set = exportMagic({
      usersText: JSON.stringify([
        { email: 'jane@acme.example', issuer: ISS_A, public_address: '0xABCDEF0000000000000000000000000000000001' },
        { email: 'bob@acme.example' },
      ]),
      issuersText: `email,issuer\nBob@acme.example,${ISS_B}\nnot-an-issuer@x.example,did:web:x`,
    });
    expect(set.list('user')).toEqual([
      {
        id: ISS_A,
        emails: [{ email: 'jane@acme.example', verified: true, primary: true }],
        private_metadata: { magic_issuer: ISS_A, magic_public_address: '0xabcdef0000000000000000000000000000000001' },
      },
      { id: ISS_B, emails: [{ email: 'bob@acme.example', verified: true, primary: true }], private_metadata: { magic_issuer: ISS_B } },
    ]);
    expect(set.warnings.some((w) => w.includes('no Magic issuer'))).toBe(false);
  });

  it('reads NDJSON and phone-only users', () => {
    const set = exportMagic({ usersText: `{"phone_number":"+1 415 555 0101"}\n{"email":"a@b.example"}` });
    expect(set.list('user')).toEqual([
      { id: 'phone:+14155550101', phones: [{ phone: '+14155550101', verified: true, primary: true }] },
      { id: 'a@b.example', emails: [{ email: 'a@b.example', verified: true, primary: true }] },
    ]);
  });

  it('exports nothing from an empty file and does not warn about wallets', () => {
    const set = exportMagic({ usersText: '' });
    expect(set.count('user')).toBe(0);
    expect(set.warnings).toEqual([]);
  });

  it('drops a row whose email is not an address', () => {
    expect(mapMagicUser({ email: 'nope' })).toBeNull();
  });
});
