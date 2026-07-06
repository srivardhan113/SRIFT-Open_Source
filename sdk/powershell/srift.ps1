# SRIFT PowerShell module — Windows PowerShell 5.1+, PowerShell 7+, pwsh on Linux/macOS.
#
# Import:
#   Import-Module ./srift.ps1
#   Invoke-SriftQuickShare /abs/path/file.zip
#
# Or call as a script:
#   ./srift.ps1 quick-share /abs/path/file.zip

$Script:SriftBase = if ($env:SRIFT_BASE_URL) { $env:SRIFT_BASE_URL } else { "http://127.0.0.1:3822" }

function Invoke-SriftCall {
    param(
        [string]$Path,
        [string]$Method = "GET",
        $Body = $null
    )
    $params = @{ Uri = "$Script:SriftBase$Path"; Method = $Method; ContentType = 'application/json' }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
    try { Invoke-RestMethod @params }
    catch {
        # Distinguish HTTP errors (daemon responded but returned 4xx/5xx) from connection errors
        $resp = $_.Exception.Response
        if ($resp -ne $null) {
            # HTTP error — extract the error body
            try {
                $stream = $resp.GetResponseStream()
                $reader = [System.IO.StreamReader]::new($stream)
                $bodyText = $reader.ReadToEnd()
                $reader.Close()
                $parsed = $bodyText | ConvertFrom-Json -ErrorAction SilentlyContinue
                $msg = if ($parsed -and $parsed.error) { $parsed.error } else { $bodyText }
            } catch {
                $msg = "HTTP $([int]$resp.StatusCode)"
            }
            throw [System.Exception]::new("srift: $msg")
        }
        # Connection error — daemon not running
        throw [System.Exception]::new("SRIFT daemon unreachable at $Script:SriftBase. Start it with: srift daemon start. ($_)")
    }
}

function Invoke-SriftStatus       { Invoke-SriftCall -Path "/status" }
function Invoke-SriftState        { Invoke-SriftCall -Path "/state" }
function Invoke-SriftQuickShare   { param([Parameter(Mandatory)][string]$FilePath, [string]$SessionName = "AI-QuickShare")
    Invoke-SriftCall -Path "/quick-share" -Method POST -Body @{ filePath = $FilePath; sessionName = $SessionName } }
function New-SriftSession         { param([string]$Name, [string]$RoomSecret)
    Invoke-SriftCall -Path "/session/start" -Method POST -Body @{ sessionName = $Name; roomSecret = $RoomSecret } }
function Join-SriftSession        { param([Parameter(Mandatory)][string]$SessionId, [string]$Username, [string]$RoomSecret)
    Invoke-SriftCall -Path "/session/join" -Method POST -Body @{ sessionId = $SessionId; username = $Username; roomSecret = $RoomSecret } }
function Approve-SriftJoin        { param([Parameter(Mandatory)][string]$TempUserId)
    Invoke-SriftCall -Path "/session/approve" -Method POST -Body @{ tempUserId = $TempUserId } }
function Deny-SriftJoin           { param([Parameter(Mandatory)][string]$TempUserId, [string]$Reason)
    Invoke-SriftCall -Path "/session/reject" -Method POST -Body @{ tempUserId = $TempUserId; reason = $Reason } }
function Remove-SriftPeer         { param([Parameter(Mandatory)][string]$UserId)
    Invoke-SriftCall -Path "/session/kick" -Method POST -Body @{ userId = $UserId } }
function Close-SriftSession       { Invoke-SriftCall -Path "/session/close" -Method POST }
function Send-SriftFile           { param([Parameter(Mandatory)][string]$FilePath, [string]$Protocol)
    Invoke-SriftCall -Path "/send" -Method POST -Body @{ filePath = $FilePath; protocol = $Protocol } }
function Receive-SriftFile        { param([Parameter(Mandatory)][string]$FileId, [string]$SaveDir = $(Get-Location).Path)
    Invoke-SriftCall -Path "/receive" -Method POST -Body @{ fileId = $FileId; saveDir = $SaveDir } }
function Send-SriftChat           { param([Parameter(Mandatory)][string]$Message)
    Invoke-SriftCall -Path "/chat/send" -Method POST -Body @{ message = $Message } }
function Get-SriftChatHistory     { Invoke-SriftCall -Path "/chat/history" }
function Get-SriftTransfers       { ,@((Invoke-SriftStatus).activeTransfers) }

# Script-mode dispatch
if ($MyInvocation.InvocationName -ne $null -and $args.Count -ge 1) {
    $cmd, $rest = $args
    switch ($cmd) {
        "quick-share" { Invoke-SriftQuickShare -FilePath $rest[0] -SessionName $rest[1] | ConvertTo-Json -Depth 10 }
        "status"      { Invoke-SriftStatus | ConvertTo-Json -Depth 10 }
        "state"       { Invoke-SriftState | ConvertTo-Json -Depth 10 }
        "send"        { Send-SriftFile -FilePath $rest[0] | ConvertTo-Json -Depth 10 }
        "receive"     { Receive-SriftFile -FileId $rest[0] -SaveDir $rest[1] | ConvertTo-Json -Depth 10 }
        "chat"        { Send-SriftChat -Message $rest[0] | ConvertTo-Json -Depth 10 }
        "history"     { Get-SriftChatHistory | ConvertTo-Json -Depth 10 }
        "list"        { Get-SriftTransfers | ConvertTo-Json -Depth 10 }
        default       { Write-Host "Usage: srift.ps1 {quick-share|status|state|send|receive|chat|history|list} [args]" }
    }
}
