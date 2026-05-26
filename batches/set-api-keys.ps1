# ULTRON — Interactive API keys setup
#
# Sets the env vars the AI Router + memory backends look for, with User
# scope so they survive reboot. Run from Control Center > Run batch.
#
# After running, RESTART the Control Center for it to pick up the new
# values (Tauri reads env vars at process startup).

$ErrorActionPreference = 'Stop'

function Show-Header {
    Write-Host ""
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host " ULTRON  API keys setup (interactive)" -ForegroundColor Cyan
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host " Scope: User (persists across reboot, no admin needed)"
    Write-Host " Skip a key by pressing ENTER without typing."
    Write-Host " Show current value by typing '?' as the new value."
    Write-Host ""
}

function Get-MaskedValue([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '<not set>' }
    if ($value.Length -le 8) { return ('*' * $value.Length) }
    return $value.Substring(0, 4) + ('*' * ($value.Length - 8)) + $value.Substring($value.Length - 4)
}

function Set-UserEnvVar {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][string]$Description,
        [Parameter(Mandatory=$false)][string]$GetUrl = ''
    )

    $current = [Environment]::GetEnvironmentVariable($Name, 'User')
    $masked = Get-MaskedValue $current

    Write-Host ""
    Write-Host "[$Name]" -ForegroundColor Yellow
    Write-Host "  $Description"
    if ($GetUrl) { Write-Host "  Get one at: $GetUrl" -ForegroundColor DarkGray }
    Write-Host "  Current: $masked"
    Write-Host -NoNewline "  New value (ENTER to skip, '?' to reveal current): "

    $input = Read-Host
    if ([string]::IsNullOrEmpty($input)) {
        Write-Host "  -> skipped" -ForegroundColor DarkGray
        return
    }
    if ($input -eq '?') {
        if ($current) { Write-Host "  Full current value: $current" -ForegroundColor Magenta }
        else { Write-Host "  Nothing set." -ForegroundColor DarkGray }
        return
    }
    if ($input.Trim().Length -lt 6) {
        Write-Host "  -> ignored (looks too short to be a real key)" -ForegroundColor Red
        return
    }

    [Environment]::SetEnvironmentVariable($Name, $input.Trim(), 'User')
    # Also set in the current process so the rest of this script sees it
    Set-Item -Path "Env:$Name" -Value $input.Trim()
    $maskedNew = Get-MaskedValue ($input.Trim())
    Write-Host "  -> set ($maskedNew)" -ForegroundColor Green
}

Show-Header

# AI Router providers (see cockpit/diagnostics/ai-router-setup-2026-05-26.md)
Set-UserEnvVar -Name 'ANTHROPIC_API_KEY' `
    -Description 'Claude direct API (50 req/min Haiku free tier with new account)' `
    -GetUrl 'https://console.anthropic.com/settings/keys'

Set-UserEnvVar -Name 'OPENAI_API_KEY' `
    -Description 'OpenAI/Codex (paid; $5 minimum)' `
    -GetUrl 'https://platform.openai.com/api-keys'

Set-UserEnvVar -Name 'GEMINI_API_KEY' `
    -Description 'Google Gemini 2.5 Flash (1500 req/day FREE, recommended)' `
    -GetUrl 'https://aistudio.google.com/app/apikey'

Set-UserEnvVar -Name 'GROQ_API_KEY' `
    -Description 'Groq Llama 3.3 70B (30 req/min FREE, ~315 tok/s, recommended)' `
    -GetUrl 'https://console.groq.com/keys'

Set-UserEnvVar -Name 'DEEPSEEK_API_KEY' `
    -Description 'DeepSeek coder (~$0.14/Mtok output, optional Codex fallback)' `
    -GetUrl 'https://platform.deepseek.com'

Set-UserEnvVar -Name 'CEREBRAS_API_KEY' `
    -Description 'Cerebras Llama variants (~1M tok/day FREE, ultra-low latency)' `
    -GetUrl 'https://cloud.cerebras.ai'

Set-UserEnvVar -Name 'OPENROUTER_API_KEY' `
    -Description 'OpenRouter (30+ free models behind a single endpoint)' `
    -GetUrl 'https://openrouter.ai/keys'

# Tokens currently sitting plaintext in ~/.claude/settings.json
# (KIRKARDO 3 CRITICAL). After setting these here, the next step is to
# move the settings.json mcp servers config to read them from env.
Set-UserEnvVar -Name 'MEM0_API_KEY' `
    -Description 'mem0 cloud memory (CRITICAL: currently plaintext in settings.json, rotate now!)' `
    -GetUrl 'https://app.mem0.ai'

Set-UserEnvVar -Name 'GITHUB_TOKEN' `
    -Description 'GitHub PAT (CRITICAL: currently plaintext in settings.json, rotate now!)' `
    -GetUrl 'https://github.com/settings/tokens'

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host " Done." -ForegroundColor Cyan
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Status after this run:"
$names = @(
    'ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GROQ_API_KEY',
    'DEEPSEEK_API_KEY','CEREBRAS_API_KEY','OPENROUTER_API_KEY',
    'MEM0_API_KEY','GITHUB_TOKEN'
)
foreach ($n in $names) {
    $v = [Environment]::GetEnvironmentVariable($n, 'User')
    $tag = if ($v) { 'OK' } else { 'missing' }
    $color = if ($v) { 'Green' } else { 'DarkGray' }
    Write-Host ("  [{0,-9}] {1}" -f $tag, $n) -ForegroundColor $color
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. RESTART Control Center (Command Palette > Rebuild Control Center)"
Write-Host "     so Tauri picks up the new env vars."
Write-Host "  2. Open AI Router tab > Providers and verify 'API Key: Configured'."
Write-Host "  3. If you set MEM0_API_KEY or GITHUB_TOKEN, edit ~/.claude/settings.json"
Write-Host "     to reference them via env var instead of leaving the plaintext"
Write-Host "     value in the file. Then rotate the old leaked tokens at"
Write-Host "     https://app.mem0.ai  and  https://github.com/settings/tokens"
Write-Host ""
