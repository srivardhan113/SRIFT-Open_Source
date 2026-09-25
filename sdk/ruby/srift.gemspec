Gem::Specification.new do |spec|
  spec.name          = "srift"
  spec.version       = "4.1.0"
  spec.authors       = ["SRIFT"]
  spec.license       = "MIT"

  spec.summary       = "Zero-dependency Ruby client for the local SRIFT daemon."
  spec.description   = "Zero-dependency Ruby client for the local SRIFT daemon: P2P E2EE file transfer, " \
                        "session lifecycle, and chat. Uses only the Ruby standard library " \
                        "(net/http, json, uri) — no gem dependencies."
  spec.homepage      = "https://srift.app"

  spec.metadata = {
    "source_code_uri" => "https://github.com/srivardhan113/SRIFT-Open_Source",
    "bug_tracker_uri" => "https://github.com/srivardhan113/SRIFT-Open_Source/issues",
    "homepage_uri"    => spec.homepage,
  }

  spec.files                 = ["srift.rb"]
  spec.require_paths         = ["."]
  spec.required_ruby_version = ">= 2.7.0"
end
