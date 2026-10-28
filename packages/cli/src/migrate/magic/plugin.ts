import { exportMagic } from '../export/magic';
import { translateMagicConfig } from '../export/magic-config';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';
import { localFile, need, vendorStep, writeRecordSet } from '../export/plugin-kit';

/**
 * `atlas migrate magic` — users from the export file in your Magic dashboard
 * (Magic has no API to list users), their issuers from an optional email →
 * issuer file, and the `magic` bridge preset (DID tokens verified against the
 * signer's own key and your client id). Magic holds no passwords.
 */

const USERS_FILE: CredentialSpec = { flag: '--magic-users-file', env: 'MAGIC_USERS_FILE', label: 'the user export file from your Magic dashboard (CSV)', required: true };
const ISSUERS_FILE: CredentialSpec = { flag: '--magic-issuers-file', env: 'MAGIC_ISSUERS_FILE', label: 'a file mapping each email to its Magic issuer (did:ethr:…)', required: false };
const CLIENT_ID: CredentialSpec = { flag: '--magic-client-id', env: 'MAGIC_CLIENT_ID', label: 'your Magic client id (did:magic:…)', required: false };

function clientId(p: PluginContext): string | undefined {
  return p.credential(CLIENT_ID) ?? (p.ctx.env.NEXT_PUBLIC_MAGIC_CLIENT_ID?.trim() || undefined);
}

export const magicPlugin: MigrationPlugin = {
  vendor: 'magic',
  source: 'magic',
  label: 'Magic (magic.link)',
  help: 'Move a Magic (magic.link) app: users from the export file in your Magic dashboard, with verified emails and, when you have them, Magic issuers so the zero-logout bridge recognises each person\'s current DID token; email code and link sign-in as Atlas config; and the code. Magic has no user-listing API, so no Magic secret key is needed.',
  config: {
    reads: 'nothing from Magic (it has no settings API): the translation lists where each Magic setting lives',
    credentials: [CLIENT_ID],
    async translate(p) {
      return translateMagicConfig({ ...(clientId(p) ? { clientId: clientId(p)! } : {}) });
    },
  },
  export: {
    reads: 'the Magic dashboard user export (--magic-users-file) and an optional email → issuer file (--magic-issuers-file)',
    credentials: [USERS_FILE, ISSUERS_FILE],
    limits: [
      'Magic has no API to list users: export them from the Magic dashboard (Users → Export) and pass that file with --magic-users-file.',
      'The dashboard export has no issuers. Users without one are imported by email and sign in with an email code; give an email → issuer file (--magic-issuers-file) to keep their current sessions alive through the bridge.',
      'Magic holds no passwords. Embedded wallet keys cannot be exported: users export them from Magic themselves.',
    ],
    async run(p, writer, resume) {
      const usersText = localFile(p, USERS_FILE, 'text');
      if (usersText === undefined) need(p, USERS_FILE);
      const set = await vendorStep('Magic', async () => exportMagic({ usersText: usersText!, issuersText: localFile(p, ISSUERS_FILE, 'text'), onProgress: (m) => p.say(`  reading ${m}`) }));
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
  bridge: {
    preset: 'magic',
    vars(p, t) {
      const id = t?.bridge?.vars.client_id ?? clientId(p);
      return id ? { ...t?.bridge?.vars, client_id: id } : { ...t?.bridge?.vars };
    },
  },
  codemod: 'magic',
};
