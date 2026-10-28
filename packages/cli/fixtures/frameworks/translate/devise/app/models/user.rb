class User < ApplicationRecord
  # Include default devise modules. Others available are:
  # :omniauthable, :trackable
  devise :two_factor_authenticatable, :two_factor_backupable,
         otp_backup_code_length: 10, otp_number_of_backup_codes: 8

  devise :registerable, :recoverable, :rememberable, :validatable,
         :confirmable, :lockable, :timeoutable, :trackable, :invitable,
         :omniauthable, omniauth_providers: %i[google_oauth2 github saml]

  has_many :orders, dependent: :destroy
end
