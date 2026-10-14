import type { Localization } from './types';

/**
 * Spanish (Spain). A `DeepPartial` override of `en-US`; omitted keys fall back
 * to English. `{application}` / `{provider}` placeholders preserved verbatim.
 */
export const esES: Localization = {
  locale: 'es-ES',

  'signIn.title': 'Iniciar sesión',
  'signIn.subtitle': 'para continuar en {application}',
  'signIn.identifierLabel': 'Correo electrónico',
  'signIn.passwordLabel': 'Contraseña',
  'signIn.submit': 'Continuar',
  'signIn.forgotPassword': '¿Olvidaste tu contraseña?',
  'signIn.noAccount': '¿No tienes cuenta?',
  'signIn.signUpLink': 'Regístrate',
  'signIn.orDivider': 'o',
  'signIn.socialButton': 'Continuar con {provider}',
  'signIn.emailCodeLabel': 'Código de verificación',
  'signIn.magicLinkSent': 'Revisa tu correo para encontrar el enlace de acceso.',
  'signIn.checkOtherTab':
    'Puedes cerrar esta pestaña: ya has iniciado sesión donde empezaste.',

  'signUp.title': 'Crea tu cuenta',
  'signUp.submit': 'Continuar',
  'signUp.haveAccount': '¿Ya tienes una cuenta?',
  'signUp.signInLink': 'Iniciar sesión',

  'mfa.title': 'Verificación en dos pasos',
  'mfa.subtitle': 'Introduce el código de tu aplicación de autenticación.',
  'mfa.codeLabel': 'Código',
  'mfa.enrollFirstCodeLabel': 'Código de tu aplicación de autenticación',
  'mfa.enrollSecondCodeLabel': 'El siguiente código que muestre',
  'mfa.usePasskey': 'Usar una clave de acceso',
  'mfa.useBackupCode': 'Usar un código de recuperación',
  'mfa.submit': 'Verificar',

  'reset.title': 'Restablecer tu contraseña',
  'reset.submit': 'Enviar código de restablecimiento',
  'reset.newPasswordLabel': 'Nueva contraseña',

  'userButton.manageAccount': 'Administrar cuenta',
  'userButton.signOut': 'Cerrar sesión',
  'userButton.signOutAll': 'Cerrar sesión en todos los dispositivos',
  'userButton.switchTo': 'Cambiar a',

  'commerce.subscribe': 'Suscribirse',
  'commerce.manage': 'Administrar facturación',
  'commerce.invoices': 'Facturas',
  'commerce.noInvoices': 'Aún no hay facturas.',
  'commerce.viewInvoice': 'Ver',

  'userProfile.title': 'Cuenta',
  'userProfile.profileSection': 'Perfil',
  'userProfile.emailsSection': 'Direcciones de correo',
  'userProfile.securitySection': 'Seguridad',
  'userProfile.devicesSection': 'Dispositivos activos',
  'userProfile.dangerSection': 'Zona de peligro',
  'userProfile.addEmail': 'Añadir una dirección de correo',
  'userProfile.makePrimary': 'Establecer como principal',
  'userProfile.unverified': 'Sin verificar',
  'userProfile.revokeDevice': 'Cerrar sesión',
  'userProfile.deleteAccount': 'Eliminar cuenta',

  'organization.switcher': 'Cambiar de organización',
  'organization.personal': 'Cuenta personal',
  'organization.members': 'Miembros',
  'organization.invite': 'Invitar a un miembro',
  'organization.roleLabel': 'Rol',
  'organization.createTitle': 'Crear organización',
  'organization.nameLabel': 'Nombre de la organización',
  'organization.create': 'Crear organización',
  'organization.orCreate': 'o crear una nueva organización',

  'waitlist.title': 'Unirse a la lista de espera',
  'waitlist.emailLabel': 'Correo electrónico',
  'waitlist.submit': 'Unirse a la lista de espera',
  'waitlist.success': 'Estás en la lista. Nos pondremos en contacto contigo.',

  'reverification.title': 'Confirma que eres tú',
  'reverification.subtitle': 'Vuelve a introducir tu contraseña para continuar.',
  'reverification.passwordLabel': 'Contraseña',
  'reverification.submit': 'Confirmar',
  'reverification.cancel': 'Cancelar',

  'error.generic': 'Algo salió mal. Inténtalo de nuevo.',
  'error.network': 'No pudimos contactar con el servidor. Comprueba tu conexión.',
};

export default esES;
