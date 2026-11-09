# ULTRON cockpit CLI - manual entry point for the Python cockpit scripts.
# The Control Center (Tauri) does not call this file: open/scan live in Rust
# (projects/registry.rs, projects/scan.rs). Only subcommands whose target
# script exists in scripts/cockpit/ are dispatched (pruned 2026-10-08).
#
#   ultron status                  - text dashboard
#   ultron open <project>          - launch project in IDE
#   ultron projects                - project browser
#   ultron scan                    - discover projects
#   ultron health                  - system health check
#   ultron doctor                  - full doctor diagnostics
#   ultron brain query <q>         - FTS5 search (brain_index.py)
#   ultron mcp health              - MCP health probe
#   ultron schedule <install|status|uninstall>
#   ultron skills <registry|vault|manifest>
#   ultron security <scan|...>     - security audit
#   ultron help
#
# ASCII only: PowerShell 5.1 parses BOM-less files as cp1252.

param(
    [Parameter(Position=0)]
    [string]$Command = "help",

    [Parameter(Position=1, ValueFromRemainingArguments=$true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"

$CockpitDir = $PSScriptRoot
# Prefer 'uv run python' (global rule); fall back to plain 'python' if uv is
# not on PATH.
$UseUv = [bool] (Get-Command uv -ErrorAction SilentlyContinue)

function Invoke-Py([string]$script, [string[]]$arglist) {
    # Typed [string[]] $arglist forces PS5.1 to coerce whatever the caller
    # passes (scalar, single-element array) into a proper String[]; passed
    # unsplatted to native exes, each element becomes one argv slot.
    $scriptPath = Join-Path $CockpitDir $script
    if ($null -eq $arglist) { $arglist = @() }
    if ($UseUv) {
        & uv run python $scriptPath $arglist
    } else {
        & python $scriptPath $arglist
    }
    return $LASTEXITCODE
}

function Invoke-Ps($script, $arglist) {
    # Same PS5.1 unwrap pattern as Invoke-Py: outer @() so a 1-element
    # arglist (e.g. @("-Status")) survives as Object[], not as a scalar that
    # splatting would expand char-by-char.
    $scriptPath = Join-Path $CockpitDir $script
    $safeArgs = @(if ($arglist) { $arglist } else { @() })
    & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath @safeArgs
    return $LASTEXITCODE
}

function Get-Tail([string[]]$items) {
    return @(if ($items.Count -gt 1) { $items[1..($items.Count - 1)] } else { @() })
}

function Show-Help {
    Write-Host ""
    Write-Host "ULTRON cockpit CLI" -ForegroundColor Cyan
    Write-Host "=================="
    Write-Host ""
    Write-Host "USAGE:" -ForegroundColor Yellow
    Write-Host '  ultron [command] [args]'
    Write-Host ""
    Write-Host "PROJECTS:" -ForegroundColor Yellow
    Write-Host "  status                   Dashboard: projects, alerts, scheduler"
    Write-Host '  open [project]           Launch project in its IDE'
    Write-Host '  projects [--list|--search [q]]'
    Write-Host "                           Browse registry"
    Write-Host "  scan [--verbose|--dry-run]"
    Write-Host "                           Re-scan filesystem for projects"
    Write-Host '  project <edit|add|delete|tag> ...'
    Write-Host "                           project_editor.py wrappers"
    Write-Host '  notes <id> [save|list|export|delete]'
    Write-Host "                           Per-project persistent notes"
    Write-Host ""
    Write-Host "SESSIONS AND APPS:" -ForegroundColor Yellow
    Write-Host "  claude [args]            Spawn interactive Claude session in cwd (new tab)"
    Write-Host "  codex  [args]            Spawn interactive Codex session in cwd"
    Write-Host "  app <name> [args]        Launch GUI app from the registry"
    Write-Host "  apps [list|discover|add|remove]"
    Write-Host "                           Manage GUI app registry"
    Write-Host ""
    Write-Host "SKILLS:" -ForegroundColor Yellow
    Write-Host "  skills registry <...>    registry_sync.py (status|propagate|register|...)"
    Write-Host "  skills vault <...>       skill_vault.py (status|list|search|restore|...)"
    Write-Host "  skills manifest [list|sync|validate]"
    Write-Host "  skill register <name|all>  Re-index skills in brain_index"
    Write-Host "  skill list               Installed skills + index status"
    Write-Host "  skills-embed <...>       embed_skills.py (Qdrant ultron_skills, optional)"
    Write-Host "  manifest <...>           skill_manifest.py (list|sync|validate|add|deprecate)"
    Write-Host "  sync                     registry auto-discover + manifest sync"
    Write-Host "  sync-all                 sync + brain index + MCP probe + deadwood + doctor"
    Write-Host ""
    Write-Host "SYSTEM:" -ForegroundColor Yellow
    Write-Host "  health                   System health check (deps + scripts + configs)"
    Write-Host "  doctor [--fix|--json|--health-check|--token-audit|--quiet]"
    Write-Host "  deadwood [--json|--report|--quiet|--roots P]"
    Write-Host "  mcp health               Probe all MCP servers"
    Write-Host "  alerts <list|read-unacked|ack|purge|write>"
    Write-Host "  security <scan|audit-all|provenance|settings-*|secrets|allowlist>"
    Write-Host "  brain <build|update|query|stats|inspect>"
    Write-Host "  index <build|update|query|stats>   Alias of brain"
    Write-Host "  config <show|get|set|reset|path>   brain_config.py"
    Write-Host "  schedule <install|status|uninstall>"
    Write-Host ""
    Write-Host "  alias                    Print PowerShell profile alias to copy"
    Write-Host "  help                     This message"
    Write-Host ""
}

function Show-Status {
    Write-Host ""
    Write-Host "ULTRON Status" -ForegroundColor Cyan
    Write-Host "============="
    Write-Host ""

    $projectsJson = Join-Path $env:USERPROFILE ".ultron\cockpit\projects.json"

    if (Test-Path $projectsJson) {
        $data = Get-Content -Raw -Encoding UTF8 $projectsJson | ConvertFrom-Json
        $projects = $data.projects
        $byStatus = @{}
        foreach ($p in $projects) {
            $s = if ($p.status) { $p.status } else { "?" }
            if (-not $byStatus.ContainsKey($s)) { $byStatus[$s] = 0 }
            $byStatus[$s] += 1
        }

        Write-Host "[Projects]" -ForegroundColor Green
        Write-Host ("  Total: {0}  |  Last scan: {1}" -f $projects.Count, $data.last_scan)
        foreach ($k in $byStatus.Keys | Sort-Object) {
            Write-Host ("    {0,-18} {1}" -f $k, $byStatus[$k])
        }

        Write-Host ""
        Write-Host "  Recent activity:" -ForegroundColor DarkGray
        $recent = $projects |
            Where-Object { $_.status -in @("active","auto-detected") -and $_.last_active } |
            Sort-Object -Property last_active -Descending |
            Select-Object -First 5
        foreach ($p in $recent) {
            Write-Host ("    {0,-32} {1,-14} last={2}" -f $p.id, $p.ide, $p.last_active)
        }
    } else {
        Write-Host "[Projects]" -ForegroundColor Yellow
        Write-Host "  No registry yet. Run: ultron scan"
    }

    Write-Host ""
    Write-Host "[Alerts]" -ForegroundColor Green
    Write-Host "  ultron alerts list --unacked"
    Write-Host ""
    Write-Host "[Usage]" -ForegroundColor Green
    Write-Host "  claude /usage  (native interactive command)"
    Write-Host ""

    Write-Host "[Scheduler]" -ForegroundColor Green
    $schedulerScript = Join-Path $CockpitDir "install-scheduler.ps1"
    if (Test-Path $schedulerScript) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $schedulerScript -Status 2>&1 |
            Select-Object -First 6 |
            ForEach-Object { Write-Host "  $_" }
    }
    Write-Host ""
}

function Show-Alias {
    Write-Host ""
    Write-Host "Add this to your PowerShell profile (`$PROFILE):" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  function ultron { & '$PSCommandPath' @args }" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Or one-liner to install it now:" -ForegroundColor Cyan
    Write-Host ""
    $line = "function ultron { & '" + $PSCommandPath + "' @args }"
    Write-Host "  Add-Content -Path `$PROFILE -Value `"$line`"" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Then in any new PowerShell session: ultron status" -ForegroundColor DarkGray
    Write-Host ""
}

function Start-CliSession([string]$title, [string]$exe) {
    # Spawn an interactive CLI session in the current cwd. Windows Terminal if
    # available, otherwise a PowerShell window. Pass-through args go to the CLI.
    $cwd = Get-Location
    if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
        $wtArgs = @("new-tab", "--title", $title, "-d", $cwd.Path, $exe)
        if ($Rest) { $wtArgs += $Rest }
        Start-Process wt.exe -ArgumentList $wtArgs
        Write-Host "[$exe] Spawned new tab in Windows Terminal (cwd=$cwd)" -ForegroundColor Green
    } else {
        $cmdLine = $exe
        if ($Rest) { $cmdLine += " " + ($Rest -join " ") }
        Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmdLine -WorkingDirectory $cwd
        Write-Host "[$exe] Spawned PowerShell window (cwd=$cwd)" -ForegroundColor Green
    }
}

function Invoke-McpHealth {
    # Live probe of all MCPs in settings.json; pretty-prints the JSON output
    # of mcp_health_check.py --json.
    Write-Host "[mcp health] Probing MCP servers (max ~7s)..." -ForegroundColor Cyan
    $remaining = Get-Tail $Rest
    $healthScript = Join-Path $CockpitDir "mcp_health_check.py"
    $rawOutput = if ($UseUv) {
        & uv run python $healthScript "--json" $remaining
    } else {
        & python $healthScript "--json" $remaining
    }
    $rawJoined = ($rawOutput -join "`n").Trim()
    if (-not $rawJoined) {
        Write-Host "[mcp health] (no output - health check produced nothing)" -ForegroundColor Yellow
        exit 1
    }
    try {
        $parsed = $rawJoined | ConvertFrom-Json
    } catch {
        Write-Host $rawJoined
        return
    }
    Write-Host ""
    Write-Host "MCP Health Report" -ForegroundColor Cyan
    Write-Host "================="
    Write-Host ("  Checked at : {0}" -f $parsed.checked_at)
    Write-Host ("  Duration   : {0} ms" -f $parsed.duration_ms)
    Write-Host ""
    $okCount = 0; $degCount = 0; $missCount = 0
    foreach ($prop in $parsed.results.PSObject.Properties) {
        $name = $prop.Name; $status = $prop.Value
        $color = switch ($status) {
            "ok"       { $okCount++;   "Green" }
            "degraded" { $degCount++;  "Yellow" }
            "missing"  { $missCount++; "Red" }
            default    { "Gray" }
        }
        Write-Host ("  {0,-22} {1}" -f $name, $status) -ForegroundColor $color
    }
    Write-Host ""
    Write-Host ("Summary: {0} ok, {1} degraded, {2} missing" -f $okCount, $degCount, $missCount) -ForegroundColor Cyan
    if ($degCount -gt 0 -or $missCount -gt 0) {
        Write-Host "Run 'ultron alerts list --unacked' to see fallback messages." -ForegroundColor Gray
        exit 2
    }
}

function Invoke-SyncAll {
    # End-to-end refresh chain. Later steps do not abort on earlier failures
    # (informational, not gating).
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Write-Host ""
    Write-Host "ULTRON SYNC-ALL" -ForegroundColor Cyan
    Write-Host "===============" -ForegroundColor Cyan

    Write-Host ""; Write-Host "[1/6] skills registry auto-discover..." -ForegroundColor Yellow
    Invoke-Py "registry_sync.py" @("auto-discover")

    Write-Host ""; Write-Host "[2/6] manifest sync (cache rebuild + JSON Schema validate)..." -ForegroundColor Yellow
    Invoke-Py "skill_manifest.py" @("sync")

    Write-Host ""; Write-Host "[3/6] brain index incremental update..." -ForegroundColor Yellow
    Invoke-Py "brain_index.py" @("update")

    Write-Host ""; Write-Host "[4/6] MCP health probe (refresh mcp-health.json)..." -ForegroundColor Yellow
    Invoke-Py "mcp_health_check.py" @("--quiet")

    Write-Host ""; Write-Host "[5/6] deadwood scanner (refresh deadwood sidecar)..." -ForegroundColor Yellow
    $rcDw = Invoke-Py "deadwood_scanner.py" @("--json", "--report", "--quiet")
    if ($rcDw -gt 2) {
        # 2 = BLOCKING findings (expected during cleanup); higher = crash.
        Write-Host ("[5/6] WARN: deadwood scanner exited {0} - sidecar may be stale" -f $rcDw) -ForegroundColor DarkYellow
    }

    Write-Host ""; Write-Host "[6/6] doctor smoke check (--quiet, exit 0/1/2 by severity)..." -ForegroundColor Yellow
    $rcDoc = Invoke-Py "doctor.py" @("--quiet")

    $sw.Stop()
    $secs = $sw.ElapsedMilliseconds / 1000
    Write-Host ""
    if ($rcDoc -eq 0) {
        Write-Host ("[sync-all] DONE in {0:N1}s - doctor: clean" -f $secs) -ForegroundColor Green
    } elseif ($rcDoc -eq 1) {
        Write-Host ("[sync-all] DONE in {0:N1}s - doctor: warn findings (run 'ultron doctor')" -f $secs) -ForegroundColor Yellow
    } else {
        Write-Host ("[sync-all] DONE in {0:N1}s - doctor: BLOCKING findings (run 'ultron doctor')" -f $secs) -ForegroundColor Red
    }
}

function Invoke-Skills {
    if (-not $Rest -or $Rest.Count -eq 0) {
        Write-Host "Usage:" -ForegroundColor Yellow
        Write-Host "  ultron skills registry <status|propagate|register|process-pending|update-manifest>"
        Write-Host "  ultron skills vault <status|stats|list|search|restore|registry|merge-candidates|migrate>"
        Write-Host "  ultron skills manifest [list|sync|validate]"
        exit 1
    }
    $action = ([string]$Rest[0]).ToLower()
    $remaining = Get-Tail $Rest
    switch ($action) {
        "registry" { Invoke-Py "registry_sync.py" $remaining }
        "vault"    { Invoke-Py "skill_vault.py" $remaining }
        "manifest" {
            if ($remaining.Count -eq 0) {
                Invoke-Py "skill_manifest.py" @("list")
            } else {
                Invoke-Py "skill_manifest.py" $remaining
            }
        }
        default {
            Write-Host "Unknown skills action: $action" -ForegroundColor Red
            Write-Host "Try: ultron skills (no args for help)" -ForegroundColor Yellow
            exit 1
        }
    }
}

function Invoke-Skill {
    if (-not $Rest -or $Rest.Count -eq 0) {
        Write-Host "Usage:" -ForegroundColor Yellow
        Write-Host "  ultron skill register <name>       Index a newly-installed skill"
        Write-Host "  ultron skill register all          Re-scan + index all skills"
        Write-Host "  ultron skill list                  Show installed skills + index status"
        exit 1
    }
    $action = ([string]$Rest[0]).ToLower()
    $remArr = @(Get-Tail $Rest)
    $skillsDir = Join-Path $env:USERPROFILE ".claude\skills"

    if ($action -eq "register") {
        if ($remArr.Count -eq 0) {
            Write-Host "Provide a skill name or 'all'" -ForegroundColor Red
            exit 1
        }
        $first = [string]$remArr[0]
        # PowerShell sometimes strips leading dashes: accept 'all' and '--all'.
        if ($first -in @("all", "--all", "-all", "-")) {
            Write-Host "[skill] Re-scanning all skills under $skillsDir" -ForegroundColor Cyan
        } else {
            $skillMd = Join-Path $skillsDir "$first\SKILL.md"
            if (-not (Test-Path $skillMd)) {
                Write-Host "[skill] SKILL.md not found: $skillMd" -ForegroundColor Red
                exit 1
            }
            Write-Host "[skill] Found $first at $skillMd" -ForegroundColor Cyan
        }
        Write-Host "[skill] Running brain_index update (incremental)..." -ForegroundColor DarkGray
        Invoke-Py "brain_index.py" @("update")
    } elseif ($action -eq "list") {
        $localCount = (Get-ChildItem -Path $skillsDir -Directory -ErrorAction SilentlyContinue |
                        Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") }).Count
        Write-Host "Installed skills under $skillsDir : $localCount" -ForegroundColor Cyan
        Invoke-Py "brain_index.py" @("query", "*", "--layer", "L1-skills", "--top", "100")
    } else {
        Write-Host "Unknown skill action: $action" -ForegroundColor Red
        Write-Host "Try: ultron skill (no args for help)" -ForegroundColor Yellow
        exit 1
    }
}

function Invoke-Security {
    if (-not $Rest -or $Rest.Count -eq 0) {
        Write-Host "Usage:" -ForegroundColor Yellow
        Write-Host "  ultron security scan <path> [--source X] [--json]"
        Write-Host "  ultron security audit-all [--json]"
        Write-Host "  ultron security provenance <record|verify|audit> [args]"
        Write-Host "  ultron security settings-snapshot [--trigger manual|auto|sync]"
        Write-Host "  ultron security settings-diff [--json]"
        Write-Host "  ultron security settings-verify [--json]"
        Write-Host "  ultron security secrets [--paths P1 P2 ...] [--json]"
        Write-Host "  ultron security allowlist          (cat ~/.ultron/config/mcp-allowlist.yaml)"
        exit 1
    }
    $action = ([string]$Rest[0]).ToLower()
    $remaining = Get-Tail $Rest
    switch ($action) {
        "scan"              { Invoke-Py "skill_sync_security.py" (@("scan") + $remaining) }
        "audit-all"         { Invoke-Py "skill_sync_security.py" (@("audit-all") + $remaining) }
        "provenance"        { Invoke-Py "skill_provenance.py" $remaining }
        "settings-snapshot" { Invoke-Py "settings_integrity.py" (@("snapshot") + $remaining) }
        "settings-diff"     { Invoke-Py "settings_integrity.py" (@("diff") + $remaining) }
        "settings-verify"   { Invoke-Py "settings_integrity.py" (@("verify") + $remaining) }
        "secrets"           { Invoke-Py "secrets_scanner.py" (@("scan") + $remaining) }
        "allowlist" {
            $allow = Join-Path $env:USERPROFILE ".ultron/config/mcp-allowlist.yaml"
            if (Test-Path $allow) {
                Get-Content -LiteralPath $allow -Raw
            } else {
                Write-Host "(no mcp-allowlist.yaml found at $allow)" -ForegroundColor Yellow
                exit 1
            }
        }
        default {
            Write-Host "Unknown 'security' action: $action" -ForegroundColor Red
            Write-Host "Try: ultron security" -ForegroundColor Yellow
            exit 1
        }
    }
}

function Invoke-Schedule {
    if (-not $Rest -or $Rest.Count -eq 0) {
        Write-Host "Usage: ultron schedule <install|status|uninstall>" -ForegroundColor Yellow
        exit 1
    }
    switch (([string]$Rest[0]).ToLower()) {
        "install"   { Invoke-Ps "install-scheduler.ps1" @() }
        "status"    { Invoke-Ps "install-scheduler.ps1" @("-Status") }
        "uninstall" { Invoke-Ps "install-scheduler.ps1" @("-Uninstall") }
        default {
            Write-Host "Available: install | status | uninstall" -ForegroundColor Yellow
            exit 1
        }
    }
}

function Invoke-WithUsage([string]$script, [string]$usage) {
    # Forward $Rest to a Python script, or print usage when no args are given.
    if (-not $Rest -or $Rest.Count -eq 0) {
        Write-Host $usage -ForegroundColor Yellow
        exit 1
    }
    Invoke-Py $script $Rest
}

# ---- Dispatch ---------------------------------------------------------------

switch ($Command.ToLower()) {

    "help"      { Show-Help }
    "-h"        { Show-Help }
    "--help"    { Show-Help }

    "status"    { Show-Status }
    "alias"     { Show-Alias }

    "open"      { Invoke-WithUsage "launch_project.py" 'Usage: ultron open [project]' }
    "projects" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "launch_project.py" @("--list")
        } else {
            Invoke-Py "launch_project.py" $Rest
        }
    }
    "scan"      { Invoke-Py "scan_projects.py" $Rest }
    "project"   { Invoke-WithUsage "project_editor.py" 'Usage: ultron project <edit|add|delete|tag> ...' }

    "notes" {
        # ultron notes <id> <save|list|export|delete> [args]
        if (-not $Rest -or $Rest.Count -lt 2) {
            Write-Host 'Usage: ultron notes <id> <save|list|export|delete> [args]' -ForegroundColor Yellow
            exit 1
        }
        $remaining = Get-Tail $Rest
        $pyArgs = @($remaining[0]) + @($Rest[0]) + (Get-Tail $remaining)
        Invoke-Py "project_notes.py" $pyArgs
    }

    "claude"    { Start-CliSession "Claude" "claude" }
    "codex"     { Start-CliSession "Codex" "codex" }

    "app" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron app <name> [args]  (ultron apps list to see available)" -ForegroundColor Yellow
            exit 1
        }
        Invoke-Py "apps_launcher.py" (@("launch") + $Rest)
    }
    "apps" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "apps_launcher.py" @("list")
        } else {
            Invoke-Py "apps_launcher.py" $Rest
        }
    }

    "skills"       { Invoke-Skills }
    "skill"        { Invoke-Skill }
    "skills-embed" { Invoke-WithUsage "embed_skills.py" 'Usage: ultron skills-embed <init|index|query|status> [args]' }
    "manifest" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "skill_manifest.py" @("list")
        } else {
            Invoke-Py "skill_manifest.py" $Rest
        }
    }
    "sync" {
        Write-Host "[sync] Running skills registry auto-discover..." -ForegroundColor Cyan
        Invoke-Py "registry_sync.py" @("auto-discover")
        Write-Host "[sync] Running manifest sync (cache rebuild)..." -ForegroundColor Cyan
        Invoke-Py "skill_manifest.py" @("sync")
        Write-Host "[sync] Done." -ForegroundColor Green
    }
    "sync-all"  { Invoke-SyncAll }

    "health"    { Invoke-Py "health.py" $Rest }
    "doctor"    { Invoke-Py "doctor.py" $Rest }
    "deadwood"  { Invoke-Py "deadwood_scanner.py" $Rest }
    "mcp" {
        if ($Rest -and $Rest.Count -gt 0 -and ([string]$Rest[0]).ToLower() -eq "health") {
            Invoke-McpHealth
        } else {
            Write-Host "Usage: ultron mcp health   (manage MCPs with 'claude mcp' or the Control Center)" -ForegroundColor Yellow
            exit 1
        }
    }
    "alerts"    { Invoke-WithUsage "alerts.py" 'Usage: ultron alerts <list|read-unacked|ack|purge|write> [args]' }
    "security"  { Invoke-Security }
    "brain"     { Invoke-WithUsage "brain_index.py" 'Usage: ultron brain <build|update|query|stats|inspect> [args]' }
    "index"     { Invoke-WithUsage "brain_index.py" 'Usage: ultron index <build|update|query|stats> [args]' }
    "config"    { Invoke-WithUsage "brain_config.py" 'Usage: ultron config <show|get|set|reset|path> [args]' }
    "schedule"  { Invoke-Schedule }

    default {
        Write-Host "Unknown command: $Command" -ForegroundColor Red
        Write-Host "Try: ultron help" -ForegroundColor Yellow
        exit 1
    }
}
