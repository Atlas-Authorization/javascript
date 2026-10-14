import type { Localization } from './types';

/**
 * German (Germany). A `DeepPartial` override of `en-US`; omitted keys fall back
 * to English. `{application}` / `{provider}` placeholders preserved verbatim.
 */
export const deDE: Localization = {
  locale: 'de-DE',

  'signIn.title': 'Anmelden',
  'signIn.subtitle': 'um mit {application} fortzufahren',
  'signIn.identifierLabel': 'E-Mail-Adresse',
  'signIn.passwordLabel': 'Passwort',
  'signIn.submit': 'Weiter',
  'signIn.forgotPassword': 'Passwort vergessen?',
  'signIn.noAccount': 'Kein Konto?',
  'signIn.signUpLink': 'Registrieren',
  'signIn.orDivider': 'oder',
  'signIn.socialButton': 'Weiter mit {provider}',
  'signIn.emailCodeLabel': 'Bestätigungscode',
  'signIn.magicLinkSent': 'Prüfen Sie Ihre E-Mails auf einen Anmeldelink.',
  'signIn.checkOtherTab':
    'Sie können diesen Tab schließen — Sie sind dort angemeldet, wo Sie begonnen haben.',

  'signUp.title': 'Konto erstellen',
  'signUp.submit': 'Weiter',
  'signUp.haveAccount': 'Sie haben bereits ein Konto?',
  'signUp.signInLink': 'Anmelden',

  'mfa.title': 'Zwei-Faktor-Authentifizierung',
  'mfa.subtitle': 'Geben Sie den Code aus Ihrer Authenticator-App ein.',
  'mfa.codeLabel': 'Code',
  'mfa.enrollFirstCodeLabel': 'Code aus Ihrer Authenticator-App',
  'mfa.enrollSecondCodeLabel': 'Der nächste angezeigte Code',
  'mfa.usePasskey': 'Stattdessen Passkey verwenden',
  'mfa.useBackupCode': 'Wiederherstellungscode verwenden',
  'mfa.submit': 'Bestätigen',

  'reset.title': 'Passwort zurücksetzen',
  'reset.submit': 'Code zum Zurücksetzen senden',
  'reset.newPasswordLabel': 'Neues Passwort',

  'userButton.manageAccount': 'Konto verwalten',
  'userButton.signOut': 'Abmelden',
  'userButton.signOutAll': 'Von allen Geräten abmelden',
  'userButton.switchTo': 'Wechseln zu',

  'commerce.subscribe': 'Abonnieren',
  'commerce.manage': 'Abrechnung verwalten',
  'commerce.invoices': 'Rechnungen',
  'commerce.noInvoices': 'Noch keine Rechnungen.',
  'commerce.viewInvoice': 'Ansehen',

  'userProfile.title': 'Konto',
  'userProfile.profileSection': 'Profil',
  'userProfile.emailsSection': 'E-Mail-Adressen',
  'userProfile.securitySection': 'Sicherheit',
  'userProfile.devicesSection': 'Aktive Geräte',
  'userProfile.dangerSection': 'Gefahrenzone',
  'userProfile.addEmail': 'E-Mail-Adresse hinzufügen',
  'userProfile.makePrimary': 'Als primär festlegen',
  'userProfile.unverified': 'Nicht bestätigt',
  'userProfile.revokeDevice': 'Abmelden',
  'userProfile.deleteAccount': 'Konto löschen',

  'organization.switcher': 'Organisation wechseln',
  'organization.personal': 'Persönliches Konto',
  'organization.members': 'Mitglieder',
  'organization.invite': 'Mitglied einladen',
  'organization.roleLabel': 'Rolle',
  'organization.createTitle': 'Organisation erstellen',
  'organization.nameLabel': 'Name der Organisation',
  'organization.create': 'Organisation erstellen',
  'organization.orCreate': 'oder eine neue Organisation erstellen',

  'waitlist.title': 'Der Warteliste beitreten',
  'waitlist.emailLabel': 'E-Mail-Adresse',
  'waitlist.submit': 'Der Warteliste beitreten',
  'waitlist.success': 'Sie stehen auf der Liste. Wir melden uns bei Ihnen.',

  'reverification.title': 'Bestätigen Sie, dass Sie es sind',
  'reverification.subtitle': 'Geben Sie Ihr Passwort erneut ein, um fortzufahren.',
  'reverification.passwordLabel': 'Passwort',
  'reverification.submit': 'Bestätigen',
  'reverification.cancel': 'Abbrechen',

  'error.generic': 'Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.',
  'error.network': 'Der Server war nicht erreichbar. Überprüfen Sie Ihre Verbindung.',
};

export default deDE;
