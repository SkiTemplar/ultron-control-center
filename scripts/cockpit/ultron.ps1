# ULTRON v15.1.0 "CONTROL CENTER" CORE - Central command
# Single entry point for the cockpit. Subcommands:
#   ultron tui                     - launch TUI cockpit (default)
#   ultron status                  - text dashboard
#   ultron open <project>          - launch project in IDE
#   ultron projects                - project browser
#   ultron scan                    - discover projects
#   ultron news [new]              - today's digest / generate newsletter
#   ultron health                  - system health check
#   ultron doctor                  - full doctor diagnostics
#   ultron memory <status|sync>    - vault sync
#   ultron brain query <q>         - FTS5 search
#   ultron mcp <list|install|...>  - MCP server management
#   ultron schedule <install|status|uninstall>
#   ultron skills <manifest|...>   - skill registry
#   ultron security <scan|...>     - security audit
#   ultron help [<command>]

param(
    [Parameter(Position=0)]
    [string]$Command = "tui",

    [Parameter(Position=1, ValueFromRemainingArguments=$true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"

$CockpitDir = $PSScriptRoot
# v12 BRAIN: prefer 'uv run python' (CLAUDE.md global rule), fallback to plain
# 'python' if uv is not on PATH. Detected once per session start.
$UseUv = [bool] (Get-Command uv -ErrorAction SilentlyContinue)

function Invoke-Py([string]$script, [string[]]$arglist) {
    # Codex S4 M2 fix: typed [string[]] $arglist forces PS5.1 to coerce
    # whatever caller passes (single string, scalar, single-element array)
    # into a proper String[]. We pass it unsplatted to native exes so each
    # element becomes one argv slot — PS5.1 handles array→argv expansion
    # natively when calling external commands.
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
    # arglist (e.g. @("-Status")) survives the `if` pipeline as Object[],
    # not as a scalar that @splatting would expand char-by-char.
    $scriptPath = Join-Path $CockpitDir $script
    $safeArgs = @(if ($arglist) { $arglist } else { @() })
    & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath @safeArgs
    return $LASTEXITCODE
}

function Show-Help {
    Write-Host ""
    Write-Host "ULTRON CORE - Central command" -ForegroundColor Cyan
    Write-Host "============================="
    Write-Host ""
    Write-Host "USAGE:" -ForegroundColor Yellow
    Write-Host '  ultron [command] [args]'
    Write-Host ""
    Write-Host "COMMANDS:" -ForegroundColor Yellow
    Write-Host "  status                   Dashboard - projects, vault, telemetry, alerts"
    Write-Host '  open [project]           Launch project in its IDE (writes .claude/context.md)'
    Write-Host '  projects [--list|--search [q]]'
    Write-Host "                           Browse registry"
    Write-Host "  scan [--verbose|--dry-run]"
    Write-Host "                           Re-scan filesystem for projects"
    Write-Host '  mcp [action] ...         MCP installer: list|catalog|install|uninstall|validate|wrap|unwrap'
    Write-Host '  notes [id] [save|list|export]'
    Write-Host "                           Per-project persistent notes (warm-start context)"
    Write-Host "  schedule <action>        Task Scheduler: install|status|uninstall"
    Write-Host "  desktop [install|uninstall]"
    Write-Host "                           Create/remove ULTRON CORE shortcut on Desktop"
    Write-Host "  track [snapshot|summary] Activity tracker"
    Write-Host "  retention [--dry-run]    Run rotation/cleanup policy"
    Write-Host "  news [new|create]        Show today's digest, or launch HTML generator (Gemini)"
    Write-Host "  news purge-alerts        Move stale alerts (>7d) to ALERTS.archive.md"
    Write-Host "  news clear-alerts        Archive everything then wipe ALERTS.md"
    Write-Host "  news alerts-status       Show active/stale/undated counts"
    Write-Host "  alerts <list|ack|...>    Persistent alerts bus (v13.4 Sprint 1)"
    Write-Host "  dashboard [--print]      Generate (or show) DASHBOARD.md"
    Write-Host "  standup [--print|--gemini]"
    Write-Host "                           Generate (or show) today's standup"
    Write-Host "  newsletter               (legacy alias) -> news_html_generator.py on-demand"
    Write-Host '  calendar [--sample|--print|--events [file]|--stdin]'
    Write-Host "                           Match Calendar events to projects -> deadlines.json"
    Write-Host ""
    Write-Host "  Sessions & quick-ask (v11.1):" -ForegroundColor Green
    Write-Host "  ask <pregunta>           Quick-ask via Haiku + mini-memoria (no comillas)"
    Write-Host "  claude [args]            Spawn interactive Claude session in cwd (new tab)"
    Write-Host "  gemini [args]            Spawn interactive Gemini session in cwd"
    Write-Host "  codex  [args]            Spawn interactive Codex session in cwd"
    Write-Host ""
    Write-Host "  Apps & usage (v11.1):" -ForegroundColor Green
    Write-Host "  app <name> [args]        Launch GUI app (claude-desktop, chatgpt, spotify, ...)"
    Write-Host "  apps [list|discover|add|remove]"
    Write-Host "                           Manage GUI app registry"
    Write-Host "  inventory [--filter X] [--json] [--md PATH] [--source <all|registry|winget>]"
    Write-Host "                           List ALL installed Windows apps (registry + winget)"
    Write-Host "  verify [--json] [--doc PATH] [--strict]"
    Write-Host "                           Run [verify: cmd] [expect: regex] claims in critical docs"
    Write-Host "  audit list               List personas/skills available for audit"
    Write-Host "  audit run <persona> [--quick]"
    Write-Host "                           repo-evaluator independent audit (Opus full / Sonnet quick)"
    Write-Host ""
    Write-Host "  AI editing & autoupdater (v11.1):" -ForegroundColor Green
    Write-Host "  project edit <id> <q>    AI edit project (Haiku/Sonnet via env, dry-run)"
    Write-Host "  project add|delete|tag   project_editor.py wrappers"
    Write-Host "  skill create             Q&A interactive skill scaffold (Sonnet)"
    Write-Host "  skills export <s>        SKILL.md -> AGENTS.md (Codex) + GEMINI.md"
    Write-Host "  skills manifest          Unified registry: who installed what"
    Write-Host "  skills manifest rebuild  Rebuild manifest from disk (detect Gemini/Codex installs)"
    Write-Host "  skills manifest sync-prompt  Clipboard prompt -> Claude identifies untracked skills"
    Write-Host "  skills discover <cmd>    Buscar/cachear/instalar skills de GitHub" -ForegroundColor Cyan
    Write-Host "  mcp scaffold <idea>      Sonnet MCP server scaffold"
    Write-Host "  self-improve scan        L1 AutoUpdater: rank audit candidates"
    Write-Host "  self-improve audit <s> [--quick]"
    Write-Host "                           L1: trigger repo-evaluator (Sonnet quick / Opus full)"
    Write-Host "  self-improve propose <audit>"
    Write-Host "                           L2: Sonnet patches (NO apply, FP filter)"
    Write-Host "  self-improve apply <proposals>"
    Write-Host "                           L3: spawn Claude review session (human-gated)"
    Write-Host "  health                   System health check (all deps + scripts + configs)"
    Write-Host "  jobs <submit|list|status|logs|cancel|clean>"
    Write-Host "                           Background job supervisor (persistent state + logs)"
    Write-Host ""
    Write-Host "  System health (S5):" -ForegroundColor Green
    Write-Host "  doctor                   Inspect installation: drift, staleness, retention, tokens"
    Write-Host "  doctor --fix             Interactive per-finding y/N prompts"
    Write-Host "  doctor --json            Machine-readable JSON report"
    Write-Host "  doctor --health-check    Compact MCP + ZTMSI + L0 view"
    Write-Host "  doctor --token-audit     E1 gate: always-on token overhead"
    Write-Host "  deadwood [--json|--report|--quiet|--roots P]"
    Write-Host "                           Deadwood scanner v14.1 — sentinel + heuristic + xref"
    Write-Host "  mcp health               Probe all MCP servers, write mcp-health.json"
    Write-Host ""
    Write-Host "  Memory v12.2 (Brain Update):" -ForegroundColor Green
    Write-Host "  memory <status|sync|push|mode>"
    Write-Host "                           L2 vault sync (~/.ultron-vault/, Obsidian + git)"
    Write-Host "  memory bridge [ingest|repair [--fix]]"
    Write-Host "                           CC project memories <-> vault sync + wikilink repair"
    Write-Host ""
    Write-Host "  Gaming pause (v11.1):" -ForegroundColor Green
    Write-Host "  pause [hours]            Pause all crons (default 4h, RAM-saving)"
    Write-Host "  resume                   Clear pause marker"
    Write-Host "  games <list|add|remove|reset>"
    Write-Host "                           Manage game-process detection list"
    Write-Host ""
    Write-Host "  alias                    Print PowerShell profile alias to copy"
    Write-Host "  help [<command>]         This message"
    Write-Host ""
    Write-Host "EXAMPLES:" -ForegroundColor Yellow
    Write-Host "  ultron status"
    Write-Host "  ultron ask que es Mythos"
    Write-Host "  ultron open tortunabo"
    Write-Host "  ultron claude               # (otra ventana, sesion interactiva)"
    Write-Host "  ultron pause 2              # 2h sin que corran crons"
    Write-Host "  ultron schedule install"
    Write-Host ""
}

function Show-Status {
    Write-Host ""
    Write-Host "ULTRON CORE Status" -ForegroundColor Cyan
    Write-Host "=================="
    Write-Host ""

    $cockpitHome = Join-Path $env:USERPROFILE ".ultron\cockpit"
    $projectsJson = Join-Path $cockpitHome "projects.json"
    $alertsMd = Join-Path $cockpitHome "news\ALERTS.md"

    # Projects summary
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

        # Top 5 by last_active (active or auto-detected only)
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

    # Auth vault and Usage blocks were removed in v12.5 (cockpit reorg dropped
    # auth_vault.py / usage_tracker.py / usage_limits.py / schedule_editor.py /
    # auth_wizard.py / auth-vault.ps1). Use claude /usage natively for window
    # stats; for credentials use OS keychain or env vars directly.

    # Alerts
    Write-Host "[Alerts]" -ForegroundColor Green
    if (Test-Path $alertsMd) {
        $alertsContent = Get-Content -Raw $alertsMd
        if (-not [string]::IsNullOrWhiteSpace($alertsContent)) {
            Write-Host "  ALERTS pending - read: $alertsMd" -ForegroundColor Red
        } else {
            Write-Host "  No alerts"
        }
    } else {
        Write-Host "  No news scraper output yet (4.L pending)"
    }

    Write-Host ""

    Write-Host "[Usage]" -ForegroundColor Green
    Write-Host "  claude /usage  (native interactive command)"
    Write-Host ""

    # Scheduler
    Write-Host "[Scheduler]" -ForegroundColor Green
    $schedulerScript = Join-Path $CockpitDir "install-scheduler.ps1"
    if (Test-Path $schedulerScript) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $schedulerScript -Status 2>&1 |
            Select-Object -First 6 |
            ForEach-Object { Write-Host "  $_" }
    }
    Write-Host ""
}

function Show-News {
    $newsDir = Join-Path $env:USERPROFILE ".ultron\cockpit\news"
    if (-not (Test-Path $newsDir)) {
        Write-Host "[News] Not enabled yet"
        return
    }

    $alerts = Join-Path $newsDir "ALERTS.md"
    if ((Test-Path $alerts) -and ((Get-Item $alerts).Length -gt 0)) {
        Write-Host "[ALERTS]" -ForegroundColor Red
        Get-Content $alerts
        Write-Host ""
    }

    $today = Get-Date -Format "yyyy-MM-dd"
    # Try new newsletter format first, then legacy md digest
    $digest = Join-Path $newsDir "newsletter-$today.html"
    if (-not (Test-Path $digest)) { $digest = Join-Path $newsDir "$today.md" }
    if (Test-Path $digest) {
        Write-Host "[Digest $today]" -ForegroundColor Cyan
        Write-Host "  $digest" -ForegroundColor DarkGray
        # For HTML newsletters show a note; md digests can be cat'd directly
        if ($digest.EndsWith(".html")) {
            Write-Host "  (HTML newsletter — open in browser or run: ultron news open)" -ForegroundColor DarkGray
        } else {
            Get-Content $digest
        }
    } else {
        Write-Host "[News] No digest for $today — generate with: ultron tui (key 2)" -ForegroundColor DarkGray
    }
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

# ---- Dispatch ---------------------------------------------------------------

switch ($Command.ToLower()) {

    "help"      { Show-Help }
    "-h"        { Show-Help }
    "--help"    { Show-Help }

    "status"    { Show-Status }
    "alias"     { Show-Alias }

    "news" {
        # v14.2 Tech/AI focus edition.
        # `ultron news`               -> show today's digest (read-only)
        # `ultron news new`           -> launch Gemini HTML generator
        # `ultron news purge-alerts`  -> move stale alerts (>7d) to archive
        # `ultron news clear-alerts`  -> archive everything then wipe ALERTS.md
        # `ultron news alerts-status` -> active/stale/undated counts
        if ($Rest -and $Rest.Count -gt 0) {
            switch (([string]$Rest[0]).ToLower()) {
                { $_ -eq "new" -or $_ -eq "create" } {
                    Invoke-Py "news_html_generator.py" @($Rest | Select-Object -Skip 1)
                    break
                }
                "purge-alerts" {
                    $extra = @($Rest | Select-Object -Skip 1)
                    Invoke-Py "news_alerts.py" (@("purge") + $extra)
                    break
                }
                "clear-alerts" {
                    Invoke-Py "news_alerts.py" @("archive")
                    break
                }
                "alerts-status" {
                    Invoke-Py "news_alerts.py" @("status")
                    break
                }
                default {
                    Show-News
                }
            }
        } else {
            Show-News
        }
    }

    "open" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host 'Usage: ultron open [project]' -ForegroundColor Yellow
            exit 1
        }
        Invoke-Py "launch_project.py" $Rest
    }

    "projects" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "launch_project.py" @("--list")
        } else {
            Invoke-Py "launch_project.py" $Rest
        }
    }

    "scan"      { Invoke-Py "scan_projects.py" $Rest }
    "retention" { Invoke-Py "retention.py" $Rest }

    "osint" {
        # Auditoría de huella digital propia (Sherlock vía uvx — nada permanente).
        # ultron osint scan <username> [--all]   ·   ultron osint last
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron osint scan <username> [--all]   Sherlock — ~400 sitios por username"
            Write-Host "  ultron osint email <email>             holehe   — ~120 sitios donde ese email está registrado"
            Write-Host "  ultron osint diff [username]           cuentas nuevas/desaparecidas entre los 2 últimos escaneos"
            Write-Host "  ultron osint last                      último escaneo"
            Write-Host "  (ambas gratis vía uvx, sin API key, sin tokens. Resultados en ~/.ultron/.tmp/osint/)" -ForegroundColor Gray
            exit 1
        }
        Invoke-Py "osint_footprint.py" $Rest
    }

    "standup" {
        if ($Rest -and $Rest -contains "--print") {
            Invoke-Py "ai_standup.py" @("--print")
        } else {
            Invoke-Py "ai_standup.py" $Rest
        }
    }

    "newsletter" {
        # v12: legacy weekly stub deprecated. Redirects to on-demand HTML generator.
        Invoke-Py "news_html_generator.py" $Rest
    }

    "research" {
        Invoke-Py "research.py" $Rest
    }

    "plans" {
        # Sistema unificado de planes (v14.9.1)
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Plans — single source of truth para pendientes" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron plans list [--status open|all] [--kind sprint|bug|polish|...]"
            Write-Host "  ultron plans show <id>"
            Write-Host "  ultron plans add `"<title>`" --kind sprint [--priority p0|p1|p2]"
            Write-Host "                              [--effort N-M] [--tags a,b] [--spec path]"
            Write-Host "  ultron plans done <id> [--note `"...`"]"
            Write-Host "  ultron plans defer <id> [--reason `"...`"]"
            Write-Host "  ultron plans reopen <id>"
            Write-Host "  ultron plans clean [--older-than 30] [--dry-run]"
            Write-Host "  ultron plans render          # regenera MASTER-pendientes.md"
            Write-Host "  ultron plans status          # totales por status / kind"
            Write-Host ""
            Write-Host "Single source: ~/.ultron/plans/PLANS.json" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "plans_cli.py" $Rest
    }

    "gemini" {
        # Wrapper limpio sobre el CLI gemini (OAuth, cuota generosa).
        # ultron gemini "<prompt>"            inline
        # ultron gemini --file <path>          desde archivo
        # ultron gemini --model <id> "<...>"   forzar modelo
        # ultron gemini --json "<...>"          output estructurado
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Gemini CLI wrapper (OAuth, no rate-limit issues)" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host '  ultron gemini "<prompt>"'
            Write-Host "  ultron gemini --file <path>"
            Write-Host "  ultron gemini --model gemini-3.1-pro-preview `"<prompt>`""
            Write-Host "  ultron gemini --json `"<prompt>`""
            exit 1
        }
        Invoke-Py "gemini_cli.py" $Rest
    }

    "tui" {
        # v15.4: tui.py removed. Control Center (Tauri GUI) is the cockpit.
        Write-Host "ULTRON TUI was removed in v15.4." -ForegroundColor Yellow
        Write-Host "Use the Control Center instead:" -ForegroundColor Cyan
        Write-Host "  cd ~/.ultron/control-center && npm run tauri dev"
        Write-Host "  (or launch the installed app from Start Menu)"
        exit 1
    }

    "calendar" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron calendar <--sample|--print|--events <file>|--stdin>" -ForegroundColor Yellow
            exit 1
        }
        Invoke-Py "calendar_match.py" $Rest
    }

    "schedule" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron schedule <install|status|uninstall>" -ForegroundColor Yellow
            exit 1
        }
        $action = ([string]$Rest[0]).ToLower()
        $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
        switch ($action) {
            "install"   { Invoke-Ps "install-scheduler.ps1" @() }
            "status"    { Invoke-Ps "install-scheduler.ps1" @("-Status") }
            "uninstall" { Invoke-Ps "install-scheduler.ps1" @("-Uninstall") }
            # list/enable/disable/edit/chat removed in v12.5 - schedule_editor.py
            # was dropped in cockpit reorg. Edit ~/.ultron/cockpit/schedule.json
            # directly or use Windows Task Scheduler GUI.
            default {
                Write-Host "Unknown schedule action: $action" -ForegroundColor Red
                Write-Host "Available: install | status | uninstall" -ForegroundColor Yellow
                Write-Host "(list/edit/chat were removed in v12.5 - edit schedule.json directly)" -ForegroundColor Gray
                exit 1
            }
        }
    }

    "manifest" {
        # S4: ultron manifest <list|sync|validate|add|deprecate> [args]
        # Codex S4 M2 fix: now uses Invoke-Py uniformly. The wrapper has been
        # typed [string[]] to preserve single-element arrays (was the original
        # PS5.1 unwrap bug that motivated direct-dispatch in S4 v1).
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "skill_manifest.py" @("list")
        } else {
            Invoke-Py "skill_manifest.py" $Rest
        }
    }

    "doctor" {
        # S5-B: ultron doctor [--fix|--dry-run|--json|--health-check|--token-audit|--quiet]
        # Pure-stdlib system inspector: orphans, skill drift, hook breakage,
        # staleness, retention, alerts, MCP health, token overhead.
        # Default mode: read-only report. --fix prompts y/N per finding.
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "doctor.py" @()
        } else {
            Invoke-Py "doctor.py" $Rest
        }
    }

    "recall" {
        # v14.6 PERFECT MEMORY: hybrid retrieval over the vault.
        # F6 (pre-v15): default to --format=human for interactive readability.
        # F7: 'recall stats' surfaces hit-rate/latency/source aggregates.
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron recall <text> [--top N] [--mode hybrid|fts|vector] [--format human|json]"
            Write-Host "       ultron recall status                   # backend health"
            Write-Host "       ultron recall stats [--days N]         # telemetry aggregate"
            return
        }
        if ($Rest[0] -eq "status") {
            Invoke-Py "hybrid_retriever.py" @("status")
        } elseif ($Rest[0] -eq "stats") {
            $forwarded = @("stats") + ($Rest | Select-Object -Skip 1)
            Invoke-Py "hybrid_retriever.py" $forwarded
        } else {
            $forwarded = @("query") + $Rest
            if (-not ($Rest -match '^--format')) {
                $forwarded = $forwarded + @("--format", "human")
            }
            Invoke-Py "hybrid_retriever.py" $forwarded
        }
    }

    "embed" {
        # v14.6 PERFECT MEMORY: vault embedding pipeline.
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron embed <init|index|query|status> [args...]"
            Write-Host "  init               - create Qdrant collection"
            Write-Host "  index [--full]     - incremental index (or full rebuild)"
            Write-Host "  query <text> [--top N]"
            Write-Host "  status             - collection + state info"
            return
        }
        Invoke-Py "embed_vault.py" $Rest
    }

    "skills-embed" {
        # v14.8 P3 — semantic skill catalog (separate from vault).
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron skills-embed <init|index|query|status> [args...]"
            Write-Host "  init               - create ultron_skills Qdrant collection"
            Write-Host "  index [--full]     - sync 380+ skill descriptions"
            Write-Host "  query <text>       - find skills semantically matching text"
            Write-Host "  status             - collection + state"
            return
        }
        Invoke-Py "embed_skills.py" $Rest
    }

    "prompts" {
        # v14.5 META-PROMPTER: dispatch to prompt_improver / prompt_registry / prompt_eval.
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron prompts <improve|eval|registry|feedback> ..."
            Write-Host "  improve preview <path>             - render meta-prompt for improvement"
            Write-Host "  improve diff <a> <b>               - unified diff between two prompt files"
            Write-Host "  improve status                     - improver/feedback log counts"
            Write-Host "  improve feedback --kind ... --target ..."
            Write-Host "  registry init <path> [--name X]    - add versioning frontmatter"
            Write-Host "  registry list                      - all registered prompts"
            Write-Host "  registry version <name>            - iteration history"
            Write-Host "  registry diff <name> --from N --to M"
            Write-Host "  registry bump <path> [--from-file <new>] [--rationale ...]"
            Write-Host "  eval preview <prompt> <output>     - render judge meta-prompt"
            Write-Host "  eval parse <response_file>         - parse a judge reply"
            Write-Host "  eval cache-stats                   - cache size"
            return
        }
        $sub = ([string]$Rest[0]).ToLower()
        $tail = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count - 1)] } else { @() })
        switch ($sub) {
            "improve"  { Invoke-Py "prompt_improver.py" $tail; break }
            "registry" { Invoke-Py "prompt_registry.py" $tail; break }
            "eval"     { Invoke-Py "prompt_eval.py"     $tail; break }
            "feedback" {
                # Shorthand for prompt_improver.py feedback ...
                $fwd = @("feedback") + $tail
                Invoke-Py "prompt_improver.py" $fwd
                break
            }
            default {
                Write-Host "Unknown prompts sub-command: $sub" -ForegroundColor Red
                Write-Host "Run 'ultron prompts' (no args) for usage."
            }
        }
    }

    "backlog" {
        # v14.9: ULTRON Roadmap System — backlog + decisions log.
        # Spec: ~/.ultron/roadmap/README.md
        Invoke-Py "backlog.py" $Rest
    }

    "decision" {
        # Alias: ultron decision <list|show|add> -> backlog.py decision-<sub>
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron decision <list|show|add> ..."
            Write-Host "  list [--recent] [--affects U-XXX]"
            Write-Host "  show <D-XXX>"
            Write-Host "  add <title> --chosen <X> [--alt 'opt|why'] [--why <rationale>] [--affects U-001,U-002]"
            return
        }
        $sub = ([string]$Rest[0]).ToLower()
        $tail = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count - 1)] } else { @() })
        $forwarded = @("decision-$sub") + $tail
        Invoke-Py "backlog.py" $forwarded
    }

    "sync" {
        # S4: ultron sync — runs the full skills registry sync chain:
        #   1) registry_sync.py auto-discover  (scan SKILL.md frontmatter)
        #   2) skill_manifest.py sync          (wellknown + cache rebuild)
        # Fast (~5s). For the full system refresh see `ultron sync-all`.
        Write-Host "[sync] Running skills registry auto-discover..." -ForegroundColor Cyan
        Invoke-Py "registry_sync.py" @("auto-discover")
        Write-Host "[sync] Running manifest sync (wellknown + cache rebuild)..." -ForegroundColor Cyan
        Invoke-Py "skill_manifest.py" @("sync")
        Write-Host "[sync] Done." -ForegroundColor Green
    }

    "sync-all" {
        # v14 GENESIS: end-to-end refresh chain. Runs every sync step in
        # the canonical order so 'todo en mil sitios' becomes one command.
        # Ordered: skills first (cheap), then memory, then health, then
        # smoke-doctor. Each step prints its own header; failures in
        # later steps do not abort the chain (informational, not gating).
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Write-Host ""
        Write-Host "ULTRON SYNC-ALL  v14 GENESIS" -ForegroundColor Cyan
        Write-Host "============================" -ForegroundColor Cyan

        Write-Host ""; Write-Host "[1/8] skills registry auto-discover..." -ForegroundColor Yellow
        Invoke-Py "registry_sync.py" @("auto-discover")

        Write-Host ""; Write-Host "[2/8] manifest sync (cache rebuild + JSON Schema validate)..." -ForegroundColor Yellow
        Invoke-Py "skill_manifest.py" @("sync")

        Write-Host ""; Write-Host "[3/8] frontmatter backfill (idempotent, vault notes)..." -ForegroundColor Yellow
        Invoke-Py "frontmatter_backfill.py" @("apply")

        Write-Host ""; Write-Host "[4/8] brain index incremental update..." -ForegroundColor Yellow
        Invoke-Py "brain_index.py" @("update")

        Write-Host ""; Write-Host "[5/8] vault git sync (commit + push, HIGH+ semantics)..." -ForegroundColor Yellow
        Invoke-Py "memory_sync.py" @("push")

        Write-Host ""; Write-Host "[6/8] MCP health probe (refresh mcp-health.json)..." -ForegroundColor Yellow
        Invoke-Py "mcp_health_check.py" @("--quiet")

        Write-Host ""; Write-Host "[7/8] deadwood scanner (refresh deadwood.json sidecar)..." -ForegroundColor Yellow
        $rc_dw = Invoke-Py "deadwood_scanner.py" @("--json", "--report", "--quiet")
        if ($rc_dw -ge 2) {
            # Severity 2 from the scanner just means BLOCKING findings
            # (expected during cleanup). Anything higher = crash / OSError —
            # warn so the next step (doctor) doesn't silently consume
            # a stale sidecar.
            Write-Host ("[7/8] WARN: deadwood scanner exited {0} — sidecar may be stale" -f $rc_dw) -ForegroundColor DarkYellow
        }

        Write-Host ""; Write-Host "[8/8] doctor smoke check (--quiet, exit 0/1/2 by severity)..." -ForegroundColor Yellow
        $rc_doc = Invoke-Py "doctor.py" @("--quiet")

        $sw.Stop()
        Write-Host ""
        if ($rc_doc -eq 0) {
            Write-Host ("[sync-all] DONE in {0:N1}s · doctor: clean" -f ($sw.ElapsedMilliseconds / 1000)) -ForegroundColor Green
        } elseif ($rc_doc -eq 1) {
            Write-Host ("[sync-all] DONE in {0:N1}s · doctor: warn findings (run 'ultron doctor' for detail)" -f ($sw.ElapsedMilliseconds / 1000)) -ForegroundColor Yellow
        } else {
            Write-Host ("[sync-all] DONE in {0:N1}s · doctor: BLOCKING findings (run 'ultron doctor')" -f ($sw.ElapsedMilliseconds / 1000)) -ForegroundColor Red
        }
    }

    "mcp" {
        # ultron mcp <action> [args]  -> mcp_installer.py or mcp_creator.py or mcp_health_check.py
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron mcp <list|catalog|install|uninstall|validate> [args]"
            Write-Host "  ultron mcp wrap <id>     Route MCP through zero-trust broker"
            Write-Host "  ultron mcp unwrap <id>   Restore direct connection"
            Write-Host "  ultron mcp scaffold <idea...> [--lang python|ts] [--apply]   (Sonnet, dry-run)"
            Write-Host "  ultron mcp health        Probe all MCPs and pretty-print status"
            exit 1
        }
        $action = ([string]$Rest[0]).ToLower()
        if ($action -eq "scaffold") {
            $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
            Invoke-Py "mcp_creator.py" (@("scaffold") + $remaining)
        } elseif ($action -eq "health") {
            # S5 Sub-pilar A: live probe of all MCPs in settings.json. Pretty-prints
            # the JSON output from mcp_health_check.py --json. Useful for "is the
            # gemini MCP up?" without sifting through alerts.
            # NOTE: ASCII-only strings here -- ultron.ps1 has no UTF-8 BOM so PS5.1
            # parses it as cp1252; non-ASCII (em-dash etc.) breaks the parser.
            Write-Host "[mcp health] Probing MCP servers (max ~7s)..." -ForegroundColor Cyan
            $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
            $rawOutput = if ($UseUv) {
                & uv run python (Join-Path $CockpitDir "mcp_health_check.py") "--json" $remaining
            } else {
                & python (Join-Path $CockpitDir "mcp_health_check.py") "--json" $remaining
            }
            $rawJoined = ($rawOutput -join "`n").Trim()
            if (-not $rawJoined) {
                Write-Host "[mcp health] (no output - health check produced nothing)" -ForegroundColor Yellow
                exit 1
            }
            try {
                $parsed = $rawJoined | ConvertFrom-Json
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
            } catch {
                # Fallback: raw JSON if parsing failed for any reason.
                Write-Host $rawJoined
            }
        } else {
            Invoke-Py "mcp_installer.py" $Rest
        }
    }

    "multimodel" {
        # S2-C MMFP: list/show/process/archive async peer-review requests
        # ultron multimodel list [--all]
        # ultron multimodel show <id>
        # ultron multimodel process <id>
        # ultron multimodel archive [--older-than Nd]
        # ultron multimodel clean [--dry-run]
        Invoke-Py "multimodel.py" $Rest
    }

    "notes" {
        # ultron notes <id> [save "text"|list|export]
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron notes <id> save <text...>    Append timestamped note"
            Write-Host "  ultron notes <id> list [--n N]      Show last N notes (default 10)"
            Write-Host "  ultron notes <id> export [--n N]    Markdown block for context.md"
            Write-Host "  ultron notes <id> delete <n>        Delete note by index (1=oldest, -1=newest)"
            exit 1
        }
        $projectId = $Rest[0]
        $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
        $pyArgs = @($remaining[0]) + @($projectId) + $(if ($remaining.Count -gt 1) { @(@($remaining[1..($remaining.Count-1)])) } else { @() })
        Invoke-Py "project_notes.py" $pyArgs
    }

    # @ULTRON-DEPRECATED:14.0.0
    #   reason: auth_vault.py / auth_wizard.py / auth-vault.ps1 dropped in v12.5 cockpit reorg
    #   replaced-by: Windows Credential Manager (cmdkey) or environment variables
    #   remove-after: 2026-11-07
    #   owner: <your-username>
    "auth" {
        Write-Host "ultron auth: removed in v12.5" -ForegroundColor Yellow
        Write-Host "  Use Windows Credential Manager or env vars for credentials." -ForegroundColor Gray
        Write-Host "  cmdkey /list                            # list stored creds"
        Write-Host "  cmdkey /add:<target> /user:<u> /pass:<p>"
        exit 1
    }
    # @ULTRON-DEPRECATED-END

    "desktop" {
        # v15.4.7 — `ultron desktop` retired in v15.4. The Control Center
        # is launched via its own Start Menu / NSIS shortcut (or the dev
        # `npm run tauri dev`). The old desktop-shortcut.ps1 was removed
        # along with the TUI cleanup; this subcommand stayed orphan and
        # crashed with "script not found".
        Write-Host "[ULTRON] 'ultron desktop' was removed in v15.4 — TUI lifecycle is gone." -ForegroundColor Yellow
        Write-Host "         Launch the Control Center directly:" -ForegroundColor Yellow
        Write-Host "           Start Menu → ULTRON Control Center" -ForegroundColor White
        Write-Host "           or:  cd ~/.ultron/control-center && npm run tauri dev" -ForegroundColor White
        exit 1
    }

    "pause" {
        # ultron pause [hours]  - pause all crons (RAM-saving for gaming)
        $args = @("pause")
        if ($Rest -and $Rest.Count -gt 0) { $args += $Rest[0] }
        Invoke-Py "should_run.py" $args
    }

    "resume" {
        Invoke-Py "should_run.py" @("resume")
    }

    "runstate" {
        # Show pause + gaming detection state. Exit 2 if cron jobs would be skipped.
        # Renamed from "status" - was unreachable due to duplicate switch case at line 307.
        Invoke-Py "should_run.py" @("status")
    }

    "games" {
        # ultron games [list|add <proc>|remove <proc>|reset]
        $args = @("games")
        if ($Rest -and $Rest.Count -gt 0) { $args += $Rest }
        Invoke-Py "should_run.py" $args
    }

    "claude" {
        # Spawn interactive Claude session in current cwd. Uses Windows Terminal
        # if available, otherwise PowerShell window. Pass-through args go to claude.
        $cwd = Get-Location
        if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
            $wtArgs = @("new-tab", "--title", "Claude", "-d", $cwd.Path, "claude", "--dangerously-skip-permissions")
            if ($Rest) { $wtArgs += $Rest }
            Start-Process wt.exe -ArgumentList $wtArgs
            Write-Host "[claude] Spawned new tab in Windows Terminal (cwd=$cwd)" -ForegroundColor Green
        } else {
            $cmdLine = "claude --dangerously-skip-permissions"
            if ($Rest) { $cmdLine += " " + ($Rest -join " ") }
            Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmdLine -WorkingDirectory $cwd
            Write-Host "[claude] Spawned PowerShell window (cwd=$cwd)" -ForegroundColor Green
        }
    }

    "gemini" {
        # Spawn interactive Gemini session in current cwd.
        $cwd = Get-Location
        if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
            $wtArgs = @("new-tab", "--title", "Gemini", "-d", $cwd.Path, "gemini")
            if ($Rest) { $wtArgs += $Rest }
            Start-Process wt.exe -ArgumentList $wtArgs
            Write-Host "[gemini] Spawned new tab in Windows Terminal (cwd=$cwd)" -ForegroundColor Green
        } else {
            $cmdLine = "gemini"
            if ($Rest) { $cmdLine += " " + ($Rest -join " ") }
            Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmdLine -WorkingDirectory $cwd
            Write-Host "[gemini] Spawned PowerShell window (cwd=$cwd)" -ForegroundColor Green
        }
    }

    "codex" {
        # Spawn interactive Codex session in current cwd.
        $cwd = Get-Location
        if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
            $wtArgs = @("new-tab", "--title", "Codex", "-d", $cwd.Path, "codex")
            if ($Rest) { $wtArgs += $Rest }
            Start-Process wt.exe -ArgumentList $wtArgs
            Write-Host "[codex] Spawned new tab in Windows Terminal (cwd=$cwd)" -ForegroundColor Green
        } else {
            $cmdLine = "codex"
            if ($Rest) { $cmdLine += " " + ($Rest -join " ") }
            Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $cmdLine -WorkingDirectory $cwd
            Write-Host "[codex] Spawned PowerShell window (cwd=$cwd)" -ForegroundColor Green
        }
    }

    "ask" {
        # Quick-ask via Haiku + mini-memoria. NOT interactive - prints answer + returns.
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron ask <pregunta>  (sin comillas)" -ForegroundColor Yellow
            Write-Host "       ultron ask --no-memory <pregunta>  (sin contexto INDEX)" -ForegroundColor Gray
            exit 1
        }
        Invoke-Py "quick_ask.py" $Rest
    }

    # @ULTRON-DEPRECATED:14.0.0
    #   reason: usage_tracker.py dropped in v12.5 cockpit reorg
    #   replaced-by: claude /usage (interactive native command)
    #   remove-after: 2026-11-07
    #   owner: <your-username>
    "usage" {
        Write-Host "ultron usage: removed in v12.5" -ForegroundColor Yellow
        Write-Host "  Use: claude /usage   (interactive native command)" -ForegroundColor Gray
        exit 1
    }
    # @ULTRON-DEPRECATED-END

    "app" {
        # ultron app <name> [extra args]  - launch GUI app
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron app <name> [args]" -ForegroundColor Yellow
            Write-Host "       ultron apps list  (to see available)" -ForegroundColor Gray
            exit 1
        }
        $args = @("launch") + $Rest
        Invoke-Py "apps_launcher.py" $args
    }

    "apps" {
        # ultron apps <list|add|remove|discover>
        if (-not $Rest -or $Rest.Count -eq 0) {
            Invoke-Py "apps_launcher.py" @("list")
        } else {
            Invoke-Py "apps_launcher.py" $Rest
        }
    }

    "inventory" {
        # ultron inventory [--filter X] [--json] [--md PATH] [--source registry|winget|all]
        # Lists ALL Windows apps via registry + winget. Distinct from `apps`
        # (GUI launcher registry). Use for system audit, backup planning,
        # Drive sync exclusion decisions.
        Invoke-Py "installed_apps.py" $Rest
    }

    "verify" {
        # ultron verify [--json] [--doc PATH] [--strict]
        # Parses [verify: <cmd>] [expect: <regex>] claims in critical docs
        # (SYSTEM-MAP.md, system-state.md) and runs each cmd. Reports
        # PASS/FAIL/ERROR with evidence. Read-only: never modifies docs.
        Invoke-Py "verify_claims.py" $Rest
    }

    "audit" {
        # ultron audit list  -or-  ultron audit run <persona>
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage: ultron audit list                  (show personas)" -ForegroundColor Yellow
            Write-Host "       ultron audit run <persona-name>    (repo-evaluator eval, Opus FULL)" -ForegroundColor Yellow
            exit 1
        }
        Invoke-Py "persona_audit.py" $Rest
    }

    "project" {
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron project edit <id> <query...>          (Sonnet, dry-run)"
            Write-Host "  ultron project edit <id> <query...> --apply  (commits change)"
            Write-Host "  ultron project add <description...>          (Sonnet, dry-run)"
            Write-Host "  ultron project add <description...> --apply  (commits new entry)"
            Write-Host "  ultron project delete <id> [-y]              (with confirmation)"
            Write-Host "  ultron project tag <id> add|remove <tag>     (no LLM, instant)"
            exit 1
        }
        Invoke-Py "project_editor.py" $Rest
    }

    "health" {
        # ultron health - quick health check of all CORE subsystems
        $args = @()
        if ($Rest) { $args += $Rest }
        Invoke-Py "health.py" $args
    }

    "skills" {
        # ultron skills registry <status|propagate|register|process-pending|update-manifest>
        # ultron skills export <skill> --target codex|gemini|both [--out <dir>]
        # ultron skills check <skill>
        # ultron skills sync-all
        # ultron skills discover <search|fetch|list|preview|install|clean> [args]
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron skills registry status           Show drift across Claude/Codex/Agents"
            Write-Host "  ultron skills registry propagate        Copy missing universal skills to all registries"
            Write-Host "  ultron skills registry register <name>  Queue skill for sync (other AIs use this)"
            Write-Host "  ultron skills registry process-pending  Process pending-sync queue"
            Write-Host "  ultron skills registry update-manifest  Rebuild manifest from disk"
            Write-Host ""
            Write-Host "  ultron skills export <skill> [--target codex|gemini|both] [--out <dir>]"
            Write-Host "                                    Translate Claude SKILL.md to AGENTS.md/GEMINI.md"
            Write-Host "  ultron skills check <skill> [--out <dir>]"
            Write-Host "                                    Compare drift vs target files"
            Write-Host "  ultron skills sync-all [--target both] [--out <base>]"
            Write-Host "                                    Translate ALL skills"
            Write-Host "  ultron skills discover search <query> [--max N]"
            Write-Host "                                    Search GitHub for community SKILL.md files"
            Write-Host "  ultron skills discover fetch <raw_url> [--name <n>]"
            Write-Host "                                    Cache a skill from a GitHub raw URL"
            Write-Host "  ultron skills discover list       List cached skills pending review"
            Write-Host "  ultron skills discover preview <name>"
            Write-Host "                                    Preview a cached skill (first 50 lines)"
            Write-Host "  ultron skills discover install <name> [--force]"
            Write-Host "                                    Install cached skill to ~/.claude/skills/"
            Write-Host "  ultron skills discover clean [--days N]"
            Write-Host "                                    Remove old unreviewed cached skills"
            Write-Host ""
            Write-Host "  ultron skills vault status              Active vs vaulted counts"
            Write-Host "  ultron skills vault list [--active|--vaulted]"
            Write-Host "  ultron skills vault search `"<query>`"    Find a vaulted skill (keyword over INDEX.json)"
            Write-Host "  ultron skills vault restore <name>...   Bring skill(s) back to ~/.claude/skills/"
            Write-Host "  ultron skills vault migrate --keep-file <path> [--dry-run]"
            Write-Host "                                    One-time: move non-keep skills to the vault"
            exit 1
        }
        $action = ([string]$Rest[0]).ToLower()
        $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
        if ($action -eq "registry") {
            Invoke-Py "registry_sync.py" $remaining
        } elseif ($action -eq "vault") {
            Invoke-Py "skill_vault.py" $remaining
        } elseif ($action -eq "discover") {
            Invoke-Py "skill_discover.py" $remaining
        } elseif ($action -eq "manifest") {
            # v12.2 unified skill registry (installer tracking + sync-prompt)
            if ($remaining.Count -eq 0) {
                Invoke-Py "skill_manifest.py" @("status")
            } else {
                $sub = ([string]$remaining[0]).ToLower()
                $subRest = @(if ($remaining.Count -gt 1) { $remaining[1..($remaining.Count-1)] } else { @() })
                switch ($sub) {
                    "rebuild"     { Invoke-Py "skill_manifest.py" @("rebuild") }
                    "status"      { Invoke-Py "skill_manifest.py" (@("status") + $subRest) }
                    "sync-prompt" { Invoke-Py "skill_manifest.py" @("sync-prompt") }
                    default {
                        Write-Host "Unknown manifest action: $sub" -ForegroundColor Red
                        Write-Host "Try: ultron skills manifest [status|rebuild|sync-prompt]" -ForegroundColor Yellow
                        exit 1
                    }
                }
            }
        } else {
            Invoke-Py "skill_sync.py" $Rest
        }
    }

    "self-improve" {
        # AutoUpdater L1+L2+L3: scan/audit/propose/apply (human-gated)
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON AutoUpdater (full L1+L2+L3 pipeline)" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron self-improve scan          L1: rank audit candidates"
            Write-Host "  ultron self-improve audit <skill> [--quick]"
            Write-Host "                                    L1: run repo-evaluator on target"
            Write-Host "  ultron self-improve history       L1: audit log with notas"
            Write-Host "  ultron self-improve news-flags    L1: news -> skill update triggers"
            Write-Host "  ultron self-improve propose <audit-md>"
            Write-Host "                                    L2: Sonnet generates patches (NO apply)"
            Write-Host "  ultron self-improve proposals     L2: list pending proposals"
            Write-Host "  ultron self-improve apply <proposals-json>"
            Write-Host "                                    L3: spawn Claude to review/apply (human-gated)"
            Write-Host "  ultron self-improve full <skill>"
            Write-Host "                                    Full pipeline: audit -> propose -> apply (human-gated)"
            exit 1
        }
        Invoke-Py "auto_updater.py" $Rest
    }

    "skill" {
        # ultron skill create  -> interactive skill scaffold
        # ultron skill register <name>  -> add new skill to brain index
        # ultron skill list             -> list installed skills + index status
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron skill create [--force]      Q&A interactive (Sonnet)"
            Write-Host "  ultron skill register <name>       Index a newly-installed skill"
            Write-Host "  ultron skill register --all        Re-scan + index all skills"
            Write-Host "  ultron skill list                  Show installed skills + index status"
            exit 1
        }
        $action = ([string]$Rest[0]).ToLower()
        $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })

        if ($action -eq "create") {
            Invoke-Py "skill_creator.py" (@("new") + $remaining)
        }
        elseif ($action -eq "register") {
            $skillsDir = Join-Path $env:USERPROFILE ".claude\skills"
            # PS5.1 flattens single-element arrays to a scalar - force array context.
            $remArr = @($remaining)
            if ($remArr.Count -eq 0) {
                Write-Host "Provide a skill name or 'all'" -ForegroundColor Red
                Write-Host "  ultron skill register my-new-skill" -ForegroundColor Yellow
                Write-Host "  ultron skill register all" -ForegroundColor Yellow
                exit 1
            }
            $first = [string]$remArr[0]
            # PowerShell sometimes strips leading dashes - accept both 'all' and '--all'
            if ($first -eq "all" -or $first -eq "--all" -or $first -eq "-all" -or $first -eq "-") {
                Write-Host "[skill] Re-scanning all skills under $skillsDir" -ForegroundColor Cyan
            } else {
                $skillName = $first
                $skillMd = Join-Path $skillsDir "$skillName\SKILL.md"
                if (-not (Test-Path $skillMd)) {
                    Write-Host "[skill] SKILL.md not found: $skillMd" -ForegroundColor Red
                    Write-Host "  Drop the skill folder under $skillsDir\$skillName\ first." -ForegroundColor Yellow
                    exit 1
                }
                Write-Host "[skill] Found $skillName at $skillMd" -ForegroundColor Cyan
            }
            Write-Host "[skill] Running brain_index update (incremental)..." -ForegroundColor DarkGray
            Invoke-Py "brain_index.py" @("update")
            Write-Host "[skill] OK - now queryable: ultron brain query <topic> --category skill" -ForegroundColor Green
        }
        elseif ($action -eq "list") {
            $skillsDir = Join-Path $env:USERPROFILE ".claude\skills"
            $localCount = (Get-ChildItem -Path $skillsDir -Directory -ErrorAction SilentlyContinue |
                            Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") }).Count
            Write-Host "Installed skills under $skillsDir : $localCount" -ForegroundColor Cyan
            Invoke-Py "brain_index.py" @("query", "*", "--layer", "L1-skills", "--top", "100")
        }
        else {
            Write-Host "Unknown skill action: $action" -ForegroundColor Red
            Write-Host "Try: ultron skill (no args for help)" -ForegroundColor Yellow
            exit 1
        }
    }

    # @ULTRON-DEPRECATED:14.0.0
    #   reason: usage_limits.py dropped in v12.5 cockpit reorg
    #   replaced-by: claude /usage (window limits visible there)
    #   remove-after: 2026-11-07
    #   owner: <your-username>
    "limits" {
        Write-Host "ultron limits: removed in v12.5" -ForegroundColor Yellow
        Write-Host "  Window limits are visible via: claude /usage" -ForegroundColor Gray
        exit 1
    }
    # @ULTRON-DEPRECATED-END

    "jobs" {
        # ultron jobs submit|status|list|cancel|logs|clean
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron jobs submit <label> -- <cmd...>   Launch background job"
            Write-Host "  ultron jobs list [--all] [--n N]         List recent jobs"
            Write-Host "  ultron jobs status <job_id>              Show job status + runtime"
            Write-Host "  ultron jobs logs <job_id> [--tail N]     Print last N lines stdout"
            Write-Host "  ultron jobs cancel <job_id>              Terminate running job"
            Write-Host "  ultron jobs clean [--days N]             Remove old finished jobs"
            exit 1
        }
        Invoke-Py "job_supervisor.py" $Rest
    }

    "memory" {
        # v12 "Brain Update": L2 vault sync (~/.ultron-vault/)
        # v12.2: bridge = CC project memories -> vault
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Memory v12.2" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron memory status                  Vault size, file count, dirty?"
            Write-Host "  ultron memory sync [-m <msg>] [--push]  Stage + commit (+ push)"
            Write-Host "  ultron memory push                    Push vault to remote"
            Write-Host "  ultron memory mode <HIGH|ULTRA|LEARN|MEDIUM|LOW>"
            Write-Host "                                        Set session mode for Stop hook"
            Write-Host ""
            Write-Host "  ultron memory bridge                  Show CC<->vault pending ingest"
            Write-Host "  ultron memory bridge ingest           Ingest CC project memories -> vault"
            Write-Host "  ultron memory bridge repair           Scan vault for broken [[wikilinks]]"
            Write-Host "  ultron memory bridge repair --fix     Auto-fix broken wikilinks"
            exit 1
        }
        $action = ([string]$Rest[0]).ToLower()
        $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
        if ($action -eq "bridge") {
            if ($remaining.Count -eq 0 -or ([string]$remaining[0]).ToLower() -eq "status") {
                Invoke-Py "memory_bridge.py" @("status")
            } elseif (([string]$remaining[0]).ToLower() -eq "ingest") {
                Invoke-Py "memory_bridge.py" @("ingest")
            } elseif (([string]$remaining[0]).ToLower() -eq "repair") {
                $repairArgs = @("repair-wikilinks") + (@($remaining[1..($remaining.Count-1)]))
                Invoke-Py "memory_bridge.py" $repairArgs
            } else {
                Write-Host "Unknown bridge action: $($remaining[0])" -ForegroundColor Red
                Write-Host "Try: ultron memory bridge [status|ingest|repair|repair --fix]" -ForegroundColor Yellow
                exit 1
            }
        } else {
            Invoke-Py "memory_sync.py" $Rest
        }
    }

    "brain" {
        # v12 BRAIN: FTS5 index over L1 + L2 memory (palanca 10x retrieval)
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Brain Index v12 - FTS5 retrieval over L1+L2 memory" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron brain build                    Full rebuild (wipes index)"
            Write-Host "  ultron brain update                   Incremental update (cheap)"
            Write-Host "  ultron brain query '<query>' [--top 8] [--layer L2-vault] [--category knowledge]"
            Write-Host "  ultron brain stats                    Counts + index size + broken links"
            Write-Host "  ultron brain inspect <id>             Full record dump for note id"
            Write-Host ""
            Write-Host "Index location: ~/.ultron/brain_index/index.db (local only, never pushed)" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "brain_index.py" $Rest
    }

    "index" {
        # S2-A alias: short form for brain_index.py — forwards all flags including
        # --mode chunks / --top N.  Spawned via Invoke-Py (uv run python, no window).
        # Usage: ultron index query "ue5 blueprints" --mode chunks --top 5
        #        ultron index build
        #        ultron index update
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Index (S2-A) - chunk-aware FTS5 retrieval" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron index build                           Full rebuild (chunks + token_est)"
            Write-Host "  ultron index update                          Incremental update"
            Write-Host "  ultron index query '<q>' [--mode chunks|notes] [--top K]"
            Write-Host "  ultron index stats                           Counts + chunk stats"
            Write-Host ""
            Write-Host "Alias for: uv run python brain_index.py @args" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "brain_index.py" $Rest
    }

    "deadwood" {
        # v14.1 GENESIS-DEADWOOD alias: short form for deadwood_scanner.py.
        # Surfaces sentinel + heuristic + cross-ref findings.
        # Usage: ultron deadwood                          # default scan, stdout
        #        ultron deadwood --json --report          # write sidecar + audit md
        #        ultron deadwood --quiet                  # exit code only
        #        ultron deadwood --roots <path> [<path>]  # custom scan roots
        if ($Rest -and $Rest.Count -gt 0 -and $Rest[0] -eq "help") {
            Write-Host "ULTRON Deadwood Scanner (v14.1) - dead-fragment detection" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron deadwood                          Default scan, stdout"
            Write-Host "  ultron deadwood --json                   + sidecar to ~/.ultron/.tmp/deadwood.json"
            Write-Host "  ultron deadwood --report                 + markdown to ~/.ultron/audits/"
            Write-Host "  ultron deadwood --quiet                  Suppress stdout, exit code only"
            Write-Host "  ultron deadwood --roots P [P ...]        Custom scan roots"
            Write-Host ""
            Write-Host "Three stages: sentinel (@ULTRON-DEPRECATED) + heuristic regex + cross-ref graph" -ForegroundColor DarkGray
            Write-Host "Exit codes: 0=clean, 1=warn, 2=blocking" -ForegroundColor DarkGray
            exit 0
        }
        Invoke-Py "deadwood_scanner.py" $Rest
    }

    "compact" {
        # v12 BRAIN: post-session synthesizer (Codex + brain_index).
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Session Compactor v12 - synthesize last session into vault note" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron compact run [--session-id <UUID>] [--transcript <jsonl>] [--dry-run]"
            Write-Host "  ultron compact auto                   Stop-hook entry (auto-detect)"
            Write-Host ""
            Write-Host "Output: ~/.ultron-vault/50_SESSIONS_LOG/auto-<date>-<sid>.md" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "session_compactor.py" $Rest
    }

    "alerts" {
        # v13.4 Sprint 1: Alerts Bus (~/.ultron/alerts.jsonl)
        # ultron alerts <list|read-unacked|ack|purge|write> [args]
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Alerts Bus v13.4 - persistent alert channel" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron alerts list [--severity X] [--unacked] [--limit N] [--format json|table]"
            Write-Host "                                        Browse alerts (folded state)"
            Write-Host "  ultron alerts read-unacked [--severity-min warn] [--limit N] [--format markdown|json|table]"
            Write-Host "                                        Read unacked alerts (used by SessionStart hook)"
            Write-Host "  ultron alerts ack <id>                Append an ack record"
            Write-Host "  ultron alerts purge [--older-than 30d]"
            Write-Host "                                        Move old records to monthly archive"
            Write-Host "  ultron alerts write -s <sev> --source <name> -m <msg> [-t a,b]"
            Write-Host "                                        Append one alert (manual / scripts)"
            Write-Host ""
            Write-Host "Storage: ~/.ultron/alerts.jsonl  (append-only)" -ForegroundColor DarkGray
            Write-Host "Schema:  ~/.ultron/docs/alerts-bus.md" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "alerts.py" $Rest
    }

    "decay" {
        # v12 BRAIN: knowledge decay queue (staleness-aware vault hygiene)
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Decay Queue v12 - staleness scoring over vault notes" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron decay scan [--top N] [--min-score S] [--category C] [--json]"
            Write-Host "  ultron decay verify <note_id> [--note '<reason>']  Mark fresh + log"
            Write-Host "  ultron decay touch <note_id>           Bump count without re-dating"
            Write-Host "  ultron decay stats                     Distribution by criticality + age"
            Write-Host "  ultron decay prime                     Top-3 stale (JSON, hook-ready)"
            Write-Host ""
            Write-Host "Frontmatter: 'criticality: critical|high|medium|low' weights the score" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "decay_queue.py" $Rest
    }

    "vault" {
        # v12 BRAIN: vault schema migrator (Triple repo-evaluator R3 closure)
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON Vault Migrator v12 - schema version + migrations" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron vault audit                    Per-version counts + missing fields"
            Write-Host "  ultron vault migrate --to <N> [--dry-run]"
            Write-Host "                                        Apply migrations up to vN"
            Write-Host "  ultron vault bless <pattern> --version <N> [--dry-run]"
            Write-Host "                                        Stamp schema_version into matching files"
            Write-Host "  ultron vault validate                 Surface schema-broken notes"
            Write-Host ""
            Write-Host "Refuses to write outside ~/.ultron-vault/" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "vault_migrator.py" $Rest
    }

    # @ULTRON-DEPRECATED:14.0.0
    #   reason: telemetry.py + telemetry.db were dead pipeline (4 hand-typed rows ever, no automatic writer)
    #   replaced-by: routing.jsonl + route_quality_aggregator.py + usage_report.py
    #   remove-after: 2026-11-07
    #   owner: <your-username>
    "telemetry" {
        Write-Host "ultron telemetry: removed in v12.5" -ForegroundColor Yellow
        Write-Host "  Routing data now in route_quality.json - query with:" -ForegroundColor Gray
        Write-Host "    uv run python scripts/cockpit/route_quality_aggregator.py status"
        Write-Host "    uv run python scripts/cockpit/usage_report.py show --days 7"
        exit 1
    }
    # @ULTRON-DEPRECATED-END

    "security" {
        # S5-C: ultron security <scan|audit-all|provenance|settings-snapshot|settings-diff|settings-verify|secrets|allowlist> [args]
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
        $remaining = @(if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count-1)] } else { @() })
        switch ($action) {
            "scan"        { Invoke-Py "skill_sync_security.py" (@("scan") + $remaining) }
            "audit-all"   { Invoke-Py "skill_sync_security.py" (@("audit-all") + $remaining) }
            "provenance"  { Invoke-Py "skill_provenance.py" $remaining }
            "settings-snapshot" { Invoke-Py "settings_integrity.py" (@("snapshot") + $remaining) }
            "settings-diff"     { Invoke-Py "settings_integrity.py" (@("diff") + $remaining) }
            "settings-verify"   { Invoke-Py "settings_integrity.py" (@("verify") + $remaining) }
            "secrets"     { Invoke-Py "secrets_scanner.py" (@("scan") + $remaining) }
            "allowlist"   {
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

    "config" {
        # v12 BRAIN: central config (mode_ttl, decay threshold, compactor mins...)
        if (-not $Rest -or $Rest.Count -eq 0) {
            Write-Host "ULTRON BRAIN config v12 - tunables for memory + decay + compactor" -ForegroundColor Cyan
            Write-Host "Usage:" -ForegroundColor Yellow
            Write-Host "  ultron config show                    Pretty-print effective config"
            Write-Host "  ultron config get <key>               Print one value"
            Write-Host "  ultron config set <key> <value>       Update + persist"
            Write-Host "  ultron config reset                   Restore defaults (delete file)"
            Write-Host "  ultron config path                    Print config file path"
            Write-Host ""
            Write-Host "Keys: mode_ttl_hours, decay_threshold_days, decay_max_prime_results," -ForegroundColor DarkGray
            Write-Host "      session_min_turns, session_min_user_chars, codex_timeout_sec," -ForegroundColor DarkGray
            Write-Host "      brain_session_lookback_days" -ForegroundColor DarkGray
            exit 1
        }
        Invoke-Py "brain_config.py" $Rest
    }

    default {
        Write-Host "Unknown command: $Command" -ForegroundColor Red
        Write-Host "Try: ultron help" -ForegroundColor Yellow
        exit 1
    }
}
