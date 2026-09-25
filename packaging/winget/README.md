# winget manifests for SRIFT

Schema **1.10.0** (verified: `https://aka.ms/winget-manifest.installer.1.10.0.schema.json`
resolves; this is the current multi-file manifest schema as of writing —
re-check `microsoft/winget-cli` `doc/windows/package-manager/package/manifest.md`
before bumping). `PackageIdentifier`: `SRIFT.Srift`. Uses the `win-x64`
prebuilt binary (`InstallerType: portable`) from `https://srift.app/dl/<version>/win-x64/srift.exe`
— same artifact the Scoop manifest uses — rather than the npm package, since
winget-submitted packages are expected to be self-contained installers/binaries.

```
packaging/winget/manifests/s/SRIFT/Srift/3.0.0/
├── SRIFT.Srift.yaml              # version manifest
├── SRIFT.Srift.installer.yaml    # installer manifest (InstallerSha256 is a placeholder)
└── SRIFT.Srift.locale.en-US.yaml # default locale manifest
```

The path layout (`manifests/<first-letter-lowercase>/<Publisher>/<Package>/<Version>/`)
matches `microsoft/winget-pkgs`' own layout so this tree can be copied
directly into a fork of that repo.

## Recommended flow: `wingetcreate`, not hand-editing

```powershell
winget install wingetcreate  # or: iwr https://aka.ms/wingetcreate/latest -OutFile wingetcreate.exe

# First submission — interactively generates + validates a manifest, then
# opens the PR against microsoft/winget-pkgs for you (needs `gh auth login`
# or a GITHUB_TOKEN):
wingetcreate new https://srift.app/dl/3.0.0/win-x64/srift.exe `
  --id SRIFT.Srift --version 3.0.0

# Subsequent releases — bumps version + recomputes InstallerSha256 from the
# URL automatically, reusing the existing manifest as a template:
wingetcreate update SRIFT.Srift `
  --version 3.0.0 `
  --urls https://srift.app/dl/3.0.0/win-x64/srift.exe `
  --submit
```

`.github/workflows/release-distribution.yml`'s `winget` job runs the
`wingetcreate update --submit` form on `release: published`, gated on a
`WINGET_GITHUB_TOKEN` secret (a PAT with `public_repo` scope, since
`wingetcreate` opens the PR against `microsoft/winget-pkgs` on the
maintainer's behalf) — see that workflow for the exact `if:` guard.

## Manual validation

```powershell
winget validate --manifest packaging/winget/manifests/s/SRIFT/Srift/3.0.0/
```
