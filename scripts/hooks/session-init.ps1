param(
    [string]$SessionId = "",
    [string]$Mode = "MEDIUM"
)

# Claude Code passes session data via stdin as JSON.
# Try to read it (non-blocking) to capture the real session_id.
try {
    if ([Console]::IsInputRedirected) {
        $stdinRaw = [Console]::In.ReadToEnd()
        if ($stdinRaw -and $stdinRaw.Trim()) {
            $stdinData = $stdinRaw | ConvertFrom-Json -ErrorAction Stop
            if ($stdinData.session_id -and $SessionId -eq "") {
                $SessionId = $stdinData.session_id.ToString().Substring(0, [Math]::Min(8, $stdinData.session_id.ToString().Length))
            }
        }
    }
} catch { <# stdin parse failure â€” continue with fallback #> }

# Fallback: generate a short GUID if we still have no session_id
if ($SessionId -eq "") {
    $SessionId = [guid]::NewGuid().ToString().Substring(0, 8)
}

Write-Host "[OK] ULTRON session init - MODE=$Mode"

$sessionData = @{
    SessionId = $SessionId
    Mode = $Mode
    StartTime = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    MemoryReady = $true
}

# Surface last session's mode so Claude can see it in current-session.json
$modeFile = "$env:USERPROFILE\.ultron\.tmp\current-session-mode.json"
if (Test-Path $modeFile) {
    try {
        $prevModeData = [System.IO.File]::ReadAllText($modeFile,
                                                       [System.Text.Encoding]::UTF8) |
                        ConvertFrom-Json
        if ($prevModeData.mode) {
            $sessionData["LastSessionMode"] = $prevModeData.mode
        }
    } catch { }
}

# v12 BRAIN: drain any pending vault pushes that the previous Stop hook
# couldn't deliver (offline, conflict). Best-effort, never blocks startup.
# Sprint 1.4 (Kirkardo TOTAL v2 2026-05-03): wrapped in Start-Job with 5s
# timeout â€” push-queue is a git network call and was breaking the "pure no
# tool calls" contract from CLAUDE.md (drift detected by HOOKS audit).
# If timeout, items stay queued for next SessionStart retry â€” same semantics,
# no SessionStart hang.
$syncScript = "$env:USERPROFILE\.ultron\scripts\cockpit\memory_sync.py"
if (Test-Path $syncScript) {
    $useUv = [bool] (Get-Command uv -ErrorAction SilentlyContinue)
    $pushJob = Start-Job -Name 'ultron-push-queue' -ArgumentList $syncScript, $useUv -ScriptBlock {
        param($Script, $UseUv)
        if ($UseUv) { & uv run python $Script push-queue 2>&1 }
        else        { & python $Script push-queue 2>&1 }
    }
    if ($null -eq (Wait-Job -Job $pushJob -Timeout 5)) {
        Stop-Job -Job $pushJob -ErrorAction SilentlyContinue
    }
    Remove-Job -Job $pushJob -Force -ErrorAction SilentlyContinue
}

# v12 BRAIN priming: pull yesterday's compactor seeds + top-3 stale notes
# so the model has yesterday's open threads + decay alerts in its context
# from turn 0. Best-effort: any error degrades silently.
$tmpDir   = "$env:USERPROFILE\.ultron\.tmp"
$decayCache = Join-Path $tmpDir "decay-prime.json"
if (Test-Path $decayCache) {
    try {
        # PS5.1 default encoding is cp1252; force UTF-8 so non-ASCII titles
        # (em-dashes, accents) survive the round-trip.
        $raw = [System.IO.File]::ReadAllText($decayCache,
                                              [System.Text.Encoding]::UTF8)
        $sessionData["StaleNotes"] = $raw | ConvertFrom-Json
    } catch {
        # ignore parse errors â€” never block session start
    }
}

# v12.5.0-fix2 (F4): surface critical pending actions from dead-letter queue.
# pending_actions prime writes top-N critical/blocking actions to JSON; we
# inline them in current-session.json so the agent sees them in turn 0
# (closes the auditâ†’fix manual loop â€” SI-CRIT-1 of Kirkardo TOTAL).
$pendingScript = "$env:USERPROFILE\.ultron\scripts\cockpit\pending_actions.py"
$pendingCache  = Join-Path $tmpDir "pending-actions-primed.json"
if (Test-Path $pendingScript) {
    try {
        if (-not (Test-Path $tmpDir)) {
            New-Item -Path $tmpDir -ItemType Directory -Force | Out-Null
        }
        # Sprint 1.4 (Kirkardo TOTAL v2 2026-05-03): wrapped in Start-Job with
        # 3s timeout â€” pending_actions prime is local SQLite read, normally <500ms,
        # but defensive bound prevents SessionStart hang on any pathological case.
        $useUvP = [bool] (Get-Command uv -ErrorAction SilentlyContinue)
        $pendJob = Start-Job -Name 'ultron-pending-prime' -ArgumentList $pendingScript, $pendingCache, $useUvP -ScriptBlock {
            param($Script, $Out, $UseUv)
            if ($UseUv) { & uv run python $Script prime --output $Out --max 5 2>&1 }
            else        { & python $Script prime --output $Out --max 5 2>&1 }
        }
        if ($null -eq (Wait-Job -Job $pendJob -Timeout 3)) {
            Stop-Job -Job $pendJob -ErrorAction SilentlyContinue
        }
        Remove-Job -Job $pendJob -Force -ErrorAction SilentlyContinue
        if (Test-Path $pendingCache) {
            $rawPending = [System.IO.File]::ReadAllText($pendingCache,
                                                         [System.Text.Encoding]::UTF8)
            $sessionData["PendingActions"] = $rawPending | ConvertFrom-Json
        }
    } catch {
        # never block session start over pending-action priming
    }
}

# Sprint 4 F15: Pull recent session highlights primed by previous Stop hook.
# Token-friendly memory across sessions so Claude can answer "remember when X?"
# without loading full transcripts. Best-effort: degrades silently.
$highlightsCache = Join-Path $tmpDir "recent-highlights.json"
if (Test-Path $highlightsCache) {
    try {
        $rawHl = [System.IO.File]::ReadAllText($highlightsCache,
                                                [System.Text.Encoding]::UTF8)
        $sessionData["RecentHighlights"] = $rawHl | ConvertFrom-Json
    } catch { }
}

# Pull next_session_seeds from the most recent auto-compacted log if any.
$vaultLog = "$env:USERPROFILE\.ultron-vault\50_SESSIONS_LOG"
if (Test-Path $vaultLog) {
    $latestAuto = Get-ChildItem -Path $vaultLog -Filter "auto-*.md" `
                                  -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending |
                  Select-Object -First 1
    if ($latestAuto) {
        $sessionData["LastCompactor"] = $latestAuto.Name
        # Extract bullet lines under "## Next-session seeds" (best-effort regex)
        try {
            $body = Get-Content -Raw $latestAuto.FullName
            $match = [regex]::Match(
                $body,
                '## Next-session seeds\s*\n\s*\n((?:- [^\r\n]+\r?\n)+)',
                [System.Text.RegularExpressions.RegexOptions]::Multiline)
            if ($match.Success) {
                $seeds = $match.Groups[1].Value -split "`n" |
                         ForEach-Object { ($_ -replace '^\s*-\s*', '').Trim() } |
                         Where-Object { $_ -ne '' }
                $sessionData["NextSessionSeeds"] = $seeds
            }
        } catch {
            # ignore parsing errors
        }
    }
}

$sessionTmp = Join-Path $tmpDir "current-session.json"
$contextMd = Join-Path $tmpDir "context.md"
if (-not (Test-Path $tmpDir)) {
    New-Item -Path $tmpDir -ItemType Directory -Force | Out-Null
}
# Force UTF-8 (no BOM) so non-ASCII titles survive PS5.1's cp1252 default.
$jsonText = $sessionData | ConvertTo-Json -Depth 5
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($sessionTmp, $jsonText, $utf8)

# v13.2 context_primer: generate context.md (â‰¤400 tokens) for Claude READ PATH.
# This is THE missing cable: Claude reads context.md at session start per CLAUDE.md.
# Best-effort: wrapped in job with 8s timeout â€” primer reads JSON files, normally <1s.
$primerScript = "$env:USERPROFILE\.ultron\scripts\cockpit\context_primer.py"
if (Test-Path $primerScript) {
    $useUvPr = [bool] (Get-Command uv -ErrorAction SilentlyContinue)
    $primerJob = Start-Job -Name 'ultron-context-primer' -ArgumentList $primerScript, $useUvPr -ScriptBlock {
        param($Script, $UseUv)
        if ($UseUv) { & uv run python $Script generate 2>&1 }
        else        { & python $Script generate 2>&1 }
    }
    if ($null -eq (Wait-Job -Job $primerJob -Timeout 8)) {
        Stop-Job -Job $primerJob -ErrorAction SilentlyContinue
    }
    Remove-Job -Job $primerJob -Force -ErrorAction SilentlyContinue
}

# v14.4 P2: stdout kept stable for prompt cache friendliness. The volatile
# values (SessionId, counts, pending markers) live in current-session.json
# already and Claude can read that file when it needs the dynamic state.
# Original line emitted SessionId + 4 dynamic fields and was the only
# session-level stdout volatility identified in
# ~/.ultron/audits/hook-cache-audit-2026-05-08.md.
Write-Host "[OK] Session ready - primed (see ~/.ultron/.tmp/current-session.json)"

# v13.4 Sprint 1: Pilar B Alerts Bus integration. After context_primer has
# regenerated context.md, fold in any unacked warn+blocking alerts so the
# user (and Claude) sees them in turn 0. Best-effort: silent failure must
# never block session start. Wrapped in Start-Job with 4s timeout â€” alerts
# read is local jsonl + small JSON, normally <500ms.
$alertsScript = "$env:USERPROFILE\.ultron\scripts\cockpit\alerts.py"
if ((Test-Path $alertsScript) -and (Test-Path $contextMd)) {
    $useUvA = [bool] (Get-Command uv -ErrorAction SilentlyContinue)
    $alertsJob = Start-Job -Name 'ultron-alerts-read' -ArgumentList $alertsScript, $useUvA -ScriptBlock {
        param($Script, $UseUv)
        if ($UseUv) {
            & uv run python $Script read-unacked --severity-min warn --limit 5 --format markdown 2>$null
        } else {
            & python $Script read-unacked --severity-min warn --limit 5 --format markdown 2>$null
        }
    }
    if ($null -eq (Wait-Job -Job $alertsJob -Timeout 4)) {
        Stop-Job -Job $alertsJob -ErrorAction SilentlyContinue
    } else {
        $alertsOutput = (Receive-Job -Job $alertsJob -ErrorAction SilentlyContinue) -join "`n"
        if ($alertsOutput -and $alertsOutput.Trim()) {
            $utf8NoBom = New-Object System.Text.UTF8Encoding $false
            $existing = [System.IO.File]::ReadAllText($contextMd, $utf8NoBom)
            $appended = $existing.TrimEnd() + "`n`n## Pending Alerts`n" + $alertsOutput.Trim() + "`n"
            [System.IO.File]::WriteAllText($contextMd, $appended, $utf8NoBom)
        }
    }
    Remove-Job -Job $alertsJob -Force -ErrorAction SilentlyContinue
}

# Helper: launch a Python script fully invisibly (no focus steal during gaming).
# Uses pythonw.exe (Windows subsystem) when available â€” guaranteed no console window.
# Falls back to python.exe with -WindowStyle Hidden if pythonw missing (rare).
$VenvDir   = "$env:USERPROFILE\.ultron\.venv\Scripts"
$VenvPyW   = "$VenvDir\pythonw.exe"
$VenvPy    = "$VenvDir\python.exe"
$SilentExe = if (Test-Path $VenvPyW) { $VenvPyW } else { $VenvPy }

function Start-SilentPython {
    param([string]$Script, [string[]]$ScriptArgs, [string]$LogBase)
    $tmpDir = "$env:USERPROFILE\.ultron\.tmp"
    if (-not (Test-Path $tmpDir)) {
        New-Item -ItemType Directory -Path $tmpDir -Force -ErrorAction SilentlyContinue | Out-Null
    }
    $allArgs = @($Script) + $ScriptArgs
    Start-Process -FilePath $SilentExe -ArgumentList $allArgs `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$tmpDir\$LogBase.log" `
        -RedirectStandardError  "$tmpDir\${LogBase}_err.log" `
        -ErrorAction SilentlyContinue | Out-Null
}

# S2-A: Brain index staleness check (>4h â†’ incremental update in background).
try {
    $indexDb = "$env:USERPROFILE\.ultron\brain_index\index.db"
    if (Test-Path $indexDb) {
        $ageHours = ((Get-Date) - (Get-Item $indexDb).LastWriteTime).TotalHours
        if ($ageHours -gt 4) {
            $brainScript = "$env:USERPROFILE\.ultron\scripts\cockpit\brain_index.py"
            if (Test-Path $brainScript) {
                Start-SilentPython -Script $brainScript -ScriptArgs @("update") -LogBase "brain_update"
            }
        }
    }
} catch {
    # brain index update is non-fatal â€” never block session start
}

# S3-A: Generate L0 pinned context for this session.
try {
    $genL0 = "$env:USERPROFILE\.ultron\scripts\cockpit\generate_L0.py"
    if (Test-Path $genL0) {
        Start-SilentPython -Script $genL0 -ScriptArgs @() -LogBase "generate_L0"
    }
} catch {
    # L0 generation is non-fatal â€” never block session start
}

# S5 Sub-pilar A: Probe MCP servers and refresh ~/.ultron/.tmp/mcp-health.json.
try {
    $mcpHealth = "$env:USERPROFILE\.ultron\scripts\cockpit\mcp_health_check.py"
    if (Test-Path $mcpHealth) {
        Start-SilentPython -Script $mcpHealth -ScriptArgs @("--quiet") -LogBase "mcp_health"
    }
} catch {
    # MCP health check is non-fatal â€” never block session start
}

# v15.0.x: Qdrant ensure — keep semantic recall available across sessions.
# Background fire-and-forget; never blocks session start. Reports status to
# ~/.ultron/.tmp/qdrant-health.json which context_primer reads next turn.
# v15.0.2: the user-facing retry panel now lives in the ULTRON-QdrantBoot
# scheduled task (LogonTrigger). SessionStart only refreshes health.json
# so context_primer has current state — no panel here (would be noisy).
try {
    $qdrantScript = "$env:USERPROFILE\.ultron\scripts\hooks\ensure-qdrant.ps1"
    if (Test-Path $qdrantScript) {
        Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
            "-ExecutionPolicy", "Bypass",
            "-File", $qdrantScript
        ) -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    }
} catch {
    # ensure-qdrant is non-fatal — never block session start
}

exit 0

