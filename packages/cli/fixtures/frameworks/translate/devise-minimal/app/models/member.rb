class Member < ActiveRecord::Base
  devise :database_authenticatable, :encryptable, :recoverable, :rememberable
end
