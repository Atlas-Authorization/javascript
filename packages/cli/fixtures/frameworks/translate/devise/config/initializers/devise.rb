# frozen_string_literal: true

# Use this hook to configure devise mailer, warden hooks and so forth.
# Many of these configuration options can be set straight in your model.
Devise.setup do |config|
  # The secret key used by Devise. Devise uses this key to generate
  # random tokens. Changing this key will render invalid all existing
  # confirmation, reset password and unlock tokens in the database.
  config.secret_key = ENV["DEVISE_SECRET_KEY"]

  # ==> Controller configuration
  # Configure the parent class to the devise controllers.
  # config.parent_controller = 'DeviseController'

  # ==> Mailer Configuration
  config.mailer_sender = "accounts@shopfront.example"

  # ==> ORM configuration
  require "devise/orm/active_record"

  # ==> Configuration for any authentication mechanism
  config.authentication_keys = [:email]
  config.case_insensitive_keys = [:email]
  config.strip_whitespace_keys = [:email]
  config.paranoid = true
  config.skip_session_storage = [:http_auth]

  # ==> Configuration for :database_authenticatable
  config.stretches = Rails.env.test? ? 1 : 12
  config.pepper = ENV.fetch("DEVISE_PEPPER")

  # ==> Configuration for :confirmable
  config.allow_unconfirmed_access_for = 0.days
  config.confirm_within = 3.days
  config.reconfirmable = true

  # ==> Configuration for :rememberable
  config.remember_for = 4.weeks
  config.expire_all_remember_me_on_sign_out = true

  # ==> Configuration for :validatable
  config.password_length = 12..128
  config.email_regexp = /\A[^@\s]+@[^@\s]+\z/

  # ==> Configuration for :timeoutable
  config.timeout_in = 2.hours

  # ==> Configuration for :lockable
  config.lock_strategy = :failed_attempts
  config.unlock_strategy = :both
  config.maximum_attempts = 5
  config.unlock_in = 1.hour

  # ==> Configuration for :recoverable
  config.reset_password_within = 6.hours
  config.sign_in_after_reset_password = false

  # ==> Navigation configuration
  config.sign_out_via = :delete

  # ==> OmniAuth
  config.omniauth :google_oauth2, ENV["GOOGLE_CLIENT_ID"], ENV["GOOGLE_CLIENT_SECRET"], scope: "email,profile"
  config.omniauth :github, ENV.fetch("GITHUB_KEY"), Rails.application.credentials.dig(:github, :secret), scope: "user:email"
  config.omniauth :saml, idp_sso_service_url: ENV["SAML_SSO_URL"], idp_cert: ENV["SAML_IDP_CERT"]

  # ==> Hotwire/Turbo configuration
  config.responder.error_status = :unprocessable_entity
  config.responder.redirect_status = :see_other
end
