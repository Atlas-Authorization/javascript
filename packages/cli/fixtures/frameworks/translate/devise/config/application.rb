require_relative "boot"

require "rails/all"

Bundler.require(*Rails.groups)

module Shopfront
  class Application < Rails::Application
    config.load_defaults 7.2
    config.time_zone = "UTC"
  end
end
