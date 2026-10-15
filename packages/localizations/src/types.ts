/**
 * `@atlasauth/localizations` — the Atlas peer of `@clerk/localizations`.
 *
 * The key namespace below is NOT invented here: it MIRRORS the canonical
 * catalog Atlas's hosted pages + React components actually reference, defined
 * in `packages/react/src/i18n.ts` as the `EN_US` `Catalog`. Atlas's own i18n
 * catalog is deliberately FLAT — dotted keys (`signIn.title`) rather than
 * nested objects — because "nesting looks tidier and makes a missing key a
 * runtime crash on `undefined.of.a.chain` rather than a visible fallback"
 * (quoting that module). We keep the exact same flat dotted keys so a bundle
 * from this package drops straight into `<AtlasProvider localization={…}>`
 * (whose `localization` prop is typed `Catalog = Record<string, string>`).
 *
 * This is why the type is a flat string record rather than the deeply-nested
 * Clerk `LocalizationResource` (`signIn.start.title`, `formFieldLabel__*`): the
 * task's Clerk shape is the fallback for "no central key set", and Atlas HAS a
 * central key set — so we mirror it exactly. The one addition over the raw
 * `Catalog` is a `locale` field, matching Clerk's convention of tagging each
 * bundle with its own BCP-47 locale.
 *
 * Bundles shipped complete (`en-US`, `es-ES`, `fr-FR`, `de-DE`, `pt-BR`) are
 * typed as the full `LocalizationResource`, so a new key they lack is a compile
 * error. `DeepPartial` (`Localization`) is for every other bundle: a community
 * translation may fill as few or as many keys as it likes, and Atlas's
 * `withFallback(locale)` layers it over `en-US` so a partial bundle still
 * renders every surface.
 */

/** Make every field (recursively) optional. Flat here, but future-proof. */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * The complete set of UI strings Atlas's hosted pages + React components read.
 *
 * Every member mirrors a key in `packages/react/src/i18n.ts`'s `EN_US`
 * catalog, 1:1, plus a `locale` tag. `{application}` and `{provider}` are
 * interpolation placeholders Atlas's `translate()` fills at render time and
 * MUST be preserved verbatim in every translation.
 */
export interface LocalizationResource {
  /** The BCP-47 locale this bundle provides, e.g. `"en-US"`, `"fr-FR"`. */
  locale: string;

  // --- Sign in ---------------------------------------------------------------
  'signIn.title': string;
  /** Contains `{application}`. */
  'signIn.subtitle': string;
  'signIn.identifierLabel': string;
  'signIn.passwordLabel': string;
  'signIn.submit': string;
  'signIn.forgotPassword': string;
  'signIn.noAccount': string;
  'signIn.signUpLink': string;
  'signIn.orDivider': string;
  /** Contains `{provider}`. */
  'signIn.socialButton': string;
  'signIn.emailCodeLabel': string;
  'signIn.magicLinkSent': string;
  'signIn.checkOtherTab': string;

  // --- Sign up ---------------------------------------------------------------
  'signUp.title': string;
  'signUp.submit': string;
  'signUp.haveAccount': string;
  'signUp.signInLink': string;
  'signUp.emailLabel': string;
  'signUp.passwordLabel': string;
  'signUp.optionalField': string;
  'signUp.selectPlaceholder': string;
  'signUp.consentAgree': string;
  'signUp.consentNotice': string;
  'signUp.terms': string;
  'signUp.privacy': string;
  'signUp.and': string;
  'signUp.emailUnavailable': string;

  'captcha.prompt': string;
  'captcha.required': string;
  'captcha.failed': string;

  // --- Multi-factor ----------------------------------------------------------
  'mfa.title': string;
  'mfa.subtitle': string;
  'mfa.codeLabel': string;
  'mfa.enrollFirstCodeLabel': string;
  'mfa.enrollSecondCodeLabel': string;
  'mfa.usePasskey': string;
  'mfa.useBackupCode': string;
  'mfa.submit': string;

  // --- Password reset --------------------------------------------------------
  'reset.title': string;
  'reset.submit': string;
  'reset.newPasswordLabel': string;

  // --- User button -----------------------------------------------------------
  'userButton.manageAccount': string;
  'userButton.signOut': string;
  'userButton.signOutAll': string;
  'userButton.switchTo': string;

  // --- Commerce / billing ----------------------------------------------------
  'commerce.subscribe': string;
  'commerce.manage': string;
  'commerce.invoices': string;
  'commerce.noInvoices': string;
  'commerce.viewInvoice': string;

  // --- User profile ----------------------------------------------------------
  'userProfile.title': string;
  'userProfile.profileSection': string;
  'userProfile.emailsSection': string;
  'userProfile.securitySection': string;
  'userProfile.devicesSection': string;
  'userProfile.dangerSection': string;
  'userProfile.addEmail': string;
  'userProfile.makePrimary': string;
  'userProfile.unverified': string;
  'userProfile.revokeDevice': string;
  'userProfile.deleteAccount': string;

  // --- Organization ----------------------------------------------------------
  'organization.switcher': string;
  'organization.personal': string;
  'organization.members': string;
  'organization.invite': string;
  'organization.roleLabel': string;
  'organization.createTitle': string;
  'organization.nameLabel': string;
  'organization.create': string;
  'organization.orCreate': string;

  // --- Waitlist --------------------------------------------------------------
  'waitlist.title': string;
  'waitlist.emailLabel': string;
  'waitlist.submit': string;
  'waitlist.success': string;

  // --- Reverification --------------------------------------------------------
  'reverification.title': string;
  'reverification.subtitle': string;
  'reverification.passwordLabel': string;
  'reverification.submit': string;
  'reverification.cancel': string;

  // --- API keys (end-user self-service) -------------------------------------
  'apiKeys.title': string;
  'apiKeys.subtitle': string;
  'apiKeys.organizationSubtitle': string;
  'apiKeys.empty': string;
  'apiKeys.disabled': string;
  'apiKeys.create': string;
  'apiKeys.nameLabel': string;
  'apiKeys.namePlaceholder': string;
  'apiKeys.expiresLabel': string;
  'apiKeys.expiresNever': string;
  /** Contains `{days}`. */
  'apiKeys.expiresDays': string;
  'apiKeys.scopesLabel': string;
  'apiKeys.submit': string;
  'apiKeys.cancel': string;
  'apiKeys.secretTitle': string;
  'apiKeys.secretHint': string;
  'apiKeys.copy': string;
  'apiKeys.copied': string;
  'apiKeys.done': string;
  'apiKeys.rename': string;
  'apiKeys.save': string;
  'apiKeys.revoke': string;
  'apiKeys.revokeConfirm': string;
  'apiKeys.revokeConfirmButton': string;
  'apiKeys.unnamed': string;
  'apiKeys.revoked': string;
  'apiKeys.expired': string;
  /** Contains `{date}`. */
  'apiKeys.lastUsed': string;
  'apiKeys.neverUsed': string;
  /** Contains `{date}`. */
  'apiKeys.expiresOn': string;
  'apiKeys.limits': string;
  /** Contains `{max}`. */
  'apiKeys.limitReached': string;

  // --- Errors ----------------------------------------------------------------
  'error.generic': string;
  'error.network': string;
}

/**
 * A partial / community bundle: any subset of {@link LocalizationResource},
 * normally carrying its own `locale`. Layered over `en-US` at render time.
 */
export type Localization = DeepPartial<LocalizationResource>;
