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

# Tauri.exe inherits SYSTEM PATH from its launcher (Explorer / autostart).
# That misses the USER PATH where npm shims (claude.cmd, codex.cmd) and
# WindowsApps (wt.exe) live. Merge both before resolving any binary so
# `codex`, `gemini`, `wt.exe`, etc. all resolve as if the user had opened
# their own terminal.
try {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -and ($env:PATH -notlike "*$userPath*")) {
        $env:PATH = $userPath + ";" + $env:PATH
    }
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -and ($env:PATH -notlike "*$machinePath*")) {
        $env:PATH = $env:PATH + ";" + $machinePath
    }
} catch {}

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
$continueLast = [bool]$cfg.continueLast
$forkSession  = [bool]$cfg.forkSession
# pasteOnly: explicit contract from the caller that the prompt MUST land
# on the clipboard and NEVER be auto-submitted (no argv -p / positional).
# Backwards-compatible: missing field → $false. As of v15.1.4+ clipboard is
# already the default for any non-empty prompt, so $pasteOnly is effectively
# a no-op today; it exists so callers (Dashboard "Diagnose with Claude")
# can declare the contract and so any future regression that re-introduces
# inline-prompt paths must explicitly skip the pasteOnly branch.
$pasteOnly    = [bool]$cfg.pasteOnly
# respectClipboard: caller has already seeded the clipboard itself (a
# paste-only flow that placed the *long* prompt there before spawning).
# When $true, we MUST NOT call Set-Clipboard — otherwise we overwrite the
# real prompt with the short `prompt` field (which is only a banner hint).
# Backwards-compatible: missing field → $false (legacy behaviour).
$respectClipboard = [bool]$cfg.respectClipboard
# freeTier: cuando true, la sesion se enruta por el proxy local (puerto 8082).
# El inner-script setea ANTHROPIC_BASE_URL y ANTHROPIC_AUTH_TOKEN antes de
# invocar claude. Backwards-compatible: campo ausente -> $false.
$freeTier = [bool]$cfg.freeTier

# v15.1.4+: ULTRON spawns terminals for internal flows (news, skill edit, MCP
# create, diagnose, codex-fallback) where the user already authorized the
# action by clicking the button. Forcing dangerous=true here saves them from
# having to click through provider-level confirmations every single time.
# Claude --dangerously-skip-permissions / Codex --dangerously-bypass
# map to the same intent: accept everything by default.
$dangerous    = $true

if ($provider -notin @("claude", "codex")) {
    throw "Provider must be one of claude / codex, got '$provider'"
}

function Quote-Single([string]$s) {
    return "'" + ($s -replace "'", "''") + "'"
}

# --- Build the PowerShell -Command line that runs inside the new wt tab -----

$inner = ""

if ($cwd -and $cwd.Trim().Length -gt 0) {
    $trimmedCwd = $cwd.Trim()
    # Reject UNC immediately (defense in depth against crafted projects.json
    # / session records).
    if ($trimmedCwd.StartsWith('\\')) {
        [Console]::Error.WriteLine("[spawn-claude-session] cwd is UNC, dropping: $trimmedCwd")
    } else {
        $effectiveCwd = $trimmedCwd
        # Heuristic recovery: Rust's unslug() can't tell apart a literal
        # dash inside a folder name (control-center) from a path separator
        # (`-` came from `\`). If Test-Path fails, we try collapsing the
        # last two components with `-` and look again. Walk back up to 4
        # times so e.g. C:\Users\X\.ultron\control\center can recover as
        # C:\Users\X\.ultron\control-center.
        if (-not (Test-Path -LiteralPath $effectiveCwd)) {
            for ($i = 0; $i -lt 4; $i++) {
                $segments = $effectiveCwd -split '\\'
                if ($segments.Count -lt 2) { break }
                $last = $segments[-1]
                $second = $segments[-2]
                $merged = "$second-$last"
                $newSegments = $segments[0..($segments.Count - 3)] + $merged
                $candidate = $newSegments -join '\'
                if (Test-Path -LiteralPath $candidate) {
                    $effectiveCwd = $candidate
                    break
                }
                $effectiveCwd = $candidate
            }
        }
        if (Test-Path -LiteralPath $effectiveCwd) {
            $inner += "Set-Location -LiteralPath " + (Quote-Single $effectiveCwd) + "; "
        } else {
            [Console]::Error.WriteLine("[spawn-claude-session] cwd missing on disk (after heuristic), falling back to default: $trimmedCwd")
        }
    }
}

# Spawns launch the provider CLI directly (no headroom proxy). Runtime
# measurement (proxy_savings.json, 533 requests) showed headroom saved 0
# tokens / 0 USD while adding 0.7-1.3s latency per count_tokens and 4xx/429
# errors, so it was removed from all spawns (2026-06-08). Going direct also
# keeps the 1M context window reachable for the spawned session.
$inner += $provider

switch ($provider) {
    "claude" {
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
    "codex" {
        # Codex CLI: full-auto bypasses both approvals and sandbox, the
        # equivalent of Claude's --dangerously-skip-permissions.
        if ($dangerous) { $inner += " --dangerously-bypass-approvals-and-sandbox" }
        if ($model) {
            if ($model -notmatch '^[A-Za-z0-9._\-]{1,80}$') { throw "Invalid model id" }
            $inner += " --model $model"
        }
        # Effort maps onto Codex's reasoning effort config override.
        if ($effort) {
            if ($effort -notin @("low","medium","high","xhigh","max")) { throw "Invalid effort" }
            $inner += " -c model_reasoning_effort=$effort"
        }
    }
}

# Resume / continue ignore the prompt — Claude reuses the prior transcript.
$resumeActive = ($provider -eq "claude") -and ($continueLast -or $resumeId)

# Prompt strategy (v15.1.4+):
# - ALWAYS use the clipboard path when there is a prompt. Inline -p / bare
#   positional arg breaks in too many ways: wt.exe's argv parser collapses
#   newlines, PowerShell quoting eats single-quotes inside the prompt,
#   Gemini in particular interprets some inline prompt fragments as tool
#   invocations (e.g. lines mentioning activate_skill). Clipboard-paste is
#   slower for the user by one Ctrl+V but it ALWAYS works, regardless of
#   prompt length, newlines, or special chars. Saner default.
$clipboardSeeded = $false
if ($respectClipboard) {
    # Caller already primed the clipboard with the real prompt. The
    # `$promptText` we received is a short banner hint, NOT what we want
    # the user to paste. Skip Set-Clipboard entirely.
    $clipboardSeeded = $true
    [Console]::Error.WriteLine("[spawn-claude-session] respectClipboard=true, skipping Set-Clipboard")
} elseif ($promptText -and $promptText.Trim().Length -gt 0 -and -not $resumeActive) {
    try {
        Set-Clipboard -Value $promptText
        $clipboardSeeded = $true
    } catch {
        [Console]::Error.WriteLine("[spawn-claude-session] Set-Clipboard failed: $_")
    }
}

# When we used clipboard, append a visible echo to the inner-command so the
# wt.exe tab tells the user to paste. PowerShell evaluates the echo before
# starting Claude, so it shows up at the top of the terminal.
if ($clipboardSeeded) {
    if ($respectClipboard -and $promptText -and $promptText.Trim().Length -gt 0) {
        # Use the caller's `prompt` field as the literal banner — news.rs
        # passes a short hint there ("El prompt está en el portapapeles,
        # guarda el HTML en ~/.ultron/cockpit/news/newsletter-...html").
        $msg = $promptText
    } elseif ($pasteOnly) {
        # Stronger wording when the caller explicitly asked for paste-only:
        # the user is choosing whether to send, not just how to send.
        $msg = "Prompt copiado al portapapeles. Pega con Ctrl+V, revisa/edita si quieres, y pulsa Enter para enviar."
    } else {
        $msg = "El prompt está en tu portapapeles (Ctrl+V para pegar)."
    }
    $inner = "Write-Host '" + ($msg -replace "'", "''") + "' -ForegroundColor Cyan; " + $inner
}

# --- Spawn wt.exe via Start-Process ---------------------------------------

# Critical: wt.exe's argv parser treats `;` (and `|`) as tab/pane
# separators even when they're inside our inner-command. Passing
# "Set-Location ...; claude ..." via -Command splits the line in TWO new
# tabs — first one tries to launch `Set-Location` as a program (which is
# a PowerShell cmdlet, not an exe → ERROR_FILE_NOT_FOUND), and the
# second tab launches `claude` without our cwd. This is exactly the
# "doble terminal" / "no encuentra Set-Location" symptoms the user saw.
#
# Fix: write the inner-command to a temp .ps1 file and invoke PowerShell
# with -File. The script body is opaque to wt.exe's argv parser.
$tmpRoot = Join-Path $env:USERPROFILE ".ultron\.tmp\sessions"
if (-not (Test-Path -LiteralPath $tmpRoot)) {
    New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
}
$tmpScript = Join-Path $tmpRoot ("session-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".ps1")
# Wrap the inner in a UTF-8 setup + the body. Add a banner so the user
# can see what was about to run if something fails.
# Bloque de enrutamiento free-tier: se inyecta en el inner-script
# ANTES de que claude arranque, solo cuando $freeTier es true.
$freeTierBlock = ""
if ($freeTier) {
    $freeTierBlock = @'
# --- ULTRON free-tier routing (proxy local puerto 8082) ---
$env:ANTHROPIC_BASE_URL  = 'http://127.0.0.1:8082'
$env:ANTHROPIC_AUTH_TOKEN = 'fcc-local'
Write-Host '[ULTRON] Sesion enrutada por proxy free-tier (NVIDIA NIM). Calidad puede diferir.' -ForegroundColor Yellow
# ----------------------------------------------------------
'@
}

$scriptBody = @"
# auto-generated by spawn-claude-session.ps1 — safe to delete
# F7-B encoding fix: force UTF-8 for both output and input so accented
# characters (tildes, enyes) written by the CLI display correctly in
# Windows Terminal regardless of the system OEM code page (CP850/CP437).
# chcp 65001 aligns the process code page so child processes (node, python)
# also inherit UTF-8. InputEncoding must match OutputEncoding or ReadLine
# will misinterpret multi-byte sequences pasted by the user.
try { chcp 65001 | Out-Null } catch {}
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding  = [System.Text.Encoding]::UTF8
} catch {}
`$env:PYTHONUTF8 = '1'
try {
    `$userPath = [Environment]::GetEnvironmentVariable('Path','User')
    if (`$userPath -and (`$env:PATH -notlike "*`$userPath*")) {
        `$env:PATH = `$userPath + ';' + `$env:PATH
    }
} catch {}
$freeTierBlock
$inner
"@
Set-Content -LiteralPath $tmpScript -Value $scriptBody -Encoding UTF8

$title = "ULTRON-$provider"
$wtArgs = @(
    "new-tab",
    "--title", $title,
    "--",
    "powershell.exe",
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $tmpScript
)

[Console]::Error.WriteLine("[spawn-claude-session] script=$tmpScript inner=$inner")

Start-Process -FilePath "wt.exe" -ArgumentList $wtArgs -ErrorAction Stop | Out-Null

Write-Output "launched"
