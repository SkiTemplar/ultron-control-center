# ULTRON Control Center — inline Claude / Codex / Gemini runner.
#
# Replaces the cmd.exe /C chain in sessions::run_inline_inner. Cmd's quoting
# kept choking on prompts that contained `---`, `?`, embedded quotes, or
# multi-line text — Claude / Codex would receive the prompt as multiple
# argv entries and reject `---` as an unknown option, or Windows would
# return error 0x80070003 on `?`. The fix is the same we used for
# spawn-claude-session.ps1: take the payload as base64-encoded JSON, decode
# inside PowerShell, run the CLI with the prompt bound as a single
# argument array entry. PowerShell's native invocation preserves the value
# verbatim.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Payload
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

# Merge USER PATH so npm shims (claude.cmd, codex.cmd, gemini.cmd) resolve
# even when Tauri.exe was launched without the user's shell environment.
try {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -and ($env:PATH -notlike "*$userPath*")) {
        $env:PATH = $userPath + ";" + $env:PATH
    }
} catch {}

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
    throw "Payload (decoded) is not valid JSON: $_"
}

$provider = [string]$cfg.provider
$prompt   = [string]$cfg.prompt
$model    = [string]$cfg.model

if ($provider -notin @("claude", "codex")) {
    throw "Provider must be one of claude / codex"
}
if ([string]::IsNullOrWhiteSpace($prompt)) {
    throw "Prompt is empty"
}
if ($prompt.Length -gt 60000) {
    $prompt = $prompt.Substring(0, 60000)
}

# Each provider has its own CLI shape. We call them directly with -p / exec
# so the same wrapper can stay thin.
$exitCode = 1
$stdoutText = ""
$stderrText = ""

try {
    # Pipe an empty string in so the CLIs don't sit waiting for stdin in
    # non-interactive mode (Claude/Codex warn "no stdin data received in 3s,
    # proceeding without it" otherwise). Out-String collapses the array of
    # output objects into a single text blob.
    switch ($provider) {
        "claude" {
            $args = @("-p", $prompt)
            if ($model) {
                if ($model -notmatch '^[A-Za-z0-9._\-]{1,80}$') { throw "Invalid model id" }
                $args += @("--model", $model)
            }
            $stdoutText = ("" | & claude @args 2>&1) | Out-String
            $exitCode = $LASTEXITCODE
        }
        "codex" {
            $args = @("exec")
            if ($model) {
                if ($model -notmatch '^[A-Za-z0-9._\-]{1,80}$') { throw "Invalid model id" }
                $args += @("-m", $model)
            }
            $args += $prompt
            $stdoutText = ("" | & codex @args 2>&1) | Out-String
            $exitCode = $LASTEXITCODE
        }
    }
} catch {
    $stderrText = $_.Exception.Message
    $exitCode = 1
}

$result = [PSCustomObject]@{
    success    = ($exitCode -eq 0)
    stdout     = $stdoutText
    stderr     = $stderrText
    exit_code  = $exitCode
}
$result | ConvertTo-Json -Compress -Depth 4
