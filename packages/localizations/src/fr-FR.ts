import type { Localization } from './types';

/**
 * French (France). A `DeepPartial` override of `en-US`; any key left out falls
 * back to English at render time. `{application}` / `{provider}` placeholders
 * are preserved verbatim.
 */
export const frFR: Localization = {
  locale: 'fr-FR',

  'signIn.title': 'Se connecter',
  'signIn.subtitle': 'pour continuer vers {application}',
  'signIn.identifierLabel': 'Adresse e-mail',
  'signIn.passwordLabel': 'Mot de passe',
  'signIn.submit': 'Continuer',
  'signIn.forgotPassword': 'Mot de passe oublié ?',
  'signIn.noAccount': 'Pas de compte ?',
  'signIn.signUpLink': "S'inscrire",
  'signIn.orDivider': 'ou',
  'signIn.socialButton': 'Continuer avec {provider}',
  'signIn.emailCodeLabel': 'Code de vérification',
  'signIn.magicLinkSent': 'Vérifiez votre e-mail pour un lien de connexion.',
  'signIn.checkOtherTab':
    'Vous pouvez fermer cet onglet — vous êtes connecté là où vous avez commencé.',

  'signUp.title': 'Créer votre compte',
  'signUp.submit': 'Continuer',
  'signUp.haveAccount': 'Vous avez déjà un compte ?',
  'signUp.signInLink': 'Se connecter',

  'mfa.title': 'Vérification en deux étapes',
  'mfa.subtitle': "Saisissez le code de votre application d'authentification.",
  'mfa.codeLabel': 'Code',
  'mfa.enrollFirstCodeLabel': "Code de votre application d'authentification",
  'mfa.enrollSecondCodeLabel': 'Le code suivant affiché',
  'mfa.usePasskey': 'Utiliser une clé d’accès à la place',
  'mfa.useBackupCode': 'Utiliser un code de récupération',
  'mfa.submit': 'Vérifier',

  'reset.title': 'Réinitialiser votre mot de passe',
  'reset.submit': 'Envoyer le code de réinitialisation',
  'reset.newPasswordLabel': 'Nouveau mot de passe',

  'userButton.manageAccount': 'Gérer le compte',
  'userButton.signOut': 'Se déconnecter',
  'userButton.signOutAll': 'Se déconnecter de tous les appareils',
  'userButton.switchTo': 'Basculer vers',

  'commerce.subscribe': "S'abonner",
  'commerce.manage': 'Gérer la facturation',
  'commerce.invoices': 'Factures',
  'commerce.noInvoices': 'Aucune facture pour le moment.',
  'commerce.viewInvoice': 'Voir',

  'userProfile.title': 'Compte',
  'userProfile.profileSection': 'Profil',
  'userProfile.emailsSection': 'Adresses e-mail',
  'userProfile.securitySection': 'Sécurité',
  'userProfile.devicesSection': 'Appareils actifs',
  'userProfile.dangerSection': 'Zone de danger',
  'userProfile.addEmail': 'Ajouter une adresse e-mail',
  'userProfile.makePrimary': 'Définir comme principale',
  'userProfile.unverified': 'Non vérifiée',
  'userProfile.revokeDevice': 'Se déconnecter',
  'userProfile.deleteAccount': 'Supprimer le compte',

  'organization.switcher': "Changer d'organisation",
  'organization.personal': 'Compte personnel',
  'organization.members': 'Membres',
  'organization.invite': 'Inviter un membre',
  'organization.roleLabel': 'Rôle',
  'organization.createTitle': 'Créer une organisation',
  'organization.nameLabel': "Nom de l'organisation",
  'organization.create': 'Créer une organisation',
  'organization.orCreate': 'ou créer une nouvelle organisation',

  'waitlist.title': "Rejoindre la liste d'attente",
  'waitlist.emailLabel': 'Adresse e-mail',
  'waitlist.submit': "Rejoindre la liste d'attente",
  'waitlist.success': 'Vous êtes inscrit. Nous vous contacterons bientôt.',

  'reverification.title': "Confirmez que c'est bien vous",
  'reverification.subtitle': 'Saisissez à nouveau votre mot de passe pour continuer.',
  'reverification.passwordLabel': 'Mot de passe',
  'reverification.submit': 'Confirmer',
  'reverification.cancel': 'Annuler',

  'error.generic': "Une erreur s'est produite. Veuillez réessayer.",
  'error.network': 'Impossible de joindre le serveur. Vérifiez votre connexion.',
};

export default frFR;
