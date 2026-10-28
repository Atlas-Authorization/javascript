require_relative 'boot'
require 'rails/all'

module MyLegacyStore
  class Application < Rails::Application
    config.load_defaults 6.1
    config.session_store :active_record_store
  end
end
