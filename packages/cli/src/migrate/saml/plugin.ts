import { resolve } from 'node:path';
import { CliError } from '../../errors';
import { writeRecordSet } from '../export/plugin-kit';
import { connectionSet, samlConnections } from '../export/sso-metadata';
import { ConfigBuilder } from '../export/translate-kit';
import type { CredentialSpec, MigrationPlugin, PluginContext } from '../framework/plugin';

/**
 * `atlas migrate saml export --set saml-metadata=<file or https URL>` — any
 * SAML 2.0 identity provider (Ping, OneLogin, Okta, ADFS, Entra, Shibboleth,
 * Keycloak …) from its metadata: an Atlas SSO connection with the IdP's
 * entity id, sign-on URL and signing certificate. The users stay in the IdP:
 * they sign in through it, now via Atlas, and relink on their verified email.
 */

const METADATA: CredentialSpec = { flag: 'saml-metadata', env: 'SAML_METADATA', label: 'the IdP metadata: a file, or an https:// URL', required: true };
const DOMAINS: CredentialSpec = { flag: 'saml-domains', env: 'SAML_DOMAINS', label: 'email domains that sign in through this IdP (comma separated)', required: false };
const NAME: CredentialSpec = { flag: 'saml-name', env: 'SAML_CONNECTION_NAME', label: 'a name for the connection', required: false };
const ORG: CredentialSpec = { flag: 'saml-organization', env: 'SAML_ORGANIZATION', label: 'create the connection inside an organization with this name', required: false };

async function metadata(p: PluginContext): Promise<{ xml: string; url?: string }> {
  const src = p.credential({ ...METADATA, required: true })!;
  if (/^https:\/\//i.test(src)) {
    const res = await p.fetch(src, { headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' }, redirect: 'error' });
    if (res.status !== 200) throw new CliError(`${src} answered ${res.status}.`);
    return { xml: await res.text(), url: src };
  }
  if (/^http:\/\//i.test(src)) throw new CliError('The metadata URL must be https://.');
  return { xml: p.ctx.readFile(resolve(src)) };
}

function build(p: PluginContext, xml: string, url?: string) {
  const domains = (p.credential(DOMAINS) ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  try {
    return samlConnections(xml, { name: p.credential(NAME), domains: domains.length ? domains : undefined, metadataUrl: url });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

export const samlPlugin: MigrationPlugin = {
  vendor: 'saml',
  source: 'saml',
  label: 'Any SAML identity provider',
  help: 'Move a SAML single sign-on connection: read the IdP metadata (--set saml-metadata=<file or URL>) and create the Atlas SSO connection from it (entity id, sign-on URL, signing certificate, email domains). Afterwards give the IdP Atlas\'s entity id and ACS URL and switch the application to Atlas. The IdP\'s users are not exportable over SAML: they relink on their verified email at first sign-in.',
  config: {
    reads: 'the IdP metadata document',
    credentials: [METADATA, DOMAINS, NAME],
    async translate(p) {
      const { xml, url } = await metadata(p);
      const { connections, warnings } = build(p, xml, url);
      const b = new ConfigBuilder();
      for (const c of connections) {
        b.add('mapped', 'saml', `${c.saml?.idp_entity_id}`, 'Becomes an Atlas SSO connection (atlas migrate saml export + import). Give the IdP Atlas\'s entity id and ACS URL, shown after the import.', 'sso_connections');
        if (!c.domains?.length) b.add('manual', 'saml', `${c.saml?.idp_entity_id} domains`, 'Name the email domains that sign in through this IdP (--set saml-domains=…) so Atlas routes them to it.', 'sso_connections');
      }
      for (const w of warnings) b.add('differs', 'saml', 'metadata', w);
      return b.result(`SAML metadata ${url ?? ''}`.trim());
    },
  },
  export: {
    reads: 'the IdP metadata document (--set saml-metadata=<file or https URL>)',
    credentials: [METADATA, DOMAINS, NAME, ORG],
    limits: ['A SAML identity provider exposes no user list: users sign in through it and link to Atlas accounts on their verified email.'],
    async run(p, writer, resume) {
      const { xml, url } = await metadata(p);
      const { connections, warnings } = build(p, xml, url);
      const org = p.credential(ORG);
      const set = connectionSet(connections, `SAML metadata ${url ?? ''}`.trim(), org ? { id: org.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: org } : undefined);
      for (const w of warnings) set.warn(w);
      p.say(`  ${connections.length} identity provider(s) in the metadata`);
      await writeRecordSet(set, writer, resume, p.say);
    },
  },
};
