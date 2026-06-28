# === maintainer-only utility (dot-sourced by hooks / scripts) ===
# Path resolver SSOT — dot-sourced from PowerShell hooks. Not invoked
# directly. See docs/MAINTAINERS.md.
# ULTRON - Path resolver SSOT (Sprint 2 F12 - PowerShell sibling)
#
# Dot-source from PowerShell hooks / scripts:
#     . "$env:USERPROFILE\.claude\skills\ultron\scripts\ultron-paths.ps1"
#     Write-Host $UltronPaths.audits
#     Write-Host $UltronPaths.brain_index_db
#
# Resolution priority matches ultron_paths.py:
#     1. Environment variable overrides (ULTRON_HOME, ULTRON_VAULT, etc.)
#     2. ~/.ultron/paths.json overrides (JSON object)
#     3. Default conventions ($env:USERPROFILE)
#
# Uses identical key names to the Python module so paths.json works for both.

$UserHome = $env:USERPROFILE

# Optional overrides from ~/.ultron/paths.json
$_pathsJsonPath = Join-Path $UserHome '.ultron\paths.json'
$_overrides = @{}
if (Test-Path $_pathsJsonPath) {
    try {
        $raw = Get-Content -Raw $_pathsJsonPath -ErrorAction Stop
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        $obj.PSObject.Properties | ForEach-Object {
            $_overrides[$_.Name] = [string]$_.Value
        }
    } catch {
        # silent â€” defaults take over
    }
}

function _Resolve-UltronPath {
    param(
        [string]$EnvKey,
        [string]$JsonKey,
        [string]$Default
    )
    if ([Environment]::GetEnvironmentVariable($EnvKey)) {
        return [Environment]::GetEnvironmentVariable($EnvKey)
    }
    if ($_overrides.ContainsKey($JsonKey)) {
        return $_overrides[$JsonKey]
    }
    return $Default
}

# â”€â”€ Anchor directories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$ultron  = _Resolve-UltronPath 'ULTRON_HOME'  'ultron_home'  (Join-Path $UserHome '.ultron')
$vault   = _Resolve-UltronPath 'ULTRON_VAULT' 'vault'        (Join-Path $UserHome '.ultron-vault')
$claude  = _Resolve-UltronPath 'CLAUDE_HOME'  'claude_home'  (Join-Path $UserHome '.claude')
$codex   = _Resolve-UltronPath 'CODEX_HOME'   'codex_home'   (Join-Path $UserHome '.codex')
$cockpit = Join-Path $ultron 'cockpit'

# Public hashtable. Capitalized name matches PowerShell convention; pscustomobject
# allows dot access ($UltronPaths.audits) consistent with the Python `P.audits`.
$UltronPaths = [pscustomobject]@{
    user_home              = $UserHome
    ultron                 = $ultron
    vault                  = $vault
    claude                 = $claude
    codex                  = $codex

    cockpit                = $cockpit
    hooks                  = Join-Path $ultron 'hooks'
    tmp                    = Join-Path $ultron '.tmp'
    audits                 = Join-Path $cockpit 'audits'
    news                   = Join-Path $cockpit 'news'
    plans                  = Join-Path $ultron 'plans'
    sessions               = Join-Path $ultron 'sessions'
    archive                = Join-Path $ultron 'archive'
    brain_index_dir        = Join-Path $ultron 'brain_index'
    skill_cache            = Join-Path $ultron 'skill_cache'
    skill_discoveries      = Join-Path $ultron 'skill_discoveries'

    skill_manifest_json    = Join-Path $ultron 'skill_manifest.json'
    # Manifiesto del sync cross-CLI legacy (registry_sync.py). NO es el de
    # cockpit/skill-lazy/skills-registry.json (router v2). Esquemas distintos.
    skills_registry_json   = Join-Path $ultron 'skills-registry.json'
    agent_manifest_json    = Join-Path $ultron 'agent_manifest.json'
    index_md               = Join-Path $ultron 'INDEX.md'
    background_tasks_json  = Join-Path $ultron 'background_tasks.json'
    projects_json          = Join-Path $cockpit 'projects.json'
    pending_actions_json   = Join-Path $cockpit 'pending_actions.json'
    audits_index_json      = Join-Path (Join-Path $cockpit 'audits') 'INDEX.json'
    brain_index_db         = Join-Path (Join-Path $ultron 'brain_index') 'index.db'
    route_quality_json     = Join-Path (Join-Path $ultron 'skill_cache') 'route_quality.json'
    current_session_json   = Join-Path (Join-Path $ultron '.tmp') 'current-session.json'
    current_session_mode   = Join-Path (Join-Path $ultron '.tmp') 'current-session-mode.json'
    last_stop_sync         = Join-Path (Join-Path $ultron '.tmp') 'last-stop-sync.json'
    pending_actions_prime  = Join-Path (Join-Path $ultron '.tmp') 'pending-actions-primed.json'
    decay_prime            = Join-Path (Join-Path $ultron '.tmp') 'decay-prime.json'

    claude_settings_json   = Join-Path $claude 'settings.json'
    claude_skills_dir      = Join-Path $claude 'skills'
    claude_agents_dir      = Join-Path $claude 'agents'
    claude_history_jsonl   = Join-Path $claude 'history.jsonl'
    claude_projects_dir    = Join-Path $claude 'projects'
    claude_credentials     = Join-Path $claude '.credentials.json'

    ultron_skill_dir       = Join-Path (Join-Path $claude 'skills') 'ultron'
    ultron_skill_hooks     = Join-Path (Join-Path (Join-Path $claude 'skills') 'ultron') 'hooks'
    ultron_cockpit_py      = Join-Path (Join-Path (Join-Path (Join-Path $claude 'skills') 'ultron') 'scripts') 'cockpit'
    ultron_references      = Join-Path (Join-Path (Join-Path $claude 'skills') 'ultron') 'references'
    ultron_tests           = Join-Path (Join-Path (Join-Path $claude 'skills') 'ultron') 'tests'

    vault_knowledge        = Join-Path $vault '10_KNOWLEDGE'
    vault_decisions        = Join-Path $vault '20_DECISIONS'
    vault_patterns         = Join-Path $vault '30_PATTERNS'
    vault_skills           = Join-Path $vault '40_SKILLS'
    vault_sessions_log     = Join-Path $vault '50_SESSIONS_LOG'
    vault_cc_memories      = Join-Path $vault 'CC-memories'
    vault_gitleaks_toml    = Join-Path $vault '.gitleaks.toml'

    codex_auth_json        = Join-Path $codex 'auth.json'
    codex_config_toml      = Join-Path $codex 'config.toml'
}

# Cleanup local helpers from caller scope
Remove-Variable -Name _pathsJsonPath, _overrides -ErrorAction SilentlyContinue

