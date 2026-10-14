import type { Localization } from './types';

/**
 * Japanese (Japan). A `DeepPartial` override of `en-US`; omitted keys fall back
 * to English. `{application}` / `{provider}` placeholders preserved verbatim.
 */
export const jaJP: Localization = {
  locale: 'ja-JP',

  'signIn.title': 'サインイン',
  'signIn.subtitle': '{application} に進むには',
  'signIn.identifierLabel': 'メールアドレス',
  'signIn.passwordLabel': 'パスワード',
  'signIn.submit': '続行',
  'signIn.forgotPassword': 'パスワードをお忘れですか？',
  'signIn.noAccount': 'アカウントをお持ちでないですか？',
  'signIn.signUpLink': '新規登録',
  'signIn.orDivider': 'または',
  'signIn.socialButton': '{provider} で続行',
  'signIn.emailCodeLabel': '確認コード',
  'signIn.magicLinkSent': 'サインイン用のリンクをメールでご確認ください。',
  'signIn.checkOtherTab': 'このタブは閉じて構いません。開始した場所でサインイン済みです。',

  'signUp.title': 'アカウントを作成',
  'signUp.submit': '続行',
  'signUp.haveAccount': 'すでにアカウントをお持ちですか？',
  'signUp.signInLink': 'サインイン',

  'mfa.title': '2 段階認証',
  'mfa.subtitle': '認証アプリのコードを入力してください。',
  'mfa.codeLabel': 'コード',
  'mfa.enrollFirstCodeLabel': '認証アプリのコード',
  'mfa.enrollSecondCodeLabel': '次に表示されるコード',
  'mfa.usePasskey': '代わりにパスキーを使用',
  'mfa.useBackupCode': 'リカバリコードを使用',
  'mfa.submit': '確認',

  'reset.title': 'パスワードをリセット',
  'reset.submit': 'リセットコードを送信',
  'reset.newPasswordLabel': '新しいパスワード',

  'userButton.manageAccount': 'アカウントを管理',
  'userButton.signOut': 'サインアウト',
  'userButton.signOutAll': 'すべてのデバイスからサインアウト',
  'userButton.switchTo': '切り替え',

  'commerce.subscribe': '購読する',
  'commerce.manage': '請求を管理',
  'commerce.invoices': '請求書',
  'commerce.noInvoices': 'まだ請求書はありません。',
  'commerce.viewInvoice': '表示',

  'userProfile.title': 'アカウント',
  'userProfile.profileSection': 'プロフィール',
  'userProfile.emailsSection': 'メールアドレス',
  'userProfile.securitySection': 'セキュリティ',
  'userProfile.devicesSection': 'アクティブなデバイス',
  'userProfile.dangerSection': '危険な操作',
  'userProfile.addEmail': 'メールアドレスを追加',
  'userProfile.makePrimary': 'メインに設定',
  'userProfile.unverified': '未確認',
  'userProfile.revokeDevice': 'サインアウト',
  'userProfile.deleteAccount': 'アカウントを削除',

  'organization.switcher': '組織を切り替え',
  'organization.personal': '個人アカウント',
  'organization.members': 'メンバー',
  'organization.invite': 'メンバーを招待',
  'organization.roleLabel': '役割',
  'organization.createTitle': '組織を作成',
  'organization.nameLabel': '組織名',
  'organization.create': '組織を作成',
  'organization.orCreate': 'または新しい組織を作成',

  'waitlist.title': 'ウェイトリストに参加',
  'waitlist.emailLabel': 'メールアドレス',
  'waitlist.submit': 'ウェイトリストに参加',
  'waitlist.success': 'リストに登録されました。追ってご連絡します。',

  'reverification.title': '本人確認',
  'reverification.subtitle': '続行するにはパスワードを再入力してください。',
  'reverification.passwordLabel': 'パスワード',
  'reverification.submit': '確認',
  'reverification.cancel': 'キャンセル',

  'error.generic': '問題が発生しました。もう一度お試しください。',
  'error.network': 'サーバーに接続できませんでした。接続を確認してください。',
};

export default jaJP;
