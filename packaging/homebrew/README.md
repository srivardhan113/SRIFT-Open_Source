# Homebrew tap for SRIFT

This directory holds the formula that lives in the separate tap repository
`srivardhan113/homebrew-srift` (Homebrew requires third-party formulae to live
in a repo literally named `homebrew-<name>`; it cannot be a folder inside this
monorepo and be installable via `brew install`).

## One-time setup (maintainer)

```bash
gh repo create srivardhan113/homebrew-srift --public \
  --description "Homebrew tap for the SRIFT CLI (srift-transfer)"
git clone https://github.com/srivardhan113/homebrew-srift
mkdir -p homebrew-srift/Formula
cp packaging/homebrew/srift.rb homebrew-srift/Formula/srift.rb
cd homebrew-srift
git add Formula/srift.rb
git commit -m "Add srift formula"
git push
```

## End-user install

```bash
brew tap srivardhan113/srift
brew install srift
# or in one line:
brew install srivardhan113/srift/srift
```

## Keeping it current

`.github/workflows/release-distribution.yml` bumps `url`/`sha256` in the tap
repo's `Formula/srift.rb` on every GitHub release, using a fine-grained PAT
stored as the `HOMEBREW_TAP_TOKEN` secret (repo scope: `homebrew-srift` only).
Without that secret the job is skipped (see the workflow's `if:` guard) and
the bump must be done by hand using the steps in the formula's header comment.

## Submitting to homebrew-core (later)

Homebrew raised its core-repo bar to roughly 225 stars / 90 forks / 90 watchers
on the *main* SRIFT repo before homebrew-core will accept a formula PR — the
tap is the correct distribution channel until then.
