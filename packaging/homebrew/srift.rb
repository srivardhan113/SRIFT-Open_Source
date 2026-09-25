# Homebrew formula for the `srift` CLI.
#
# Installs the `srift-transfer` npm package (bin: `srift`) rather than a
# prebuilt binary: SRIFT's prebuilt binaries are served from
# https://srift.app/dl/<version>/<target>/srift (built during the app's own
# Docker image build, not attached to GitHub releases), so there is no
# release-asset URL a Homebrew formula could `url` + `sha256` against without
# re-implementing that build. The npm package is the stable, versioned,
# checksum-able (npm registry tarball) artifact — so we install it with
# Homebrew's standard `std_npm_args` pattern, matching how Homebrew packages
# every other npm-distributed CLI (see docs below).
#
# Tap: https://github.com/srivardhan113/homebrew-srift
# Formula reference: https://docs.brew.sh/Node-for-Formula-Authors
#
# To publish a new version:
#   1. `npm view srift-transfer version` / `dist.tarball` / `dist.shasum` (or
#      `npm pack srift-transfer@<version>` + `shasum -a 256`) after publishing
#      to npm.
#   2. Update `url`, `sha256`, and `version` below.
#   3. Commit to the `srivardhan113/homebrew-srift` tap repo (CI job
#      `winget-scoop-tap-bump` in `.github/workflows/release-distribution.yml`
#      does this automatically when `HOMEBREW_TAP_TOKEN` is configured).
class Srift < Formula
  desc "Zero-config, zero-token P2P E2EE file transfer, chat, and MCP server"
  homepage "https://srift.app"
  url "https://registry.npmjs.org/srift-transfer/-/srift-transfer-4.1.0.tgz"
  sha256 "" # TODO: fill in with `shasum -a 256` of the published tarball before tagging a release
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/srift --version")
    # `srift doctor --json` never touches the network beyond localhost and
    # exits 0 even with no daemon running yet (it starts one), so it is a
    # reasonable install smoke test without requiring E2E connectivity in CI.
    system "#{bin}/srift", "version", "--json"
  end
end
