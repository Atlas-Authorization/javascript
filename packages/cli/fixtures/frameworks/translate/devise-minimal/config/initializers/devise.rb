Devise.setup do |config|
  config.mailer_sender = 'please-change-me-at-config-initializers-devise@example.com'
  require 'devise/orm/active_record'
  config.case_insensitive_keys = [:email]
  config.stretches = Rails.env.test? ? 1 : 11
  config.encryptor = :authlogic_sha512
  config.password_length = 6..128
  config.authentication_keys = [:login]
  config.secret_key = 'f1c4a7d0b5e2f1c4a7d0b5e2f1c4a7d0b5e2f1c4a7d0b5e2'
end
