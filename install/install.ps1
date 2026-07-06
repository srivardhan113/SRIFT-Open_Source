#Requires -Version 5.1
<#
.SYNOPSIS
    SRIFT Universal Windows Installer / Uninstaller
.DESCRIPTION
    Installs or uninstalls the SRIFT CLI on Windows (PowerShell 5.1+, pwsh 7+).

    Install:   irm https://srift.app/install.ps1 | iex
    Uninstall: irm https://srift.app/install.ps1 | iex; # then run: Uninstall-Srift
    Or pipe with args:
      & ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall
      & ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall --purge

.NOTES
    Environment variables:
      $env:SRIFT_VERSION      - pin a specific version (default: latest)
      $env:SRIFT_INSTALL_DIR  - override install directory (default: ~\.srift\bin)
      $env:SRIFT_NO_VERIFY    - set to 1 to skip checksum (not recommended)

    Script args (when invoked with & ([scriptblock]::Create(...)) args):
      --uninstall             Remove the srift binary and PATH entry
      --purge                 Also delete ~/.srift/ config/data directory
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Force UTF-8 output so emoji + box-drawing characters render cleanly in
# legacy code pages (CP-437 / CP-1252) on default Windows consoles.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
    $OutputEncoding = New-Object System.Text.UTF8Encoding
} catch { <# best-effort #> }

$SriftVersion   = if ($env:SRIFT_VERSION)     { $env:SRIFT_VERSION }     else { '2.2.2' }
$InstallDir     = if ($env:SRIFT_INSTALL_DIR) { $env:SRIFT_INSTALL_DIR } else { Join-Path $HOME '.srift\bin' }
$BaseUrl        = 'https://srift.app/dl'
$BinPath        = Join-Path $InstallDir 'srift.exe'

function Write-Info    { param($M) Write-Host "[srift] $M" -ForegroundColor Cyan }
function Write-Success { param($M) Write-Host "[srift] $M" -ForegroundColor Green }
function Write-Warn    { param($M) Write-Host "[srift] WARNING: $M" -ForegroundColor Yellow }
function Write-Err     { param($M) Write-Host "[srift] ERROR: $M" -ForegroundColor Red; exit 1 }

# Detect architecture
function Get-Arch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { Write-Err "Unsupported CPU architecture: $arch" }
    }
}

function Get-Checksum {
    param([string]$File)
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
        return (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLower()
    }
    return $null
}

function Uninstall-Srift {
    param([switch]$Purge)

    Write-Info "Uninstalling SRIFT..."

    # Stop daemon if running (best-effort)
    if (Test-Path $BinPath) {
        try {
            $statusJson = & $BinPath daemon status --json 2>$null | ConvertFrom-Json
            if ($statusJson.running -eq $true) {
                Write-Info "Stopping daemon..."
                & $BinPath daemon stop 2>$null
                Start-Sleep -Seconds 1
            }
        } catch { <# ignore #> }
    }

    # Remove binary (handle Windows file-lock if srift is the running .exe)
    if (Test-Path $BinPath) {
        try {
            Remove-Item -Force $BinPath -ErrorAction Stop
            Write-Success "Removed binary: $BinPath"
        } catch {
            # Likely "file in use" - schedule a delayed delete via a self-cleaning .bat
            try {
                $batPath = Join-Path $env:TEMP ("srift-uninstall-" + [System.Guid]::NewGuid().ToString() + '.bat')
                $batBody = @"
@echo off
timeout /t 2 /nobreak >nul 2>&1
:retry
del /f /q "$BinPath" >nul 2>&1
if exist "$BinPath" (
  timeout /t 1 /nobreak >nul 2>&1
  goto :retry
)
del /f /q "%~f0" >nul 2>&1
"@
                Set-Content -Path $batPath -Value $batBody -Encoding ASCII -Force
                Start-Process -FilePath 'cmd.exe' -ArgumentList '/C', $batPath -WindowStyle Hidden -ErrorAction Stop | Out-Null
                Write-Info "Scheduled removal: $BinPath (deletes ~2-3s after this script exits)"
            } catch {
                Write-Warn "Could not delete or schedule deletion of $BinPath. Close any open 'srift' processes and delete manually."
            }
        }
    } else {
        Write-Warn "Binary not found at $BinPath (may already be removed)."
    }

    # Purge config directory
    if ($Purge) {
        $sriftDir = Join-Path $HOME '.srift'
        if (Test-Path $sriftDir) {
            Remove-Item -Recurse -Force $sriftDir
            Write-Success "Purged directory: $sriftDir"
        }
    }

    # Remove from user PATH
    $currentPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if ($currentPath -and ($currentPath -like "*$InstallDir*")) {
        $newPath = ($currentPath -split ';' | Where-Object { $_ -and ($_ -ne $InstallDir) }) -join ';'
        [System.Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Success "Removed $InstallDir from user PATH."

        # Broadcast PATH change so newly-opened shells don't still see srift on PATH
        try {
            $sig = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
            if (-not ('WinAPI.NativeMethods' -as [type])) {
                Add-Type -MemberDefinition $sig -Namespace WinAPI -Name NativeMethods -ErrorAction Stop | Out-Null
            }
            $HWND_BROADCAST = [IntPtr]0xffff
            $WM_SETTINGCHANGE = 0x1A
            $SMTO_ABORTIFHUNG = 0x0002
            $result = [UIntPtr]::Zero
            [WinAPI.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero,
                'Environment', $SMTO_ABORTIFHUNG, 5000, [ref]$result) | Out-Null
        } catch { <# best-effort #> }
    }

    Write-Success "SRIFT uninstalled."
    if (-not $Purge) {
        Write-Info "Config + data at ~/.srift/ preserved. Re-run with --purge to also delete them."
    }
    Write-Info "Reinstall: irm https://srift.app/install.ps1 | iex"
}

function _CompareVersion {
    param([string]$A, [string]$B)
    $pa = ($A -split '\.') | ForEach-Object { try { [int]$_ } catch { 0 } }
    $pb = ($B -split '\.') | ForEach-Object { try { [int]$_ } catch { 0 } }
    for ($i = 0; $i -lt 3; $i++) {
        $av = if ($i -lt $pa.Length) { $pa[$i] } else { 0 }
        $bv = if ($i -lt $pb.Length) { $pb[$i] } else { 0 }
        if ($av -ne $bv) { return ($av - $bv) }
    }
    return 0
}

function _CurlExe {
    # Windows 10 1803+ ships curl.exe in System32. Detect it explicitly so we
    # don't accidentally pick up a PowerShell `curl` alias which points to
    # Invoke-WebRequest (the very thing we're trying to avoid).
    $win = Join-Path $env:WINDIR 'System32\curl.exe'
    if (Test-Path $win) { return $win }
    $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# Robust download function with two backends:
#   1. curl.exe (primary)  - works on every Cloudflare POP we've tested,
#      including Mumbai/Singapore where Invoke-WebRequest 500s consistently.
#      curl uses HTTP/1.1 + plain UA by default which Cloudflare serves cleanly.
#   2. Invoke-WebRequest (fallback) - only used if curl.exe is missing
#      (Windows 7/8, stripped down images). Same retry/version-fallback
#      semantics either way.
function _DownloadFile {
    param([string]$Url, [string]$Dest, [int]$MaxAttempts = 8)
    # Identify ourselves with a sensible UA so CDN logs are useful + so we
    # don't trip generic bot heuristics with the default PowerShell UA.
    $ua = "srift-installer/$SriftVersion (PowerShell; Windows)"
    $curl = _CurlExe
    if ($curl) {
        # Rustup-style flags: enforce HTTPS + modern TLS for security, retry on
        # any 5xx, sane connect timeout. --retry-all-errors covers HTTP 5xx
        # which plain --retry does not.
        $args = @(
            '-fL',
            '--proto', '=https',
            '--tlsv1.2',
            '-A', $ua,
            '--compressed',
            '--retry', "$MaxAttempts",
            '--retry-delay', '4',
            '--retry-all-errors',
            '--connect-timeout', '15',
            '--max-time', '900',
            '-o', $Dest,
            $Url
        )
        & $curl @args
        return ($LASTEXITCODE -eq 0)
    }
    # Fallback: Invoke-WebRequest with our own retry loop + custom UA
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12, [System.Net.SecurityProtocolType]::Tls13
    $ProgressPreference = 'SilentlyContinue'
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 600 -UserAgent $ua
            return $true
        } catch {
            if ($i -lt $MaxAttempts) {
                Start-Sleep -Seconds 4
            }
        }
    }
    return $false
}

function _CheckInternet {
    # Quick HEAD against srift.app/cli/version.json - uses curl if available,
    # IWR as fallback. Returns $true if reachable within 8 s.
    $curl = _CurlExe
    if ($curl) {
        & $curl -fsS --max-time 8 --head https://srift.app/cli/version.json *> $null
        return ($LASTEXITCODE -eq 0)
    }
    try {
        Invoke-WebRequest -Uri 'https://srift.app/cli/version.json' -Method Head -UseBasicParsing -TimeoutSec 8 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function _DiscoverLatestVersion {
    # Pull the live latest version from /cli/version.json so the installer
    # always picks the truly-current binary even if this script is stale.
    $curl = _CurlExe
    try {
        if ($curl) {
            $json = & $curl -fsSL --max-time 10 https://srift.app/cli/version.json 2>$null
            if ($LASTEXITCODE -eq 0 -and $json) {
                $obj = $json | ConvertFrom-Json
                if ($obj.latest) { return [string]$obj.latest }
            }
        } else {
            $r = Invoke-WebRequest -Uri 'https://srift.app/cli/version.json' -UseBasicParsing -TimeoutSec 10
            $obj = $r.Content | ConvertFrom-Json
            if ($obj.latest) { return [string]$obj.latest }
        }
    } catch {}
    return $null
}

function Install-Main {
    param([string[]]$ScriptArgs = @())

    # Handle --uninstall flag
    if ($ScriptArgs -contains '--uninstall') {
        $purge = $ScriptArgs -contains '--purge'
        Uninstall-Srift -Purge:$purge
        return
    }

    Write-Info "SRIFT Installer v$SriftVersion"
    Write-Info "Detecting system..."

    $arch   = Get-Arch
    $target = "win-$arch"
    Write-Info "Detected: $target"

    # -- Internet connectivity ---------------------------------------------
    if (-not (_CheckInternet)) {
        Write-Err "No internet connection to https://srift.app (or it's blocked by your firewall/proxy). Aborting install. Check your network and retry."
    }

    # -- Discover what's actually 'latest' on the CDN (if no version pinned) -
    if (-not $env:SRIFT_VERSION) {
        $remoteLatest = _DiscoverLatestVersion
        if ($remoteLatest -and $remoteLatest -ne $SriftVersion) {
            Write-Info "Live latest is v$remoteLatest (this installer baked in v$SriftVersion). Using v$remoteLatest."
            $SriftVersion = $remoteLatest
        }
    }

    # -- Idempotency: is srift already installed? Decide upgrade / skip / downgrade-warn --
    $existingVersion = $null
    if (Test-Path $BinPath) {
        try {
            $verOut = & $BinPath --version 2>$null
            # First line is like "srift 2.1.6"
            $first = ($verOut -split "`n")[0]
            $m = [regex]::Match($first, '(\d+\.\d+\.\d+)')
            if ($m.Success) { $existingVersion = $m.Groups[1].Value }
        } catch { <# treat as unknown #> }
    }

    if ($existingVersion) {
        $cmp = _CompareVersion $existingVersion $SriftVersion
        if ($cmp -eq 0) {
            Write-Success "SRIFT v$existingVersion is already installed at $BinPath - nothing to do."
            Write-Info "  If you want to force a re-download, run: Remove-Item '$BinPath' -Force; <re-run installer>"
            Write-Info "  Update later: srift self-update"
            Write-Info "  Uninstall:    irm https://srift.app/install.ps1 | iex (then --uninstall)"
            # Still run doctor so the user gets a health snapshot
            try { & $BinPath doctor 2>$null } catch {}
            return
        } elseif ($cmp -lt 0) {
            Write-Info "Upgrading SRIFT v$existingVersion -> v$SriftVersion ..."
        } else {
            if ($env:SRIFT_ALLOW_DOWNGRADE -eq '1') {
                Write-Warn "Forcing downgrade from v$existingVersion to v$SriftVersion (SRIFT_ALLOW_DOWNGRADE=1)."
            } else {
                Write-Warn "You already have v$existingVersion installed, which is NEWER than v$SriftVersion."
                Write-Warn "  Not downgrading. To force a downgrade, set SRIFT_ALLOW_DOWNGRADE=1 and re-run."
                Write-Info  "  To update to the latest: srift self-update"
                return
            }
        }
    } else {
        Write-Info "Fresh install of SRIFT v$SriftVersion ..."
    }

    # -- Pre-install cleanup ----------------------------------------
    # Kill any running srift.exe so we don't hit a file-lock on the install
    # location. Then scan PATH for stale srift.exe copies in other dirs and
    # remove them (and their PATH entries) so the new install is the ONLY
    # one on the system after we're done. This mirrors what `srift uninstall`
    # does in 2.1.4+, but applied on install so re-running this script never
    # accumulates ghost installs.
    try {
        Get-Process -Name 'srift' -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Info "Stopping running srift.exe (pid $($_.Id))..."
            $_ | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    } catch { <# ignore #> }
    # Find every srift.exe reachable via PATH (user + system) + User PATH from registry
    $staleBins = New-Object System.Collections.Generic.HashSet[string]
    $pathDirs  = New-Object System.Collections.Generic.HashSet[string]
    foreach ($d in (($env:PATH) -split ';')) { if ($d) { [void]$pathDirs.Add($d) } }
    try {
        $userPath = [System.Environment]::GetEnvironmentVariable('Path','User')
        if ($userPath) { foreach ($d in ($userPath -split ';')) { if ($d) { [void]$pathDirs.Add($d) } } }
    } catch {}
    foreach ($d in $pathDirs) {
        try {
            $candidate = Join-Path $d 'srift.exe'
            if ((Test-Path $candidate) -and ((Resolve-Path $candidate).Path -ne (Resolve-Path -ErrorAction SilentlyContinue $BinPath).Path)) {
                [void]$staleBins.Add((Resolve-Path $candidate).Path)
            }
        } catch {}
    }
    if ($staleBins.Count -gt 0) {
        Write-Info "Found $($staleBins.Count) stale srift.exe install(s) on the system - removing:"
        foreach ($b in $staleBins) {
            Write-Info "  $b"
            try { Remove-Item -Force $b -ErrorAction Stop } catch {
                # Schedule a delayed delete via .bat if it's locked
                try {
                    $bat = Join-Path $env:TEMP ("srift-preinstall-cleanup-" + [System.Guid]::NewGuid().ToString() + '.bat')
                    Set-Content -Path $bat -Encoding ASCII -Value @"
@echo off
timeout /t 2 /nobreak >nul 2>&1
:retry
del /f /q "$b" >nul 2>&1
if exist "$b" (
  timeout /t 1 /nobreak >nul 2>&1
  goto :retry
)
del /f /q "%~f0" >nul 2>&1
"@
                    Start-Process -FilePath 'cmd.exe' -ArgumentList '/C', $bat -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
                } catch { <# best-effort #> }
            }
        }
    }

    $binaryUrl = "$BaseUrl/$SriftVersion/$target/srift.exe"
    $sumsUrl   = "$BaseUrl/$SriftVersion/$target/SHA256SUMS"
    $tmpDir    = [System.IO.Path]::GetTempPath() + [System.Guid]::NewGuid().ToString()
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    $tmpBin    = Join-Path $tmpDir 'srift.exe'
    $tmpSums   = Join-Path $tmpDir 'SHA256SUMS'

    # -- Download - curl primary, IWR fallback ------------------------------
    # We use curl.exe (built into Windows 10 1803+) because PowerShell's
    # Invoke-WebRequest sends a request signature that some Cloudflare POPs
    # (notably Mumbai/SIN) respond to with HTTP 500 even when the file is
    # cached and curl/browsers see 200. Curl uses HTTP/1.1 + plain UA and
    # works on every POP we've tested.
    $curlPath = _CurlExe
    if ($curlPath) {
        Write-Info "Using curl.exe ($curlPath) for download - handles 5xx + connection drops via --retry-all-errors."
    } else {
        Write-Warn "curl.exe not found - falling back to Invoke-WebRequest (may fail on some CDN edge POPs)."
    }

    # Build the candidate version list: [requested, then prev patch versions].
    # If a brand-new release just deployed, its edge cache may be cold at
    # your POP for ~5-10 min. Falling back to a recent patch (warm at every
    # POP) unblocks the install instead of retry-spinning forever.
    function _PrevPatchVersions([string]$v) {
        $parts = $v -split '\.'
        if ($parts.Count -lt 3) { return @() }
        $major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
        $list = @()
        for ($p = $patch - 1; $p -ge 0; $p--) { $list += "$major.$minor.$p" }
        return $list
    }
    $candidates = @($SriftVersion) + (_PrevPatchVersions $SriftVersion)

    $downloaded = $false
    $usedVersion = $null
    foreach ($v in $candidates) {
        $candUrl = "$BaseUrl/$v/$target/srift.exe"
        if ($v -ne $SriftVersion) {
            Write-Warn "Falling back to v$v ($candUrl) - v$SriftVersion CDN cache may still be propagating."
        } else {
            Write-Info "Downloading binary from $candUrl ..."
        }
        if (_DownloadFile -Url $candUrl -Dest $tmpBin -MaxAttempts 8) {
            $size = (Get-Item $tmpBin -ErrorAction SilentlyContinue).Length
            if ($size -and $size -gt 1000000) {   # sanity: must be >1 MB to be a real binary
                $downloaded = $true
                $usedVersion = $v
                Write-Success "Downloaded v$v ($([math]::Round($size / 1MB, 1)) MB)"
                break
            } else {
                Write-Warn "v$v download produced a suspiciously small file ($size bytes). Trying older version..."
                try { Remove-Item $tmpBin -Force -ErrorAction SilentlyContinue } catch {}
            }
        } else {
            Write-Warn "v$v unreachable after retries. Trying older version..."
        }
    }
    if (-not $downloaded) {
        Write-Err "Download failed for every available version. Check your firewall/proxy. Manual: https://srift.app/ai-agents#sdks"
    }
    $sumsUrl = "$BaseUrl/$usedVersion/$target/SHA256SUMS"
    if ($usedVersion -ne $SriftVersion) {
        Write-Info "Installed v$usedVersion (run 'srift self-update' in 5-10 min to pick up v$SriftVersion once CDN warms up)."
        $SriftVersion = $usedVersion
    }

    # -- Verify checksum (curl-fetched too) --------------------------------
    if ($env:SRIFT_NO_VERIFY -ne '1') {
        if (_DownloadFile -Url $sumsUrl -Dest $tmpSums -MaxAttempts 4) {
            try {
                $sumsContent = Get-Content $tmpSums -Raw
                $line = $sumsContent -split "`n" | Where-Object { $_ -match 'srift\.exe$' } | Select-Object -First 1
                if ($line) {
                    $expected = ($line -split '\s+')[0].ToLower()
                    $actual   = Get-Checksum $tmpBin
                    if ($actual -and $actual -ne $expected) {
                        try { Remove-Item $tmpBin -Force -ErrorAction SilentlyContinue } catch {}
                        Write-Err "Checksum mismatch!`n  Expected: $expected`n  Got:      $actual`nBinary may be corrupted; re-run the installer."
                    }
                    Write-Success "Checksum verified ($($expected.Substring(0,16))...)"
                } else {
                    Write-Warn "No checksum for srift.exe in SHA256SUMS. Skipping verification."
                }
            } catch {
                Write-Warn "Could not parse SHA256SUMS. Skipping verification."
            }
        } else {
            Write-Warn "Could not download SHA256SUMS. Skipping verification."
        }
    } else {
        Write-Warn "Checksum verification skipped (SRIFT_NO_VERIFY=1). Not recommended."
    }

    # -- Install (atomic copy; handle "running .exe is locked" case) -------
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    # Kill any still-running srift.exe so the copy doesn't fail with file-lock
    try {
        Get-Process -Name 'srift' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    } catch {}
    $copied = $false
    try {
        Copy-Item -Path $tmpBin -Destination $BinPath -Force -ErrorAction Stop
        $copied = $true
    } catch {
        # The old .exe might still be locked (Windows). Schedule the swap via
        # a self-cleaning .bat to land the new binary ~2-3s after we exit.
        try {
            $stagedDest = "$BinPath.new"
            Copy-Item -Path $tmpBin -Destination $stagedDest -Force -ErrorAction Stop
            $bat = Join-Path $env:TEMP ("srift-install-swap-" + [System.Guid]::NewGuid().ToString() + '.bat')
            Set-Content -Path $bat -Encoding ASCII -Value @"
@echo off
timeout /t 2 /nobreak >nul 2>&1
:swap
del /f /q "$BinPath" >nul 2>&1
if exist "$BinPath" (
  timeout /t 1 /nobreak >nul 2>&1
  goto :swap
)
move /y "$stagedDest" "$BinPath" >nul 2>&1
del /f /q "%~f0" >nul 2>&1
"@
            Start-Process -FilePath 'cmd.exe' -ArgumentList '/C', $bat -WindowStyle Hidden | Out-Null
            Write-Success "Installed srift $SriftVersion (deferred swap; new binary will be active in ~2-3s)"
            $copied = $true
        } catch {
            Write-Err "Could not install binary to $BinPath. Close any running 'srift' process and re-run, or set SRIFT_INSTALL_DIR to a different path."
        }
    }
    try { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue } catch {}
    if ($copied) { Write-Success "Installed srift $SriftVersion -> $BinPath" }

    # Add to PATH (user scope)
    $currentPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $currentPath) { $currentPath = '' }
    if ($currentPath -notlike "*$InstallDir*") {
        $newUserPath = if ($currentPath) { "$InstallDir;$currentPath" } else { $InstallDir }
        [System.Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        Write-Success "Added $InstallDir to user PATH."

        # Broadcast WM_SETTINGCHANGE so freshly-spawned processes pick up the new PATH
        # without requiring a logoff/reboot. Many newly-opened shells will see srift
        # immediately. Existing shells must be reopened.
        try {
            $sig = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
            if (-not ('WinAPI.NativeMethods' -as [type])) {
                Add-Type -MemberDefinition $sig -Namespace WinAPI -Name NativeMethods -ErrorAction Stop | Out-Null
            }
            $HWND_BROADCAST = [IntPtr]0xffff
            $WM_SETTINGCHANGE = 0x1A
            $SMTO_ABORTIFHUNG = 0x0002
            $result = [UIntPtr]::Zero
            [WinAPI.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero,
                'Environment', $SMTO_ABORTIFHUNG, 5000, [ref]$result) | Out-Null
        } catch { <# best-effort #> }

        Write-Info "Note: Already-open terminals must be restarted for srift to appear on PATH."
    }

    # Refresh current session PATH
    $env:PATH = "$InstallDir;$env:PATH"

    # Verify binary runs
    try {
        $ver = & $BinPath version 2>$null
        Write-Success "Binary verified: $ver"
    } catch {
        Write-Warn "Binary installed but could not execute '$BinPath version'."
        Write-Warn "Debug info:"
        Write-Warn "  Path: $BinPath"
        $binItem = Get-Item $BinPath -ErrorAction SilentlyContinue
        $sizeStr = if ($binItem) { "$($binItem.Length) bytes" } else { '?' }
        Write-Warn "  Size: $sizeStr"
        Write-Warn "Try opening a new PowerShell window and running: srift version"
    }

    # Run doctor for post-install verification
    Write-Info "Running post-install check (srift doctor)..."
    try {
        & $BinPath doctor 2>$null
        Write-Success "Post-install check passed."
    } catch {
        Write-Warn "srift doctor reported issues. Visit https://srift.app/ai-agents#troubleshooting"
    }

    Write-Host ""
    Write-Info "============================================================"
    Write-Info " SRIFT is installed! Next steps:"
    Write-Info ""
    Write-Info "  Restart PowerShell, then try:"
    Write-Info "    srift status                       # unified status view"
    Write-Info "    srift quick-share .\yourfile.zip   # share a file instantly"
    Write-Info "    srift info                         # agent integration overview"
    Write-Info "    srift install-mcp                  # MCP config for Claude/Cursor/etc."
    Write-Info ""
    Write-Info "  Update later:"
    Write-Info "    srift self-update"
    Write-Info ""
    Write-Info "  Uninstall:"
    Write-Info "    & ([scriptblock]::Create((irm https://srift.app/install.ps1))) --uninstall"
    Write-Info ""
    Write-Info "  Docs: https://srift.app/ai-agents"
    Write-Info "============================================================"
}

Install-Main -ScriptArgs $args
