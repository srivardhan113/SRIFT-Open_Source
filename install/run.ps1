# SRIFT ephemeral runner (Windows) - run ANY srift command with ZERO install.
#
#   irm https://srift.app/run.ps1 | iex                      # prints help/usage
#   & ([scriptblock]::Create((irm https://srift.app/run.ps1))) --version
#   & ([scriptblock]::Create((irm https://srift.app/run.ps1))) quick-share .\report.pdf
#
# Unlike install.ps1, this NEVER modifies PATH and installs nothing permanently.
# The binary is cached under %LOCALAPPDATA%\srift\cache\<version>\<target>\ and
# reused on later runs, so only the first invocation downloads.
#
# Env overrides:
#   $env:SRIFT_VERSION    pin a version (default: latest from /cli/version.json)
#   $env:SRIFT_CACHE_DIR  override cache location
#   $env:SRIFT_NO_VERIFY  set to 1 to skip checksum verification (not recommended)

$ErrorActionPreference = 'Stop'
$DefaultVersion = '2.2.2'
$BaseUrl = 'https://srift.app/dl'

function Write-Info { param($m) Write-Host "[srift-run] $m" -ForegroundColor Cyan }
function Die { param($m) Write-Host "[srift-run] ERROR: $m" -ForegroundColor Red; exit 1 }

# -- Detect arch --------------------------------------------------------------
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { 'x64' }
}
$target = "win-$arch"

# -- Resolve version ----------------------------------------------------------
$version = $env:SRIFT_VERSION
if (-not $version) {
  try {
    $json = Invoke-RestMethod -Uri 'https://srift.app/cli/version.json' -TimeoutSec 10
    if ($json.latest) { $version = $json.latest }
  } catch {}
  if (-not $version) { $version = $DefaultVersion }
}

$cacheRoot = if ($env:SRIFT_CACHE_DIR) { $env:SRIFT_CACHE_DIR } else { Join-Path $env:LOCALAPPDATA 'srift\cache' }
$binDir = Join-Path $cacheRoot "$version\$target"
$bin    = Join-Path $binDir 'srift.exe'
$url    = "$BaseUrl/$version/$target/srift.exe"

function Get-Curl {
  $sys = Join-Path $env:WINDIR 'System32\curl.exe'
  if (Test-Path $sys) { return $sys }
  $c = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

if (-not (Test-Path $bin)) {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $tmp = "$bin.downloading"
  Write-Info "fetching srift $version ($target) ..."
  $curl = Get-Curl
  if ($curl) {
    & $curl -fL --proto '=https' --tlsv1.2 --compressed --retry 15 --retry-delay 4 --retry-all-errors `
            --connect-timeout 15 -o $tmp $url
    if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -ErrorAction SilentlyContinue; Die "download failed from $url" }
  } else {
    try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing }
    catch { Die "download failed from $url" }
  }

  if ($env:SRIFT_NO_VERIFY -ne '1') {
    try {
      $sums = (Invoke-WebRequest -Uri "$BaseUrl/$version/$target/SHA256SUMS" -UseBasicParsing -TimeoutSec 20).Content
      $line = ($sums -split "`n" | Where-Object { $_ -match 'srift\.exe$' } | Select-Object -First 1)
      if ($line) {
        $expected = ($line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
        if ($expected -and ($actual -ne $expected)) {
          Remove-Item $tmp -ErrorAction SilentlyContinue
          Die "checksum mismatch (expected $expected, got $actual). Aborting."
        }
      }
    } catch {}
  }
  Move-Item -Force $tmp $bin
}

# No args (e.g. `irm ... | iex`) -> show srift help so the pipe does something useful.
if (-not $args -or $args.Count -eq 0) { & $bin --help; exit $LASTEXITCODE }
& $bin @args
exit $LASTEXITCODE
