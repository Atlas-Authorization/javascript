import type { Localization } from './types';

/**
 * Portuguese (Brazil). A `DeepPartial` override of `en-US`; omitted keys fall
 * back to English. `{application}` / `{provider}` placeholders preserved.
 */
export const ptBR: Localization = {
  locale: 'pt-BR',

  'signIn.title': 'Entrar',
  'signIn.subtitle': 'para continuar no {application}',
  'signIn.identifierLabel': 'Endereço de e-mail',
  'signIn.passwordLabel': 'Senha',
  'signIn.submit': 'Continuar',
  'signIn.forgotPassword': 'Esqueceu a senha?',
  'signIn.noAccount': 'Não tem uma conta?',
  'signIn.signUpLink': 'Cadastre-se',
  'signIn.orDivider': 'ou',
  'signIn.socialButton': 'Continuar com {provider}',
  'signIn.emailCodeLabel': 'Código de verificação',
  'signIn.magicLinkSent': 'Verifique seu e-mail para encontrar o link de acesso.',
  'signIn.checkOtherTab':
    'Você pode fechar esta aba — você já está conectado onde começou.',

  'signUp.title': 'Crie sua conta',
  'signUp.submit': 'Continuar',
  'signUp.haveAccount': 'Já tem uma conta?',
  'signUp.signInLink': 'Entrar',

  'mfa.title': 'Verificação em duas etapas',
  'mfa.subtitle': 'Digite o código do seu aplicativo autenticador.',
  'mfa.codeLabel': 'Código',
  'mfa.enrollFirstCodeLabel': 'Código do seu aplicativo autenticador',
  'mfa.enrollSecondCodeLabel': 'O próximo código exibido',
  'mfa.usePasskey': 'Usar uma chave de acesso',
  'mfa.useBackupCode': 'Usar um código de recuperação',
  'mfa.submit': 'Verificar',

  'reset.title': 'Redefinir sua senha',
  'reset.submit': 'Enviar código de redefinição',
  'reset.newPasswordLabel': 'Nova senha',

  'userButton.manageAccount': 'Gerenciar conta',
  'userButton.signOut': 'Sair',
  'userButton.signOutAll': 'Sair de todos os dispositivos',
  'userButton.switchTo': 'Mudar para',

  'commerce.subscribe': 'Assinar',
  'commerce.manage': 'Gerenciar cobrança',
  'commerce.invoices': 'Faturas',
  'commerce.noInvoices': 'Nenhuma fatura ainda.',
  'commerce.viewInvoice': 'Ver',

  'userProfile.title': 'Conta',
  'userProfile.profileSection': 'Perfil',
  'userProfile.emailsSection': 'Endereços de e-mail',
  'userProfile.securitySection': 'Segurança',
  'userProfile.devicesSection': 'Dispositivos ativos',
  'userProfile.dangerSection': 'Zona de perigo',
  'userProfile.addEmail': 'Adicionar um endereço de e-mail',
  'userProfile.makePrimary': 'Tornar principal',
  'userProfile.unverified': 'Não verificado',
  'userProfile.revokeDevice': 'Sair',
  'userProfile.deleteAccount': 'Excluir conta',

  'organization.switcher': 'Trocar de organização',
  'organization.personal': 'Conta pessoal',
  'organization.members': 'Membros',
  'organization.invite': 'Convidar membro',
  'organization.roleLabel': 'Função',
  'organization.createTitle': 'Criar organização',
  'organization.nameLabel': 'Nome da organização',
  'organization.create': 'Criar organização',
  'organization.orCreate': 'ou criar uma nova organização',

  'waitlist.title': 'Entrar na lista de espera',
  'waitlist.emailLabel': 'Endereço de e-mail',
  'waitlist.submit': 'Entrar na lista de espera',
  'waitlist.success': 'Você está na lista. Entraremos em contato.',

  'reverification.title': 'Confirme que é você',
  'reverification.subtitle': 'Digite sua senha novamente para continuar.',
  'reverification.passwordLabel': 'Senha',
  'reverification.submit': 'Confirmar',
  'reverification.cancel': 'Cancelar',

  'error.generic': 'Algo deu errado. Tente novamente.',
  'error.network': 'Não conseguimos acessar o servidor. Verifique sua conexão.',
};

export default ptBR;
