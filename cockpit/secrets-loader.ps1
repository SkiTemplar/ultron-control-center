# =============================================================================
# ULTRON secrets-loader.ps1 — dot-sourced from PowerShell profile.
# =============================================================================
# The user profile at $PROFILE does:
#     . "$env:USERPROFILE\.ultron\cockpit\secrets-loader.ps1"
# so this file MUST exist to keep PowerShell from raising
# CommandNotFoundException every shell launch.
#
# Default: no secrets are loaded — ULTRON is a subscription-CLI tool and does
# not require API keys for normal operation (Claude / Codex / Gemini all use
# OAuth / login flows). If you want to inject env vars (OPENAI_API_KEY,
# ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.) on every shell, drop them in
# ~/.ultron/cockpit/secrets.local.ps1 (gitignored) — this loader will source
# that file if present.
# =============================================================================

$LocalSecrets = Join-Path $env:USERPROFILE ".ultron\cockpit\secrets.local.ps1"
if (Test-Path $LocalSecrets) {
    . $LocalSecrets
}
