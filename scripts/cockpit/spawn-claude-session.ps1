# ULTRON Control Center — Claude session launcher (PowerShell wrapper).
#
# Why a wrapper script: chaining cmd.exe /C wt.exe ... -- powershell.exe
# -Command "..." broke when extra flags were present. PowerShell's
# argument concatenation after -Command, combined with cmd.exe's quote
# handling, produced a malformed program name like `" claude -r <id>"`
# that CreateProcess rejected with ERROR_FILE_NOT_FOUND. Routing through
# a PowerShell file with a JSON payload sidesteps every layer of shell
# quoting: PowerShell parses the JSON, we build the wt args natively
# as an array, and Start-Process handles the WindowsApps reparse point
# on wt.exe.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Payload
)

$ErrorActionPreference = "Stop"

# Force UTF-8 stdout / stderr — required for serde to parse Spanish accents
# coming back through Tauri's shell plugin without U+FFFD substitution.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

# --- Parse payload ----------------------------------------------------------
# Payload arrives base64-encoded so double-quotes in the JSON survive PowerShell
# command-line argument parsing. Empty base64 -> error before we touch wt.

if ([string]::IsNullOrWhiteSpace($Payload)) {
    throw "Empty payload"
}

try {
    $json = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String($Payload)
    )
} catch {
    throw "Payload is not valid base64: $_"
}

try {
    $cfg = $json | ConvertFrom-Json
} catch {
    throw "Payload (decoded) is not valid JSON: $_ (raw=$json)"
}

$provider     = [string]$cfg.provider
$cwd          = [string]$cfg.cwd
$promptText   = [string]$cfg.prompt
$model        = [string]$cfg.model
$effort       = [string]$cfg.effort
$displayName  = [string]$cfg.name
$resumeId     = [string]$cfg.resumeId
$dangerous    = [bool]$cfg.dangerous
$continueLast = [bool]$cfg.continueLast
$forkSession  = [bool]$cfg.forkSession

if ($provider -notin @("claude", "codex", "gemini")) {
    throw "Provider must be one of claude / codex / gemini, got '$provider'"
}

function Quote-Single([string]$s) {
    return "'" + ($s -replace "'", "''") + "'"
}

# --- Build the PowerShell -Command line that runs inside the new wt tab -----

$inner = ""

if ($cwd -and $cwd.Trim().Length -gt 0) {
    $trimmedCwd = $cwd.Trim()
    # Validate the cwd before baking it into the inner-command. If it
    # doesn't exist we skip the Set-Location entirely so the spawn still
    # succeeds (Claude lands in the default cwd). Previously a missing
    # path (resume on a renamed project) killed the whole spawn under
    # $ErrorActionPreference = Stop.
    if (Test-Path -LiteralPath $trimmedCwd) {
        # Reject UNC for the same reason create_project_inner does — defense
        # in depth against a crafted projects.json or session record.
        if ($trimmedCwd.StartsWith('\\')) {
            [Console]::Error.WriteLine("[spawn-claude-session] cwd is UNC, dropping: $trimmedCwd")
        } else {
            $inner += "Set-Location -LiteralPath " + (Quote-Single $trimmedCwd) + "; "
        }
    } else {
        [Console]::Error.WriteLine("[spawn-claude-session] cwd missing on disk, falling back to default: $trimmedCwd")
    }
}

$inner += $provider

if ($provider -eq "claude") {
    if ($dangerous)    { $inner += " --dangerously-skip-permissions" }
    if ($continueLast) { $inner += " -c" }
    if ($forkSession)  { $inner += " --fork-session" }
    if ($model) {
        if ($model -notmatch '^[A-Za-z0-9._\-]{1,80}$') { throw "Invalid model id" }
        $inner += " --model $model"
    }
    if ($effort) {
        if ($effort -notin @("low","medium","high","xhigh","max")) { throw "Invalid effort" }
        $inner += " --effort $effort"
    }
    if ($displayName) {
        $clean = $displayName.Trim() -replace "[\r\n']", ""
        if ($clean.Length -gt 60) { $clean = $clean.Substring(0, 60) }
        if ($clean.Length -gt 0) { $inner += " -n " + (Quote-Single $clean) }
    }
    if ($resumeId) {
        if ($resumeId -notmatch '^[A-Fa-f0-9\-]{1,80}$') { throw "Invalid resume id" }
        $inner += " -r $resumeId"
    }
}

# Resume / continue ignore the prompt — Claude reuses the prior transcript.
$resumeActive = ($provider -eq "claude") -and ($continueLast -or $resumeId)

if ($promptText -and $promptText.Trim().Length -gt 0 -and -not $resumeActive) {
    $p = $promptText
    if ($p.Length -gt 4000) { $p = $p.Substring(0, 4000) }
    switch ($provider) {
        "gemini" { $inner += " -p " + (Quote-Single $p) }
        default  { $inner += " " + (Quote-Single $p) }
    }
}

# --- Spawn wt.exe via Start-Process ---------------------------------------

# wt.exe parses `|` and `;` in unquoted positions as tab/pane separators
# even when the value is wrapped in `--title`. Use a dash to be safe.
$title = "ULTRON-$provider"
$wtArgs = @(
    "new-tab",
    "--title", $title,
    "--",
    "powershell.exe",
    "-NoExit",
    "-NoProfile",
    "-Command", $inner
)

[Console]::Error.WriteLine("[spawn-claude-session] inner=$inner")

Start-Process -FilePath "wt.exe" -ArgumentList $wtArgs -ErrorAction Stop | Out-Null

Write-Output "launched"
