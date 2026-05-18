# ULTRON v12 "The Brain Update" — Stop hook for memory L2 sync.
#
# Triggered by Claude Code on session Stop event.
# Always runs: brain_index.update + decay_queue.prime (cheap, local, derived).
# HIGH/ULTRA/LEARN only: vault commit + push + session_compactor (expensive).
#
# Failures are logged but never block the Stop event (exit 0 always).
#
# Install: hook configured in ~/.claude/settings.json with event: Stop

$ErrorActionPreference = "Continue"

# Read session data from Claude Code stdin (passes session_id + cwd as JSON).
$stdinSessionId = ""
try {
    if ([Console]::IsInputRedirected) {
        $stdinRaw = [Console]::In.ReadToEnd()
        if ($stdinRaw -and $stdinRaw.Trim()) {
            $stdinData = $stdinRaw | ConvertFrom-Json -ErrorAction Stop
            if ($stdinData.session_id) {
                $stdinSessionId = $stdinData.session_id.ToString()
            }
        }
    }
} catch { <# stdin parse failure — continue without session_id #> }

$vault = "$env:USERPROFILE\.ultron-vault"
$logFile = "$env:USERPROFILE\.ultron\logs\stop-memory-sync.log"
$syncScript = "$env:USERPROFILE\.ultron\scripts\cockpit\memory_sync.py"
$cockpit = "$env:USERPROFILE\.ultron\scripts\cockpit"

function Write-Log {
    param($msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$ts] $msg" -Encoding UTF8 -ErrorAction SilentlyContinue
}

# ── Debounce — prevent per-tool-call refire (Auditor 2 finding) ───────────────
# Stop hook was firing 6× in 62 minutes for the same session → multiplied
# brain_index updates, push-async spawns, and Codex compactor calls.
# Skip Phase A entirely if the same session_id ran <90s ago.
$debouncePath = "$env:USERPROFILE\.ultron\.tmp\last-stop-sync.json"
$debounceWindow = 90  # seconds
try {
    if ($stdinSessionId -and (Test-Path $debouncePath)) {
        $last = Get-Content $debouncePath -Raw | ConvertFrom-Json
        if ($last.session_id -eq $stdinSessionId) {
            $lastTime = [datetime]$last.ts
            $secs = ([datetime]::Now - $lastTime).TotalSeconds
            if ($secs -lt $debounceWindow) {
                Write-Log "DEBOUNCE: same session_id ${stdinSessionId} fired ${secs}s ago — skipping"
                exit 0
            }
        }
    }
} catch { <# debounce check failure — proceed normally #> }
# Record this fire (do this BEFORE the work, so a crash doesn't disable debounce)
try {
    New-Item -ItemType Directory -Force -Path (Split-Path $debouncePath) | Out-Null
    @{
        session_id = $stdinSessionId
        ts = (Get-Date -Format "o")
    } | ConvertTo-Json | Out-File -FilePath $debouncePath -Encoding utf8 -Force
} catch { <# best-effort, never block Stop #> }

# Resolve Python launcher: prefer 'uv run python' (CLAUDE.md global rule),
# fallback to plain 'python' if uv is unavailable.
$useUv = [bool] (Get-Command uv -ErrorAction SilentlyContinue)

function Invoke-PyScript {
    param([string]$Script, [string]$Subcommand)
    if ($useUv) {
        & uv run python $Script $Subcommand 2>&1
    } else {
        & python $Script $Subcommand 2>&1
    }
}

# ── Phase A — always, every session (cheap local ops) ─────────────────────────
# OPS-01 refactor (Sprint 3 2026-05-03): Phase A scripts now run in PARALLEL
# via Start-Job + Wait-Job. Global timeout 30s covers all jobs at once.
# Pre-OPS-01 was sequential ~30-60s wall clock; post is ~5-15s.
#
# session_replay stays serial (it's <50ms append, no point spawning a job).
# background_tasks stays as standalone Start-Job (already had its own 90s budget).

$replayScript = "$cockpit\session_replay.py"
if (Test-Path $replayScript) {
    $replayArgs = @("append", "session_end", "--outcome", "success")
    if ($stdinSessionId) { $replayArgs += @("--session-id", $stdinSessionId) }
    if ($useUv) {
        & uv run python $replayScript @replayArgs 2>&1 | Out-Null
    } else {
        & python $replayScript @replayArgs 2>&1 | Out-Null
    }
    Write-Log "session_replay append session_end exit=$LASTEXITCODE"
}

# Background tasks — separate from parallel batch (90s budget, daily idempotent).
$bgScript = "$cockpit\background_tasks.py"
if (Test-Path $bgScript) {
    try {
        $bgJob = Start-Job -Name 'ultron-bgtasks' -ScriptBlock {
            param($script, $useUv)
            if ($useUv) { & uv run python $script run-all --trigger daily 2>&1 }
            else         { & python $script run-all --trigger daily 2>&1 }
        } -ArgumentList $bgScript, $useUv
        $bgDone = Wait-Job $bgJob -Timeout 90
        if ($bgDone) { Receive-Job $bgJob | Out-Null }
        else          { Stop-Job $bgJob | Out-Null }
        Remove-Job $bgJob -Force -ErrorAction SilentlyContinue
        Write-Log "background_tasks daily exit=$(if($bgDone){'ok'}else{'timeout'})"
    } catch {
        Write-Log "background_tasks daily exception: $($_.Exception.Message)"
    }
}

# Phase A parallel batch — 5 independent local I/O scripts + drift check.
# Each runs in its own Start-Job; Wait-Job collects all with 30s global timeout.
$phaseAScripts = @(
    @{ Name = 'memory_bridge';            Script = "$cockpit\memory_bridge.py";            Args = @('ingest') }
    @{ Name = 'brain_index';              Script = "$cockpit\brain_index.py";              Args = @('update') }
    @{ Name = 'route_quality_aggregator'; Script = "$cockpit\route_quality_aggregator.py"; Args = @('aggregate', '--today') }
    @{ Name = 'decay_queue';              Script = "$cockpit\decay_queue.py";              Args = @('prime', '--output', "$env:USERPROFILE\.ultron\.tmp\decay-prime.json") }
    @{ Name = 'consistency_check';        Script = "$env:USERPROFILE\.ultron\scripts\consistency_check.py"; Args = @('--quiet') }
    # v14.6 PERFECT MEMORY: keep Qdrant in sync. Best-effort — if Qdrant is
    # down (Docker not yet up post-boot, container stopped), the script exits
    # non-zero and the parallel batch logs not-OK but never blocks Stop.
    # Cold path ~5s (model load), warm path ~50ms/file. Incremental: only
    # files with changed SHA1 since last index call get re-embedded.
    @{ Name = 'embed_vault';              Script = "$cockpit\embed_vault.py";              Args = @('index') }
    # v14.8 P3: keep the ultron_skills Qdrant collection in sync. Same
    # best-effort guarantees as embed_vault. Cold path with model already
    # warm from embed_vault: ~30s for first run, <1s incremental.
    @{ Name = 'embed_skills';             Script = "$cockpit\embed_skills.py";             Args = @('index') }
    # v15.3.5: parallel sync for the agents catalog (~25-50 .md files under
    # ~/.claude/agents). Same model already warm from embed_skills, so
    # incremental cost is ~50-100ms. Required for the auto-recall agent
    # suggestion path (semantic match against ultron_agents collection).
    @{ Name = 'embed_agents';             Script = "$cockpit\embed_agents.py";             Args = @('index') }
    # v15.0b WS6: regenerate the unified skills registry (~/.ultron/skills/registry.json)
    # from live disk state (active 46 + vault 334 + plugin) — SSOT go-forward. Cheap (~1s).
    @{ Name = 'skill_vault_registry';     Script = "$cockpit\skill_vault.py";              Args = @('registry') }
    # v14.8 P2A: refresh system snapshot so the TUI Dashboard reads the
    # latest state on next session. --skip-doctor keeps it under ~3s
    # (full doctor invocation costs ~30s and Phase A has a 30s ceiling).
    @{ Name = 'system_snapshot';          Script = "$cockpit\system_snapshot.py";          Args = @('refresh', '--quiet', '--skip-doctor') }
    # v14.8 web auto-publisher: keeps ~/.ultron/web/index.html drift-free
    # (version, test count, indexed notes, release date) using the snapshot
    # written above. Reads the just-written snapshot to substitute markers.
    @{ Name = 'web_publisher';            Script = "$cockpit\web_publisher.py";            Args = @('refresh', '--quiet') }
    # F4 (pre-v15 token efficiency): regenerate MEMORY.md from live state
    # (projects.json + skill_graph.json + brain_index count). Was manually
    # maintained — now auto-generated, ~463 tok vs 990 pre-F4 (-53%).
    @{ Name = 'memory_md_generator';      Script = "$cockpit\memory_md_generator.py";      Args = @('generate') }
)

$phaseAJobs = @()
foreach ($job in $phaseAScripts) {
    if (-not (Test-Path $job.Script)) {
        Write-Log "phase-A skip $($job.Name): script not found"
        continue
    }
    $started = Start-Job -Name "ultron-$($job.Name)" -ArgumentList $job.Script, $job.Args, $useUv -ScriptBlock {
        param($Script, $ScriptArgs, $UseUv)
        if ($UseUv) { & uv run python $Script @ScriptArgs 2>&1 }
        else        { & python $Script @ScriptArgs 2>&1 }
    }
    $phaseAJobs += @{ Job = $started; Name = $job.Name }
}

if ($phaseAJobs.Count -gt 0) {
    $phaseAStart = Get-Date
    $allDone = Wait-Job -Job $phaseAJobs.Job -Timeout 30
    $phaseAElapsed = [int]((Get-Date) - $phaseAStart).TotalSeconds
    # Scripts that report a structured `qdrant_unreachable` field in stdout
    # when Qdrant is down. We surface that as a distinct log status so the
    # silent-desync class of bug stays visible.
    $qdrantSensitive = @('embed_vault', 'embed_skills', 'embed_agents')
    foreach ($entry in $phaseAJobs) {
        $j = $entry.Job
        if ($j.State -eq 'Completed') {
            $output = $null
            if ($entry.Name -in $qdrantSensitive) {
                $output = (Receive-Job -Job $j -ErrorAction SilentlyContinue) -join "`n"
            }
            if ($output -and $output -match '"qdrant_unreachable":\s*true') {
                Write-Log "phase-A $($entry.Name) qdrant-down (state intact)"
            } else {
                Write-Log "phase-A $($entry.Name) ok"
            }
        } elseif ($j.State -eq 'Running') {
            Stop-Job -Job $j -ErrorAction SilentlyContinue
            Write-Log "phase-A $($entry.Name) TIMEOUT"
            # v15.5.14 Task 4a: chronic Qdrant drift surfaces via alerts bus.
            # Best-effort; never block Stop on alert publish failure.
            if ($entry.Name -in $qdrantSensitive) {
                try {
                    $alertsScript = "$env:USERPROFILE\.ultron\scripts\cockpit\alerts.py"
                    if (Test-Path $alertsScript) {
                        $alertArgs = @(
                            'publish',
                            '--source', 'qdrant.health',
                            '--severity', 'warn',
                            '--message', "$($entry.Name) TIMEOUT in stop-memory-sync"
                        )
                        if ($useUv) { & uv run python $alertsScript @alertArgs 2>&1 | Out-Null }
                        else        { & python $alertsScript @alertArgs 2>&1 | Out-Null }
                    }
                } catch { <# best-effort alert publish; ignore failures #> }
            }
        } else {
            Write-Log "phase-A $($entry.Name) state=$($j.State)"
        }
        Remove-Job -Job $j -Force -ErrorAction SilentlyContinue
    }
    Write-Log "phase-A parallel batch elapsed=${phaseAElapsed}s jobs=$($phaseAJobs.Count)"
}

# ── context_primer — regenerate context.md for next session wake-up ──────────
# Always runs after Phase A (cheap local read ≤1s). Ensures that the next
# SessionStart has a fresh context.md ≤400 tokens without waiting for the
# SessionStart hook to prime it (which would delay session open).
$primerScript = "$env:USERPROFILE\.ultron\scripts\cockpit\context_primer.py"
if (Test-Path $primerScript) {
    $primerJob = Start-Job -Name 'ultron-stop-primer' -ArgumentList $primerScript, $useUv -ScriptBlock {
        param($Script, $UseUv)
        if ($UseUv) { & uv run python $Script generate 2>&1 }
        else        { & python $Script generate 2>&1 }
    }
    if ($null -eq (Wait-Job -Job $primerJob -Timeout 8)) {
        Stop-Job -Job $primerJob -ErrorAction SilentlyContinue
        Write-Log "context_primer TIMEOUT after 8s"
    } else {
        Write-Log "context_primer state=$($primerJob.State)"
    }
    Remove-Job -Job $primerJob -Force -ErrorAction SilentlyContinue
}

# ── Phase B — HIGH/ULTRA/LEARN only (expensive: git + Codex API) ──────────────

# Skip vault ops if memory_sync.py is missing
if (-not (Test-Path $syncScript)) {
    Write-Log "skip phase-B: memory_sync.py not found"
    exit 0
}

# Skip vault ops if vault doesn't exist (not migrated)
if (-not (Test-Path $vault)) {
    Write-Log "skip phase-B: vault not found"
    exit 0
}

$shouldPush = Invoke-PyScript $syncScript "should-push"
if ($LASTEXITCODE -ne 0) {
    Write-Log "skip phase-B: session not HIGH+ (brain_index + decay ran in phase-A)"
    exit 0
}

# Vault sync: stage + commit dirty files
$syncOut = Invoke-PyScript $syncScript "sync"
Write-Log "vault sync exit=$LASTEXITCODE launcher=$(if($useUv){'uv'}else{'python'})"

# (consistency_check moved to Phase A parallel batch — Sprint 3 OPS-01 refactor)

# Push async (fire-and-forget, failures enqueued for SessionStart retry)
$hasRemote = & git -C $vault remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $hasRemote) {
    $pushOut = Invoke-PyScript $syncScript "push-async"
    Write-Log "push-async exit=$LASTEXITCODE"
}

# Session compactor — synthesize transcript into vault note via Codex (~3-8K tokens).
# Wrapped in Start-Job + Wait-Job -Timeout 60 to prevent Stop hook hang on Codex
# API slow/down (Sprint 1.3 repo-evaluator TOTAL v2 2026-05-03 — H-CRIT-1 closure).
# When the Stop hook receives the real CC session_id via stdin, pass it directly
# so find_transcript uses UUID match instead of the "most recent .jsonl" fallback.
$compactorScript = "$cockpit\session_compactor.py"
if (Test-Path $compactorScript) {
    $compactorJob = Start-Job -Name 'ultron-compactor' -ArgumentList $compactorScript, $stdinSessionId, $useUv -ScriptBlock {
        param($Script, $Sid, $UseUv)
        if ($Sid) {
            if ($UseUv) {
                & uv run python $Script run --session-id $Sid 2>&1
            } else {
                & python $Script run --session-id $Sid 2>&1
            }
        } else {
            if ($UseUv) {
                & uv run python $Script auto 2>&1
            } else {
                & python $Script auto 2>&1
            }
        }
        return $LASTEXITCODE
    }
    $finished = Wait-Job -Job $compactorJob -Timeout 60
    if ($null -eq $finished) {
        Stop-Job -Job $compactorJob -ErrorAction SilentlyContinue
        Remove-Job -Job $compactorJob -Force -ErrorAction SilentlyContinue
        Write-Log "session_compactor TIMEOUT after 60s sid=$(if($stdinSessionId){$stdinSessionId.Substring(0,[Math]::Min(8,$stdinSessionId.Length))}else{'fallback'})"
    } else {
        $compactorExit = Receive-Job -Job $compactorJob -ErrorAction SilentlyContinue | Select-Object -Last 1
        Remove-Job -Job $compactorJob -Force -ErrorAction SilentlyContinue
        Write-Log "session_compactor exit=$compactorExit sid=$(if($stdinSessionId){$stdinSessionId.Substring(0,[Math]::Min(8,$stdinSessionId.Length))}else{'fallback'})"
    }
}

# Sprint 4 F15: Generate token-friendly session highlight from compactor output,
# then prime recent-highlights.json so next SessionStart can surface them.
# Both are cheap (parse markdown, no API calls) — combined timeout 10s.
$highlightsScript = "$cockpit\session_highlights.py"
if (Test-Path $highlightsScript) {
    $hlJob = Start-Job -Name 'ultron-highlights' -ArgumentList $highlightsScript, $useUv -ScriptBlock {
        param($Script, $UseUv)
        if ($UseUv) {
            & uv run python $Script extract-recent --limit 3 2>&1
            & uv run python $Script prime --max 5 2>&1
        } else {
            & python $Script extract-recent --limit 3 2>&1
            & python $Script prime --max 5 2>&1
        }
    }
    if ($null -eq (Wait-Job -Job $hlJob -Timeout 10)) {
        Stop-Job -Job $hlJob -ErrorAction SilentlyContinue
        Write-Log "session_highlights TIMEOUT after 10s"
    } else {
        Write-Log "session_highlights state=$($hlJob.State)"
    }
    Remove-Job -Job $hlJob -Force -ErrorAction SilentlyContinue
}

# S3-B: Token usage log for this session. Fail-soft.
try {
    $tokenLog = "$env:USERPROFILE\.ultron\.tmp\token-usage.jsonl"
    $today = Get-Date -Format 'yyyy-MM-dd'
    $summary = [ordered]@{
        ts    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        event = "session_end"
        date  = $today
    } | ConvertTo-Json -Compress
    if (-not (Test-Path (Split-Path $tokenLog))) {
        New-Item -ItemType Directory -Path (Split-Path $tokenLog) -Force `
            -ErrorAction SilentlyContinue | Out-Null
    }
    Add-Content -Path $tokenLog -Value $summary -Encoding UTF8 `
        -ErrorAction SilentlyContinue
} catch { }

# ── S5-B: weekly auto-doctor (opt-in) ────────────────────────────────────────
# Reads ~/.ultron/config/doctor-rules.yaml for `auto_doctor: true`. When
# enabled AND >7 days since the last run, fire `doctor.py --quiet --json`
# in a background Start-Job with a 30s budget. Output goes to
# ~/.ultron/.tmp/doctor-weekly.json. Never blocks Stop.
try {
    $rulesPath  = "$env:USERPROFILE\.ultron\config\doctor-rules.yaml"
    $lastRun    = "$env:USERPROFILE\.ultron\.tmp\doctor-last-run.txt"
    $autoDoctor = $false
    if (Test-Path $rulesPath) {
        # Cheap regex parse — avoids requiring a YAML module in the hook.
        $match = Select-String -Path $rulesPath -Pattern '^\s*auto_doctor\s*:\s*(true|false)\s*$' `
            -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($match) {
            $autoDoctor = ($match.Matches[0].Groups[1].Value.ToLower() -eq 'true')
        }
    }
    if ($autoDoctor) {
        $shouldRun = $true
        if (Test-Path $lastRun) {
            try {
                $tsRaw = Get-Content $lastRun -Raw -ErrorAction SilentlyContinue
                if ($tsRaw) {
                    $last = [datetime]::Parse($tsRaw.Trim())
                    if (((Get-Date) - $last).TotalDays -lt 7) {
                        $shouldRun = $false
                    }
                }
            } catch { <# bad timestamp file - run again to reset it #> }
        }
        if ($shouldRun) {
            $doctorScript = "$cockpit\doctor.py"
            if (Test-Path $doctorScript) {
                $docJob = Start-Job -Name 'ultron-doctor-weekly' `
                    -ArgumentList $doctorScript, $useUv -ScriptBlock {
                        param($Script, $UseUv)
                        if ($UseUv) {
                            & uv run python $Script --quiet --json 2>&1
                        } else {
                            & python $Script --quiet --json 2>&1
                        }
                    }
                if ($null -eq (Wait-Job -Job $docJob -Timeout 30)) {
                    Stop-Job -Job $docJob -ErrorAction SilentlyContinue
                    Write-Log "doctor weekly TIMEOUT after 30s"
                } else {
                    Receive-Job -Job $docJob | Out-Null
                    Write-Log "doctor weekly state=$($docJob.State)"
                    # Stamp the last-run timestamp regardless — a TIMEOUT
                    # shouldn't make us retry every Stop until 30s of work
                    # finishes; reset on success only.
                    if ($docJob.State -eq 'Completed') {
                        try {
                            $lastRunDir = Split-Path $lastRun
                            if (-not (Test-Path $lastRunDir)) {
                                New-Item -ItemType Directory -Path $lastRunDir -Force `
                                    -ErrorAction SilentlyContinue | Out-Null
                            }
                            (Get-Date -Format 'o') | Out-File -FilePath $lastRun `
                                -Encoding utf8 -Force -ErrorAction SilentlyContinue
                        } catch { }
                    }
                }
                Remove-Job -Job $docJob -Force -ErrorAction SilentlyContinue
            }
        }
    }
} catch {
    Write-Log "doctor weekly exception: $($_.Exception.Message)"
}

# Always succeed — never block Stop event
exit 0


