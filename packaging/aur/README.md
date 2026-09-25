# AUR package for SRIFT

`PKGBUILD` + `.SRCINFO` for an `srift` AUR package that installs the
published `srift-transfer` npm package via Node.js, per the
[Node.js package guidelines](https://wiki.archlinux.org/title/Node.js_package_guidelines).

`.SRCINFO` here was hand-written to match `PKGBUILD` (no Arch Linux toolchain
available in this environment to run `makepkg --printsrcinfo`). **Regenerate
it for real before pushing to the AUR:**

```bash
makepkg --printsrcinfo > .SRCINFO
```

## Before first submission

1. Fill in `sha256sums` in `PKGBUILD` (currently `SKIP`) — AUR review expects
   a real checksum, not `SKIP`, for a reproducible source tarball:
   ```bash
   curl -sL -o /tmp/srift.tgz https://registry.npmjs.org/srift-transfer/-/srift-transfer-3.0.0.tgz
   sha256sum /tmp/srift.tgz
   ```
2. `makepkg` locally to confirm it builds and `usr/bin/srift --version` works.
3. `makepkg --printsrcinfo > .SRCINFO`.

## One-time setup (maintainer, needs an AUR account + SSH key)

```bash
git clone ssh://aur@aur.archlinux.org/srift.git aur-srift
cp packaging/aur/PKGBUILD packaging/aur/.SRCINFO aur-srift/
cd aur-srift
git add PKGBUILD .SRCINFO
git commit -m "Initial import: srift 3.0.0"
git push
```

## End-user install

```bash
yay -S srift   # or: paru -S srift
```

## Keeping it current

`.github/workflows/release-distribution.yml` does **not** automate AUR
pushes (AUR only accepts SSH-key auth, not tokens, and expects a human to
review each bump) — bump `pkgver`/`sha256sums`, regenerate `.SRCINFO`, and
push to the `ssh://aur@aur.archlinux.org/srift.git` remote by hand on each
release.
