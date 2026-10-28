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
  /** Badge on the sign-in option this browser used last. */
  'signIn.lastUsed': string;
  'signIn.signUpLink': string;
  'signIn.orDivider': string;
  /** Contains `{provider}`. */
  'signIn.socialButton': string;
  'signIn.emailCodeLabel': string;
  'signIn.magicLinkSent': string;
  'signIn.signedIn': string;
  'signIn.sessionNotKept': string;
  'signIn.checkOtherTab': string;
  'signIn.codeSentTo': string;
  'signIn.linkSentTo': string;
  'signIn.sending': string;
  'signIn.resendCode': string;
  'signIn.resendLink': string;
  'signIn.resendIn': string;
  'signIn.emailCodeOption': string;
  'signIn.emailLinkOption': string;
  'signIn.passwordOption': string;

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
  'signUp.passkeyOption': string;
  'signUp.passwordOption': string;
  'signUp.passkeyIntro': string;
  'signUp.passkeyPrompt': string;
  'signUp.passkeyCreate': string;
  'signUp.passkeyCancelled': string;
  'signUp.linkSentTo': string;

  'captcha.prompt': string;
  'captcha.required': string;
  'captcha.failed': string;
  'captcha.checking': string;
  'captcha.verified': string;
  'captcha.puzzlePrompt': string;
  'captcha.puzzleConfirm': string;
  'captcha.puzzleTile': string;
  'captcha.puzzleAlternative': string;

  // --- Multi-factor ----------------------------------------------------------
  'mfa.title': string;
  'mfa.subtitle': string;
  'mfa.codeLabel': string;
  'mfa.enrollFirstCodeLabel': string;
  'mfa.enrollSecondCodeLabel': string;
  'mfa.usePasskey': string;
  'mfa.useBackupCode': string;
  'mfa.submit': string;
  'mfa.enrollChoose': string;
  'mfa.enrollTotpOption': string;
  'mfa.enrollSmsOption': string;
  'mfa.enrollScan': string;
  'mfa.enrollQrAlt': string;
  'mfa.enrollSetupKey': string;
  'mfa.enrollPreparing': string;
  'mfa.phoneLabel': string;
  'mfa.phoneHint': string;
  'mfa.sendCode': string;
  'mfa.codeTextedTo': string;
  'mfa.smsCodeOption': string;
  'mfa.recoveryCodesTitle': string,
  'mfa.recoveryCodesHelp': string,
  'mfa.recoveryCodesCopy': string,
  'mfa.recoveryCodesCopied': string,
  'mfa.recoveryCodesDownload': string,
  'mfa.recoveryCodesSaved': string,

  // --- Password reset --------------------------------------------------------
  'reset.title': string;
  'reset.submit': string;
  'reset.newPasswordLabel': string;
  'requiredAction.firstNameLabel': string;
  'requiredAction.lastNameLabel': string;
  'requiredAction.sendCode': string;
  'requiredAction.skip': string;
  'requiredAction.customIntro': string;
  'profileTraits.save': string;
  'requiredAction.verifyIntro': string;
  'requiredAction.idvIntro': string;
  'requiredAction.idvStart': string;
  'requiredAction.idvOpen': string;
  'requiredAction.idvWaiting': string;
  'requiredAction.idvCheck': string;
  'requiredAction.idvDeclined': string;
  'requiredAction.idvReview': string;

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
  'organization.invitations': string;
  'organization.settings': string;
  'organization.emailLabel': string;
  'organization.sendInvite': string;
  'organization.noInvitations': string;
  'organization.remove': string;
  'organization.revoke': string;
  'organization.resend': string;
  'organization.you': string;
  'organization.leave': string;
  'organization.leaveConfirm': string;
  'organization.delete': string;
  'organization.deleteConfirm': string;
  'organization.confirm': string;
  'organization.cancel': string;
  'organization.unnamedMember': string;
  'organization.passwordPrompt': string;
  'organization.roles': string;
  'organization.roleName': string;
  'organization.roleKey': string;
  'organization.rolePermissions': string;
  'organization.createRole': string;
  'organization.saveRole': string;
  'organization.editRole': string;
  'organization.deleteRole': string;
  'organization.noCustomRoles': string;
  'impersonation.banner': string;
  'impersonation.returnToAdmin': string;
  'impersonation.end': string;

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

  // --- Device sign-in approval (RFC 8628) ------------------------------------
  'deviceAuth.title': string;
  'deviceAuth.subtitle': string;
  'deviceAuth.codeLabel': string;
  'deviceAuth.continue': string;
  'deviceAuth.request': string;
  'deviceAuth.scopesTitle': string;
  'deviceAuth.checkCode': string;
  'deviceAuth.approve': string;
  'deviceAuth.deny': string;
  'deviceAuth.approved': string;
  'deviceAuth.denied': string;
  'deviceAuth.invalidCode': string;
  'deviceAuth.another': string;
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

  // --- Server errors, by reason ---------------------------------------------
  // `error.<reason>`: the stable `reason` on a Frontend API error. Prebuilt
  // forms show this string instead of the server's `message`. `{methods}`,
  // `{min_length}`, `{max_length}` and `{history_count}` are filled from the
  // error's `meta` and MUST be kept verbatim.
  'error.form_password_incorrect': string;
  'error.form_code_incorrect': string;
  'error.form_code_already_used': string;
  'error.form_code_expired': string;
  'error.form_code_max_attempts': string;
  'error.form_link_invalid': string;
  'error.form_identifier_not_found': string;
  'error.form_identifier_exists': string;
  'error.form_password_pwned': string;
  'error.form_password_too_short': string;
  'error.form_password_too_long': string;
  'error.form_password_requires_uppercase': string;
  'error.form_password_requires_lowercase': string;
  'error.form_password_requires_number': string;
  'error.form_password_requires_symbol': string;
  'error.form_password_not_allowed': string;
  'error.form_password_contains_identifier': string;
  'error.form_password_same_as_current': string;
  'error.form_password_reused': string;
  'error.password_expired': string;
  'error.email_not_verified': string;
  'error.sign_in_token_invalid': string;
  'error.too_many_attempts': string;
  'error.too_many_requests': string;
  'error.captcha_required': string;
  'error.captcha_failed': string;
  'error.captcha_unavailable': string;
  'error.email_delivery_unavailable': string;
  'error.strategy_disabled': string;
  'error.sign_up_restricted': string;
  'error.waitlisted': string;
  'error.identifier_not_allowed': string;
  'error.disposable_email_blocked': string;
  'error.sso_required': string;
  'error.sign_ins_disabled': string;
  'error.sign_ups_disabled': string;
  'error.high_risk_blocked': string;
  'error.sms_region_blocked': string;

  // Policy acceptance (terms, privacy, any policy).
  'policy.agreeCombined': string;
  'policy.agreeOne': string;
  'policy.clickwrap': string;
  'policy.and': string;
  'policy.read': string;
  'policy.viewerBack': string;
  'policy.version': string;
  'policy.effective': string;
  'policy.scrollHint': string;
  'policy.accept': string;
  'policy.decline': string;
  'policy.summaryTitle': string;
  'policy.reacceptTitle': string;
  'policy.reacceptIntro': string;
  'policy.pendingTitle': string;
  'policy.pendingIntro': string;
  'policy.required': string;
  'policy.requiredGeneric': string;
  'policy.declined': string;
  'policy.loading': string;
  'policy.bannerTitle': string;
  'policy.bannerBody': string;
  'policy.bannerGrace': string;
  'policy.bannerReview': string;
  'policy.submit': string;
}

/**
 * A partial / community bundle: any subset of {@link LocalizationResource},
 * normally carrying its own `locale`. Layered over `en-US` at render time.
 */
export type Localization = DeepPartial<LocalizationResource>;
