import { applyImportRules, vendorTransform, type ModuleRule } from './engine';

/**
 * SAML / enterprise-IdP service-provider code → Atlas. In an Atlas app the
 * service provider is Atlas: it builds the AuthnRequest, validates the signed
 * assertion (signature, audience, recipient, time window, replay), serves the
 * SP metadata and signs the user in. The code that did that inside your app
 * (passport-saml, node-saml, samlify, saml2-js, BoxyHQ Jackson, OneLogin's
 * Node SDK) goes away, so this codemod does not rewrite it: it marks every
 * import with what replaces it and reports it with file:line. The first run is
 * safe to commit, and the old code stays until you delete it.
 */

const REPLACE =
  'Atlas is the SAML service provider now: create the SSO connection from the IdP metadata (atlas migrate saml export + import), give the IdP the entity id and ACS URL Atlas shows, and sign users in with <SignIn /> or the hosted page. Read the session with AtlasBackend#verify() from @atlasauth/backend (or @atlasauth/express / nextjs middleware)';

const whole = (name: string) => `${name}: ${REPLACE}`;

const RULES: readonly ModuleRule[] = [
  { match: 'passport-saml', default: { manual: `passport-saml's Strategy: ${REPLACE}` }, otherNamed: `passport-saml: ${REPLACE}`, whole: whole('passport-saml') },
  { match: '@node-saml/passport-saml', default: { manual: `@node-saml/passport-saml's Strategy: ${REPLACE}` }, otherNamed: `@node-saml/passport-saml: ${REPLACE}`, whole: whole('@node-saml/passport-saml') },
  { match: '@node-saml/node-saml', otherNamed: `@node-saml/node-saml: ${REPLACE}`, whole: whole('@node-saml/node-saml') },
  { match: 'samlify', default: { manual: `samlify: ${REPLACE}` }, otherNamed: `samlify (ServiceProvider / IdentityProvider): ${REPLACE}`, whole: whole('samlify') },
  { match: 'saml2-js', default: { manual: `saml2-js: ${REPLACE}` }, otherNamed: `saml2-js: ${REPLACE}`, whole: whole('saml2-js') },
  { match: '@boxyhq/saml-jackson', default: { manual: `BoxyHQ SAML Jackson: ${REPLACE}` }, otherNamed: `@boxyhq/saml-jackson: ${REPLACE}`, whole: whole('@boxyhq/saml-jackson') },
  {
    match: 'onelogin',
    default: { manual: `OneLogin's Node SDK: SAML sign-in is ${REPLACE.charAt(0).toLowerCase()}${REPLACE.slice(1)}. Its API calls (users, roles) are replaced by the Atlas backend API: createAtlasClient() from @atlasauth/backend` },
    otherNamed: `onelogin: ${REPLACE}`,
    whole: whole('onelogin'),
  },
];

export default vendorTransform({
  mightApply: (source) => /passport-saml|node-saml|samlify|saml2-js|saml-jackson|['"]onelogin['"]/.test(source),
  run(ctx) {
    applyImportRules(ctx, RULES);
  },
});
