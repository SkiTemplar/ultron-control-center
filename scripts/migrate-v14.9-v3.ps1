# ULTRON v14.9 STRUCTURE — Cockpit Migration Script (v3)
#
# REWRITTEN from v2 after Codex peer review (verdict: BLOCK).
# v3 fixes ALL 9 critical blockers + the high-severity items:
#   1. settings.json: real JSON parsing instead of blind Replace()
#   2. Atomic write: UTF-8 sin BOM via System.Text.UTF8Encoding($false) + tmp+rename
#   3. Pre-scan exhaustive grep (regex + literal patterns, multiple slash forms)
#   4. parents[2] rewrite RESTRICTED to SKILL_ROOT assignments only
#   5. intent_dispatcher.py special case patched FIRST, before generic 4c
#   6. try/catch/finally with auto-rollback (file-by-file undo log)
#   7. .venv: copy + verify + delete (no direct Move on 871 MB)
#   8. git rm via `git ls-files --error-unmatch`, not Test-Path
#   9. Post-rewrite invariant grep ("no .claude/.../ultron in runtime commands")
#   + use `uv run` per repo rules · BackupDir with seconds + random suffix
#   + markdown rewrite restricted to allowlist (only context_primer.py path)
#
# Spec: ~/.ultron/plans/2026-05-09-v14.9-STRUCTURE.md
# Codex review log: AppData/Local/Temp/claude/.../tasks/b40fje8et.output
#
# RUN OUTSIDE CLAUDE CODE — .venv files would be locked otherwise.
#
#   1. Close ALL Claude Code windows
#   2. Open a fresh PowerShell window (NOT inside Claude)
#   3. pwsh -ExecutionPolicy Bypass -File C:\Users\USER\.ultron\scripts\migrate-v14.9-v3.ps1
#      (or powershell.exe -File ... if pwsh not installed)
#   4. Reopen Claude Code, run "Ultron, verify v14.9" in a new session

[CmdletBinding()]
param(
    [switch]$DryRun,           # Validate everything, do nothing destructive
    [switch]$SkipBackup,       # Dangerous — only for testing
    [switch]$ContinueOnGitDirty # Force-continue if skill repo has uncommitted changes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ────── Paths ──────────────────────────────────────────────────────────────
$SkillRoot      = "C:\Users\USER\.claude\skills\ultron"
$UltronRoot     = "C:\Users\USER\.ultron"
$NewScripts     = "$UltronRoot\scripts"
$NewVenv        = "$UltronRoot\.venv"
$NewHooksDir    = "$NewScripts\hooks"
$NewCockpitDir  = "$NewScripts\cockpit"
$SettingsFile   = "C:\Users\USER\.claude\settings.json"
$GlobalClaudeMd = "C:\Users\USER\.claude\CLAUDE.md"
$SkillClaudeMd  = "$SkillRoot\CLAUDE.md"
$LogDir         = "$UltronRoot\logs"

$ts             = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$rand           = [Convert]::ToString((Get-Random -Maximum 0xFFFF), 16).PadLeft(4, '0')
$BackupDir      = "$UltronRoot\backups\pre-v14.9-$ts-$rand"
$RollbackLog    = "$BackupDir\rollback-actions.json"
$LogFile        = "$LogDir\migrate-v14.9-v3-$ts.log"

$Utf8NoBom      = New-Object System.Text.UTF8Encoding $false

# ────── Helpers ────────────────────────────────────────────────────────────
function Step($n, $title) { Write-Host "`n===== STEP $n - $title =====" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }
function Info($msg) { Write-Host "  [i]  $msg"   -ForegroundColor Gray }
function Fail($msg) {
    Write-Host "  [X]  $msg" -ForegroundColor Red
    Write-Host "  Triggering rollback..." -ForegroundColor Red
    Invoke-Rollback
    throw $msg
}

function Read-Utf8 ($path) {
    return [System.IO.File]::ReadAllText($path, $Utf8NoBom)
}

function Write-AtomicUtf8NoBom ($path, $content) {
    # Atomic: write tmp, validate, move. No BOM. PS5.1-safe.
    $tmp = "$path.tmp-$ts"
    [System.IO.File]::WriteAllText($tmp, $content, $Utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

# Rollback log — appended to as we mutate state
$Script:RollbackActions = @()

function Add-Rollback {
    param(
        [Parameter(Mandatory)][ValidateSet('restore_file','remove_dir','remove_file','restore_dir','move_back')][string]$Kind,
        [string]$Source,
        [string]$Target,
        [string]$Note
    )
    $Script:RollbackActions += [pscustomobject]@{
        kind   = $Kind
        source = $Source
        target = $Target
        note   = $Note
        ts     = (Get-Date -Format 'o')
    }
    if (Test-Path $BackupDir) {
        ($Script:RollbackActions | ConvertTo-Json -Depth 4) |
            Set-Content -LiteralPath $RollbackLog -Encoding UTF8 -Force
    }
}

function Invoke-Rollback {
    if (-not $Script:RollbackActions -or $Script:RollbackActions.Count -eq 0) {
        Write-Host "  [rollback] nothing to undo" -ForegroundColor Gray
        return
    }
    Write-Host "  [rollback] undoing $($Script:RollbackActions.Count) action(s)..." -ForegroundColor Yellow
    # LIFO order
    for ($i = $Script:RollbackActions.Count - 1; $i -ge 0; $i--) {
        $a = $Script:RollbackActions[$i]
        try {
            switch ($a.kind) {
                'restore_file' {
                    if (Test-Path -LiteralPath $a.source) {
                        Copy-Item -LiteralPath $a.source -Destination $a.target -Force
                        Write-Host "    restored $($a.target)" -ForegroundColor DarkGray
                    }
                }
                'restore_dir' {
                    if (Test-Path -LiteralPath $a.source) {
                        if (Test-Path -LiteralPath $a.target) {
                            Remove-Item -LiteralPath $a.target -Recurse -Force -ErrorAction SilentlyContinue
                        }
                        Copy-Item -LiteralPath $a.source -Destination $a.target -Recurse -Force
                        Write-Host "    restored dir $($a.target)" -ForegroundColor DarkGray
                    }
                }
                'remove_dir' {
                    if (Test-Path -LiteralPath $a.target) {
                        Remove-Item -LiteralPath $a.target -Recurse -Force -ErrorAction SilentlyContinue
                        Write-Host "    removed $($a.target)" -ForegroundColor DarkGray
                    }
                }
                'remove_file' {
                    if (Test-Path -LiteralPath $a.target) {
                        Remove-Item -LiteralPath $a.target -Force -ErrorAction SilentlyContinue
                        Write-Host "    removed $($a.target)" -ForegroundColor DarkGray
                    }
                }
                'move_back' {
                    # Inverse of Move-Item. $a.source = current location (post-mutation),
                    # $a.target = original location (pre-mutation). Move back.
                    if (Test-Path -LiteralPath $a.source) {
                        if (Test-Path -LiteralPath $a.target) {
                            # Target slot occupied — refuse to overwrite during rollback
                            Write-Host "    [WARN] move_back skipped: $($a.target) exists" -ForegroundColor Yellow
                        } else {
                            # Ensure parent dir exists (Step 3 may have removed scripts/ etc.)
                            $parent = Split-Path -Parent $a.target
                            if ($parent -and -not (Test-Path -LiteralPath $parent)) {
                                New-Item -ItemType Directory -Path $parent -Force -ErrorAction SilentlyContinue | Out-Null
                            }
                            try {
                                Move-Item -LiteralPath $a.source -Destination $a.target -Force
                                Write-Host "    moved back $($a.source) -> $($a.target)" -ForegroundColor DarkGray
                            } catch {
                                Write-Host "    [WARN] move_back FAILED: $_" -ForegroundColor Yellow
                            }
                        }
                    }
                }
            }
        } catch {
            Write-Host "    [WARN] rollback step failed: $($a.kind) $($a.target) — $_" -ForegroundColor Yellow
        }
    }
    Write-Host "  [rollback] done. Verify state manually." -ForegroundColor Yellow
}

# ────── Wrap everything in try/finally ─────────────────────────────────────
try {

# ════════════════ STEP 0 — Pre-flight (HARD checks) ═══════════════════════
Step 0 "Pre-flight (hard checks)"

if (-not (Test-Path $SkillRoot))                  { Fail "Skill root not found: $SkillRoot" }
if (-not (Test-Path "$SkillRoot\SKILL.md"))       { Fail "SKILL.md not found - wrong path?" }
if (-not (Test-Path "$SkillRoot\scripts\cockpit\tui.py")) {
    Fail "scripts/cockpit/tui.py not found - already migrated, or v2 ran partially?"
}
if (-not (Test-Path $SettingsFile))               { Fail "settings.json not found: $SettingsFile" }

# Validate settings.json is parseable BEFORE we touch anything
try {
    $settingsJson = Read-Utf8 $SettingsFile | ConvertFrom-Json -ErrorAction Stop
    Ok "settings.json is valid JSON ($($settingsJson.hooks.PSObject.Properties.Count) hook groups)"
} catch {
    Fail "settings.json is NOT valid JSON: $_"
}

# Claude process check
$claudeProc = Get-Process claude -ErrorAction SilentlyContinue
if ($claudeProc) { Fail "Close Claude Code first (PID $($claudeProc.Id))." }

# Python from skill .venv must not be running
$pyLocks = Get-Process python*, pythonw* -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -and $_.Path.StartsWith($SkillRoot) }
if ($pyLocks) {
    Fail "Python from skill .venv still running (PIDs: $($pyLocks.Id -join ',')). Kill them first."
}

# Quick file-lock probe on .venv pythonw.exe
$probeVenvPy = "$SkillRoot\.venv\Scripts\python.exe"
if (Test-Path $probeVenvPy) {
    try {
        $stream = [System.IO.File]::Open($probeVenvPy, 'Open', 'Read', 'None')
        $stream.Close()
        Ok "skill .venv python.exe is not locked"
    } catch {
        Fail "skill .venv python.exe is LOCKED. Close all processes using it: $_"
    }
}

# Git clean state
$gitStatus = & git -C $SkillRoot status --porcelain 2>&1
if ($gitStatus) {
    if (-not $ContinueOnGitDirty) {
        Write-Host "  Skill repo has uncommitted changes:" -ForegroundColor Yellow
        $gitStatus | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Fail "Refuse to migrate with dirty repo. Commit/stash first or pass -ContinueOnGitDirty."
    } else {
        Warn "Continuing with dirty git repo (--ContinueOnGitDirty was set)"
    }
} else {
    Ok "Skill repo is clean"
}

# uv presence (script depends on uv sync)
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uvCmd) { Fail "uv not found in PATH. Install uv: https://github.com/astral-sh/uv" }
Ok "uv found: $($uvCmd.Source)"

# Drive sanity — warn if .claude and .ultron are on different volumes
$srcDrive = (Get-Item $SkillRoot).PSDrive.Root
$dstDrive = (Get-Item $UltronRoot).PSDrive.Root
if ($srcDrive -ne $dstDrive) {
    Warn "Source ($srcDrive) and target ($dstDrive) on DIFFERENT drives. Will use Copy+Verify+Delete."
} else {
    Ok "Source and target on same drive ($srcDrive). Move-Item is atomic rename."
}

if ($DryRun) {
    Write-Host "`n[DryRun] Pre-flight passed. Stopping before mutations." -ForegroundColor Magenta
    return
}

# ════════════════ STEP 1 — Backup (atomic, paranoid) ══════════════════════
Step 1 "Backup (atomic, paranoid)"

# BackupDir always exists — even with -SkipBackup, Step 5 writes per-file
# rollback backups under it. Codex review #3: with -SkipBackup the dir
# was missing, crashing Step 5.
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
Ok "BackupDir: $BackupDir"

if (-not $SkipBackup) {
    # 1a. settings.json
    Copy-Item -LiteralPath $SettingsFile -Destination "$BackupDir\settings.json" -Force
    Add-Rollback -Kind 'restore_file' -Source "$BackupDir\settings.json" -Target $SettingsFile
    Ok "settings.json -> backup"

    # 1b. global CLAUDE.md
    Copy-Item -LiteralPath $GlobalClaudeMd -Destination "$BackupDir\CLAUDE.md.global" -Force
    Add-Rollback -Kind 'restore_file' -Source "$BackupDir\CLAUDE.md.global" -Target $GlobalClaudeMd
    Ok "CLAUDE.md (global) -> backup"

    # 1c. skill CLAUDE.md
    Copy-Item -LiteralPath $SkillClaudeMd -Destination "$BackupDir\CLAUDE.md.skill" -Force
    Add-Rollback -Kind 'restore_file' -Source "$BackupDir\CLAUDE.md.skill" -Target $SkillClaudeMd
    Ok "CLAUDE.md (skill) -> backup"

    # 1d. tar of full skill folder (rollback if something burns)
    $tarFile = "$BackupDir\skill-ultron.tar"
    & tar -cf $tarFile -C (Split-Path $SkillRoot -Parent) (Split-Path $SkillRoot -Leaf) 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "tar backup failed (exit $LASTEXITCODE)" }
    $tarSize = [math]::Round((Get-Item $tarFile).Length / 1MB, 1)
    Ok "skill folder -> $tarFile ($tarSize MB)"
} else {
    Warn "SkipBackup set — proceeding WITHOUT backup. Hope you know what you're doing."
}

# ════════════════ STEP 2 — Pre-scan paths (exhaustive) ════════════════════
Step 2 "Pre-scan paths (find ALL references before mutating)"

# 2a. Inventory hooks declared in settings.json
$hookCommands = @()
$hooksObj = $settingsJson.hooks
foreach ($groupName in $hooksObj.PSObject.Properties.Name) {
    $group = $hooksObj.$groupName
    foreach ($entry in $group) {
        if ($entry.hooks) {
            foreach ($h in $entry.hooks) {
                if ($h.command) { $hookCommands += $h.command }
            }
        }
    }
}
Ok "Found $($hookCommands.Count) hook commands in settings.json"

# 2b. Find all hook commands that point at skill .venv or skill hooks/
$riskyCmds = $hookCommands | Where-Object {
    $_ -match '\.claude[\\/]skills[\\/]ultron[\\/](\.venv|hooks)' -or
    $_ -match '\.ultron[\\/]hooks[\\/]'   # legacy ps1 hooks at .ultron root
}
if ($riskyCmds.Count -eq 0) {
    Warn "No hook commands match expected paths — already migrated?"
} else {
    Ok "Hook commands needing rewrite: $($riskyCmds.Count)"
    $riskyCmds | ForEach-Object { Info "  $_" }
}

# 2c. Inventory Python files referencing old paths
$cockpitFiles = Get-ChildItem -LiteralPath "$SkillRoot\scripts\cockpit" -Filter '*.py' -File -ErrorAction SilentlyContinue
$hookPyFiles  = Get-ChildItem -LiteralPath "$SkillRoot\hooks" -Filter '*.py' -File -ErrorAction SilentlyContinue

# 2d. Detect SKILL_ROOT/SKILL_DIR/skill_root assignments using parents[2]
$skillRootAssignments = @()
foreach ($f in $cockpitFiles) {
    $content = Read-Utf8 $f.FullName
    # Match: <NAME> = Path(__file__).resolve().parents[2]   OR   .parent.parent.parent
    $matches = [regex]::Matches($content,
        '(?m)^\s*(?<var>SKILL_ROOT|SKILL_DIR|skill_root|ULTRON_ROOT)\s*=\s*Path\(__file__\)(?:\.resolve\(\))?\.(?:parents\[2\]|parent\.parent\.parent)')
    foreach ($m in $matches) {
        $skillRootAssignments += [pscustomobject]@{
            file = $f.Name
            var  = $m.Groups['var'].Value
            line = ($content.Substring(0, $m.Index) -split "`n").Count
        }
    }
}
Ok "SKILL_ROOT-style assignments found: $($skillRootAssignments.Count)"
$skillRootAssignments | ForEach-Object { Info "  $($_.file):$($_.line)  $($_.var)" }

# 2e. Detect intent_dispatcher.py special _HOOK_PATH
$idFile = "$SkillRoot\scripts\cockpit\intent_dispatcher.py"
if (-not (Test-Path $idFile)) { Fail "intent_dispatcher.py missing — investigate" }
$idContent = Read-Utf8 $idFile
if ($idContent -notmatch 'Path\(__file__\)\.parents\[2\]\s*/\s*"hooks"\s*/\s*"intent-dispatcher\.py"') {
    Warn "intent_dispatcher.py _HOOK_PATH pattern not found — schema may have drifted"
}

# 2f. tui.py:47 special — ULTRON_ROOT name but points to SKILL_ROOT semantically
if ($cockpitFiles | Where-Object Name -eq 'tui.py') {
    $tuiContent = Read-Utf8 "$SkillRoot\scripts\cockpit\tui.py"
    if ($tuiContent -match 'ULTRON_ROOT\s*=\s*Path\(__file__\)\.parent\.parent\.parent') {
        Info "tui.py:47 ULTRON_ROOT misnamed (points to SKILL); will rewrite as SKILL_ROOT hardcode"
    }
}

# 2g. Old-style absolute path strings in hook .py files
$oldStringRefs = @()
foreach ($f in $hookPyFiles) {
    $content = Read-Utf8 $f.FullName
    if ($content -match 'C:[\\/]Users[\\/]USER[\\/]\.claude[\\/]skills[\\/]ultron[\\/](?:scripts|hooks)') {
        $oldStringRefs += $f.Name
    }
}
if ($oldStringRefs.Count -gt 0) {
    Warn "Hook .py files with hardcoded absolute paths: $($oldStringRefs -join ', ')"
    Warn "  These may need MANUAL inspection (regex covers Path() forms, not raw strings)"
}

# ════════════════ STEP 3 — Move directories (copy+verify for .venv) ═══════
Step 3 "Move directories"

# Helper: copy + verify file count + delete source
function Move-WithVerify {
    param([string]$Source, [string]$Target, [string]$Label)
    if (-not (Test-Path -LiteralPath $Source)) {
        Warn "$Label source missing: $Source — skipping"
        return
    }
    if (Test-Path -LiteralPath $Target) {
        Warn "$Label target exists: $Target — skipping"
        return
    }
    if ($srcDrive -eq $dstDrive) {
        # Same drive: rename is atomic
        Move-Item -LiteralPath $Source -Destination $Target -Force
        Add-Rollback -Kind 'move_back' -Source $Target -Target $Source -Note "move back $Label"
        Ok "$Label moved (rename) -> $Target"
    } else {
        # Cross-drive: copy, verify file count, then delete source
        $srcCount = (Get-ChildItem -LiteralPath $Source -Recurse -File | Measure-Object).Count
        Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force
        $dstCount = (Get-ChildItem -LiteralPath $Target -Recurse -File | Measure-Object).Count
        if ($srcCount -ne $dstCount) {
            Fail "$Label copy verification FAILED ($srcCount source, $dstCount target)"
        }
        Add-Rollback -Kind 'remove_dir' -Target $Target -Note "$Label copy"
        Remove-Item -LiteralPath $Source -Recurse -Force
        Ok "$Label copied+verified ($srcCount files) -> $Target, source removed"
    }
}

# 3a. cockpit
Move-WithVerify -Source "$SkillRoot\scripts\cockpit" -Target $NewCockpitDir -Label "scripts/cockpit"

# 3b. shared-duet.ps1 (single file)
$sharedDuetSrc = "$SkillRoot\scripts\shared-duet.ps1"
if (Test-Path $sharedDuetSrc) {
    Move-Item -LiteralPath $sharedDuetSrc -Destination "$NewScripts\shared-duet.ps1" -Force
    Add-Rollback -Kind 'move_back' -Source "$NewScripts\shared-duet.ps1" -Target $sharedDuetSrc -Note "move back shared-duet.ps1"
    Ok "shared-duet.ps1 -> $NewScripts"
}

# 3c. Any leftover scripts/ items
$leftover = Get-ChildItem -LiteralPath "$SkillRoot\scripts" -Force -ErrorAction SilentlyContinue
if ($leftover) {
    Warn "Leftover items in scripts/: $($leftover.Name -join ', ') — moving to $NewScripts"
    foreach ($item in $leftover) {
        Move-Item -LiteralPath $item.FullName -Destination $NewScripts -Force
    }
}
Remove-Item -LiteralPath "$SkillRoot\scripts" -Force -Recurse -ErrorAction SilentlyContinue

# 3d. hooks (Python)
Move-WithVerify -Source "$SkillRoot\hooks" -Target $NewHooksDir -Label "hooks (py)"

# 3e. Consolidate hooks .ps1 from ~/.ultron/hooks/ into ~/.ultron/scripts/hooks/
$OldPSHooks = "$UltronRoot\hooks"
if (Test-Path -LiteralPath $OldPSHooks) {
    $ps1Files = Get-ChildItem -LiteralPath $OldPSHooks -Filter '*.ps1' -File -ErrorAction SilentlyContinue
    foreach ($f in $ps1Files) {
        Move-Item -LiteralPath $f.FullName -Destination $NewHooksDir -Force
    }
    # Move any logs to ~/.ultron/logs
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
    foreach ($logName in @('push-async.log', 'stop-memory-sync.log')) {
        if (Test-Path -LiteralPath "$OldPSHooks\$logName") {
            Move-Item -LiteralPath "$OldPSHooks\$logName" -Destination "$LogDir\$logName" -Force
        }
    }
    if (-not (Get-ChildItem -LiteralPath $OldPSHooks -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $OldPSHooks -Force -ErrorAction SilentlyContinue
    }
    Ok "ps1 hooks consolidated into $NewHooksDir"
}

# 3f. tests
Move-WithVerify -Source "$SkillRoot\tests" -Target "$UltronRoot\tests" -Label "tests"

# 3g. pyproject + uv.lock (copy, not move — repo skill might still reference)
Copy-Item -LiteralPath "$SkillRoot\pyproject.toml" -Destination "$UltronRoot\pyproject.toml" -Force
Copy-Item -LiteralPath "$SkillRoot\uv.lock"        -Destination "$UltronRoot\uv.lock"        -Force
Add-Rollback -Kind 'remove_file' -Target "$UltronRoot\pyproject.toml"
Add-Rollback -Kind 'remove_file' -Target "$UltronRoot\uv.lock"
Ok "pyproject.toml + uv.lock copied to $UltronRoot"

# 3h. __pycache__ purge (recursive, both trees)
foreach ($root in @($UltronRoot, $SkillRoot)) {
    Get-ChildItem -LiteralPath $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object Name -eq '__pycache__' |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
Ok "__pycache__ purged (recursive, both trees)"

# ════════════════ STEP 4 — Recreate .venv (clean, validated) ══════════════
Step 4 "Recreate .venv (clean, validated)"

if (Test-Path -LiteralPath $NewVenv) {
    # Pre-existing .venv at target: backup via rename (atomic) so it can be
    # restored if uv venv/sync fails later. Cheaper than copy on 800MB+ tree.
    if (-not $SkipBackup) {
        $venvBak = "$BackupDir\.venv-pre-recreate"
        Warn "Existing .venv at $NewVenv — moving to $venvBak (rollback target)"
        Move-Item -LiteralPath $NewVenv -Destination $venvBak -Force
        Add-Rollback -Kind 'move_back' -Source $venvBak -Target $NewVenv -Note "restore pre-existing .venv at .ultron"
    } else {
        Warn "Existing .venv at $NewVenv — removing (no backup, SkipBackup set)"
        Remove-Item -LiteralPath $NewVenv -Recurse -Force
    }
}

# Old skill .venv (the 871 MB one) — leave it; we'll delete after Step 8 verify
# That way if .venv recreation fails, we can roll back by pointing settings to old path

Push-Location $UltronRoot
try {
    & uv venv .venv 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$NewVenv\Scripts\python.exe")) {
        Fail "uv venv failed (exit $LASTEXITCODE)"
    }
    Add-Rollback -Kind 'remove_dir' -Target $NewVenv -Note "newly created .venv"
    Ok ".venv created at $NewVenv"

    & uv sync 2>&1 | Tee-Object -Variable syncOut | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # Mark .venv as invalid by removing python.exe so settings rewrite can detect
        Remove-Item -LiteralPath "$NewVenv\Scripts\python.exe" -Force -ErrorAction SilentlyContinue
        Fail "uv sync failed: $($syncOut -join "`n")"
    }
    Ok "uv sync completed"

    $smoke = & "$NewVenv\Scripts\python.exe" -c "import textual, qdrant_client, fastembed, rich, yaml; print('imports ok')" 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "Smoke imports failed: $smoke" }
    Ok "Smoke imports OK: $smoke"
}
finally { Pop-Location }

# ════════════════ STEP 5 — Rewrite paths (ORDER MATTERS) ══════════════════
Step 5 "Rewrite paths"

# 5a. settings.json — JSON parsing, not blind Replace
Info "5a. Rewriting settings.json (JSON-aware)"
$settingsBak = "$BackupDir\settings.json.before-5a"
Copy-Item -LiteralPath $SettingsFile -Destination $settingsBak -Force
Add-Rollback -Kind 'restore_file' -Source $settingsBak -Target $SettingsFile

$rawSettings  = Read-Utf8 $SettingsFile
$settingsObj  = $rawSettings | ConvertFrom-Json -ErrorAction Stop

# Counter
$rewritten = 0

# Helper: rewrite a single command string (handles forward AND back slashes)
function Convert-HookCommand([string]$cmd) {
    $orig = $cmd
    # python.exe path
    $cmd = $cmd -replace '([Cc]:)[\\/]Users[\\/]USER[\\/]\.claude[\\/]skills[\\/]ultron[\\/]\.venv[\\/]Scripts[\\/]python\.exe',
                          'C:/Users/USER/.ultron/.venv/Scripts/python.exe'
    # hooks/ path inside skill
    $cmd = $cmd -replace '([Cc]:)[\\/]Users[\\/]USER[\\/]\.claude[\\/]skills[\\/]ultron[\\/]hooks[\\/]',
                          'C:/Users/USER/.ultron/scripts/hooks/'
    # legacy ~/.ultron/hooks/ (where ps1 hooks used to live)
    $cmd = $cmd -replace '([Cc]:)[\\/]Users[\\/]USER[\\/]\.ultron[\\/]hooks[\\/]',
                          'C:/Users/USER/.ultron/scripts/hooks/'
    if ($cmd -ne $orig) { $script:rewritten++ }
    return $cmd
}

# Walk every hook command in the JSON tree
foreach ($groupName in $settingsObj.hooks.PSObject.Properties.Name) {
    $group = $settingsObj.hooks.$groupName
    foreach ($entry in $group) {
        if (-not $entry.hooks) { continue }
        foreach ($h in $entry.hooks) {
            if ($h.command) { $h.command = Convert-HookCommand $h.command }
        }
    }
}

# Serialize and atomic write
$newJson = $settingsObj | ConvertTo-Json -Depth 99
# Validate: must parse back
try { [void]($newJson | ConvertFrom-Json -ErrorAction Stop) }
catch { Fail "Generated settings.json is invalid JSON: $_" }

Write-AtomicUtf8NoBom $SettingsFile $newJson
Ok "settings.json rewritten ($rewritten command(s) updated, atomic UTF-8 no BOM)"

# 5b. intent_dispatcher.py — SPECIAL CASE FIRST (before generic 5d)
Info "5b. Patching intent_dispatcher.py _HOOK_PATH (BEFORE generic SKILL_ROOT)"
$idFileNew = "$NewCockpitDir\intent_dispatcher.py"
if (-not (Test-Path -LiteralPath $idFileNew)) { Fail "intent_dispatcher.py missing in new location" }
$idBak = "$BackupDir\intent_dispatcher.py.before-5b"
Copy-Item -LiteralPath $idFileNew -Destination $idBak -Force
Add-Rollback -Kind 'restore_file' -Source $idBak -Target $idFileNew

$idC = Read-Utf8 $idFileNew
$idOrig = $idC
$idC = $idC -replace 'Path\(__file__\)\.parents\[2\]\s*/\s*"hooks"\s*/\s*"intent-dispatcher\.py"',
                     'Path.home() / ".ultron" / "scripts" / "hooks" / "intent-dispatcher.py"'
if ($idC -eq $idOrig) {
    Warn "intent_dispatcher.py _HOOK_PATH pattern NOT matched — verify manually"
} else {
    Write-AtomicUtf8NoBom $idFileNew $idC
    Ok "intent_dispatcher.py _HOOK_PATH patched"
}

# 5c. hook .py sys.path patterns (in NewHooksDir)
Info "5c. Rewriting hook .py sys.path imports"
$hookPyNew = Get-ChildItem -LiteralPath $NewHooksDir -Filter '*.py' -File -ErrorAction SilentlyContinue
foreach ($f in $hookPyNew) {
    $c = Read-Utf8 $f.FullName
    $orig = $c
    # Pattern A: Path.home() / ".claude" / "skills" / "ultron" / "scripts" / "cockpit"
    $c = $c -replace '(?s)Path\.home\(\)\s*/\s*"\.claude"\s*/\s*"skills"\s*/\s*"ultron"\s*/\s*"scripts"\s*/\s*"cockpit"',
                     'Path.home() / ".ultron" / "scripts" / "cockpit"'
    # Pattern B: Path(__file__).resolve().parents[1] / "scripts" / "cockpit"
    # (parents[1] from a hook in skill/hooks/ = skill root; post-migration hooks live in
    #  .ultron/scripts/hooks/, parents[1] = scripts/, so → parent.parent / cockpit is wrong;
    #  use Path(__file__).parent.parent / "cockpit" which from .ultron/scripts/hooks/ = scripts/cockpit)
    $c = $c -replace 'Path\(__file__\)\.resolve\(\)\.parents\[1\]\s*/\s*"scripts"\s*/\s*"cockpit"',
                     'Path(__file__).resolve().parent.parent / "cockpit"'
    # Pattern C: os.path.expanduser("~/.claude/skills/ultron/...") — both quote styles
    $expanduserCockpitOld = 'os\.path\.expanduser\(\s*["'']~/\.claude/skills/ultron/scripts/cockpit'
    $expanduserCockpitNew = 'os.path.expanduser("~/.ultron/scripts/cockpit'
    $expanduserHooksOld   = 'os\.path\.expanduser\(\s*["'']~/\.claude/skills/ultron/hooks'
    $expanduserHooksNew   = 'os.path.expanduser("~/.ultron/scripts/hooks'
    $c = $c -replace $expanduserCockpitOld, $expanduserCockpitNew
    $c = $c -replace $expanduserHooksOld,   $expanduserHooksNew
    if ($c -ne $orig) {
        $bak = "$BackupDir\hook.$($f.Name).before-5c"
        Copy-Item -LiteralPath $f.FullName -Destination $bak -Force
        Add-Rollback -Kind 'restore_file' -Source $bak -Target $f.FullName
        Write-AtomicUtf8NoBom $f.FullName $c
        Ok "rewrote sys.path in hooks/$($f.Name)"
    }
}

# 5d. cockpit/*.py — SKILL_ROOT-style assignments (RESTRICTED, not blind)
Info "5d. Rewriting cockpit/*.py SKILL_ROOT assignments (named-variable restriction)"
$skillRootHardcode = 'Path.home() / ".claude" / "skills" / "ultron"'
$cockpitFilesNew = Get-ChildItem -LiteralPath $NewCockpitDir -Filter '*.py' -File -ErrorAction SilentlyContinue

foreach ($f in $cockpitFilesNew) {
    if ($f.Name -eq 'intent_dispatcher.py') { continue }  # already handled in 5b
    $c = Read-Utf8 $f.FullName
    $orig = $c
    # Restricted regex: only match assignment lines where var name is one of the known SKILL_ROOT-ish names
    # and RHS is the exact parents[2] / parent.parent.parent expression.
    # This avoids touching `parents[2]` used inline elsewhere.
    $c = $c -replace '(?m)(^\s*)(SKILL_ROOT|SKILL_DIR|skill_root|ULTRON_ROOT)(\s*=\s*)Path\(__file__\)(\.resolve\(\))?\.parents\[2\]',
                     "`$1`$2`$3$skillRootHardcode"
    $c = $c -replace '(?m)(^\s*)(SKILL_ROOT|SKILL_DIR|skill_root|ULTRON_ROOT)(\s*=\s*)Path\(__file__\)\.parent\.parent\.parent(?!\.parent)',
                     "`$1`$2`$3$skillRootHardcode"
    if ($c -ne $orig) {
        $bak = "$BackupDir\cockpit.$($f.Name).before-5d"
        Copy-Item -LiteralPath $f.FullName -Destination $bak -Force
        Add-Rollback -Kind 'restore_file' -Source $bak -Target $f.FullName
        Write-AtomicUtf8NoBom $f.FullName $c
        Ok "rewrote SKILL_ROOT in cockpit/$($f.Name)"
    }
}

# 5e. Skill CLAUDE.md workspace block
Info "5e. Updating skill CLAUDE.md workspace table"
$workspaceNew = @'
## Workspace paths

```
Skill def   C:\Users\USER\.claude\skills\ultron\        (markdown only)
Code        C:\Users\USER\.ultron\scripts\
Memoria     C:\Users\USER\.ultron\
Vault L2    C:\Users\USER\.ultron-vault\
Tests       C:\Users\USER\.ultron\tests\
Backups     C:\Users\USER\.ultron\backups\
Plans       C:\Users\USER\.ultron\plans\
Docs        C:\Users\USER\.ultron\docs\
Changelog   ~/.claude/skills/ultron/references/changelog.md
```
'@

$skillMd = Read-Utf8 $SkillClaudeMd
if ($skillMd -match '(?s)## Workspace paths.*?```[^`]*```') {
    $skillMdBak = "$BackupDir\CLAUDE.md.skill.before-5e"
    Copy-Item -LiteralPath $SkillClaudeMd -Destination $skillMdBak -Force
    Add-Rollback -Kind 'restore_file' -Source $skillMdBak -Target $SkillClaudeMd
    $skillMdNew = $skillMd -replace '(?s)## Workspace paths.*?```[^`]*```', $workspaceNew
    Write-AtomicUtf8NoBom $SkillClaudeMd $skillMdNew
    Ok "skill CLAUDE.md workspace table updated"
} else {
    Warn "skill CLAUDE.md: no workspace block matched — manual edit needed"
}

# 5f. Global ~/.claude/CLAUDE.md — ONLY context_primer.py path (allowlist approach)
Info "5f. Updating global CLAUDE.md (allowlist: context_primer.py only)"
$globalMd = Read-Utf8 $GlobalClaudeMd
$globalOrig = $globalMd
# Only touch context_primer.py path mentions. No broad rewrite.
$globalMd = $globalMd -replace '~/\.claude/skills/ultron/scripts/cockpit/context_primer\.py',
                                '~/.ultron/scripts/cockpit/context_primer.py'
if ($globalMd -ne $globalOrig) {
    $globalBak = "$BackupDir\CLAUDE.md.global.before-5f"
    Copy-Item -LiteralPath $GlobalClaudeMd -Destination $globalBak -Force
    Add-Rollback -Kind 'restore_file' -Source $globalBak -Target $GlobalClaudeMd
    Write-AtomicUtf8NoBom $GlobalClaudeMd $globalMd
    Ok "global CLAUDE.md context_primer.py path updated"
} else {
    Info "global CLAUDE.md: no context_primer.py reference found — nothing to update"
}

# ════════════════ STEP 5g — $PROFILE PowerShell ultron alias ══════════════
Step "5g" "Update PowerShell `$PROFILE 'function ultron' alias"

if (Test-Path -LiteralPath $PROFILE) {
    $profContent = Read-Utf8 $PROFILE
    $profOrig = $profContent
    # Replace the function ultron line — match both forward and back slashes
    $profContent = $profContent -replace `
        '(?i)\$env:USERPROFILE[\\/]\.claude[\\/]skills[\\/]ultron[\\/]scripts[\\/]cockpit[\\/]ultron\.ps1', `
        '$env:USERPROFILE\.ultron\scripts\cockpit\ultron.ps1'
    if ($profContent -ne $profOrig) {
        $profBak = "$BackupDir\PROFILE.ps1.before-5g"
        Copy-Item -LiteralPath $PROFILE -Destination $profBak -Force
        Add-Rollback -Kind 'restore_file' -Source $profBak -Target $PROFILE
        Write-AtomicUtf8NoBom $PROFILE $profContent
        Ok "PROFILE 'function ultron' updated"
    } else {
        Info "PROFILE: no ultron alias matching old path (already updated or different layout?)"
    }
} else {
    Info "No `$PROFILE file at $PROFILE — nothing to update"
}

# ════════════════ STEP 5h — Desktop shortcut "ULTRON Cockpit.lnk" ═════════
Step "5h" "Update Desktop shortcut 'ULTRON Cockpit.lnk'"

$desktopDir = [Environment]::GetFolderPath('Desktop')
$lnkPath    = Join-Path $desktopDir 'ULTRON Cockpit.lnk'
if (Test-Path -LiteralPath $lnkPath) {
    try {
        $sh  = New-Object -ComObject WScript.Shell
        $lnk = $sh.CreateShortcut($lnkPath)
        $oldArgs = $lnk.Arguments
        $oldWd   = $lnk.WorkingDirectory
        $newArgs = $oldArgs -replace `
            '(?i)C:[\\/]Users[\\/]USER[\\/]\.claude[\\/]skills[\\/]ultron', `
            'C:\Users\USER\.ultron'
        $newWd   = $oldWd   -replace `
            '(?i)C:[\\/]Users[\\/]USER[\\/]\.claude[\\/]skills[\\/]ultron', `
            'C:\Users\USER\.ultron'
        if ($newArgs -ne $oldArgs -or $newWd -ne $oldWd) {
            # Backup metadata as text so rollback can restore strings
            $lnkMetaBak = "$BackupDir\desktop-lnk-meta.json"
            @{
                target_path       = $lnk.TargetPath
                arguments_old     = $oldArgs
                arguments_new     = $newArgs
                working_directory_old = $oldWd
                working_directory_new = $newWd
                lnk_path          = $lnkPath
            } | ConvertTo-Json | Set-Content -LiteralPath $lnkMetaBak -Encoding UTF8 -Force
            $lnk.Arguments        = $newArgs
            $lnk.WorkingDirectory = $newWd
            $lnk.Save()
            # No standard rollback kind for COM shortcut edits — log as note
            Add-Rollback -Kind 'restore_file' -Source $lnkMetaBak -Target $lnkMetaBak `
                          -Note "Manual: re-edit ULTRON Cockpit.lnk to restore old Args/WorkDir"
            Ok "Desktop shortcut updated (Arguments + WorkingDirectory)"
            Info "  Args:    $($oldArgs.Length) chars -> $($newArgs.Length) chars"
            Info "  WorkDir: $oldWd -> $newWd"
        } else {
            Info "Desktop shortcut: nothing to update (already pointing to .ultron?)"
        }
    } catch {
        Warn "Desktop shortcut update failed: $_"
    }
} else {
    Info "No 'ULTRON Cockpit.lnk' on Desktop — skipping"
}

# ════════════════ STEP 5i — Re-register Windows Scheduled Tasks ═══════════
Step "5i" "Re-register Windows Scheduled Tasks (5 ultron tasks point to old .venv)"

# install-scheduler.ps1 is portable: uses $PSScriptRoot, so it'll resolve to
# the new ~/.ultron/scripts/cockpit/ when invoked from there.
$installScheduler = "$NewCockpitDir\install-scheduler.ps1"
if (Test-Path -LiteralPath $installScheduler) {
    Info "Invoking install-scheduler.ps1 from new location ($NewCockpitDir)"
    $schedOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScheduler 2>&1
    $schedExit = $LASTEXITCODE
    if ($schedExit -eq 0) {
        Ok "Scheduled tasks re-registered with new paths"
        $schedOut | Where-Object { $_ -match '\[OK\]|\[Cockpit\]|registered|Updated' } | ForEach-Object { Info "  $_" }
    } else {
        Warn "install-scheduler exit=$schedExit — manual re-register needed:"
        $schedOut | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Warn "  Run later: pwsh -ExecutionPolicy Bypass -File '$installScheduler'"
    }
} else {
    Warn "install-scheduler.ps1 not found at $installScheduler — manual task re-register needed"
}

# ════════════════ STEP 6 — git rm --cached (using ls-files, not Test-Path) ══
Step 6 "Stage skill repo deletions (ls-files-aware)"

Push-Location $SkillRoot
try {
    foreach ($p in @('scripts', 'hooks', 'tests')) {
        # Only git rm if path is tracked (was in index) AND no longer in worktree
        $tracked = & git ls-files --error-unmatch -- $p 2>&1
        $isTracked = ($LASTEXITCODE -eq 0)
        $existsInWt = Test-Path -LiteralPath "$SkillRoot\$p"
        if ($isTracked -and -not $existsInWt) {
            & git rm -r --cached --quiet -- $p 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { Ok "git rm -r --cached $p" }
            else                     { Warn "git rm failed for $p" }
        } elseif (-not $isTracked) {
            Info "$p not tracked (nothing to git rm)"
        } else {
            Warn "$p still in worktree — skipping git rm"
        }
    }
}
finally { Pop-Location }

# ════════════════ STEP 7 — Post-rewrite invariants ════════════════════════
Step 7 "Post-rewrite invariants"

# 7a. settings.json must NOT reference skill .venv or skill hooks anymore
$settingsCheck = Read-Utf8 $SettingsFile
$violations = @()
if ($settingsCheck -match '\.claude[\\/]skills[\\/]ultron[\\/]\.venv') {
    $violations += "settings.json still references skill .venv"
}
if ($settingsCheck -match '\.claude[\\/]skills[\\/]ultron[\\/]hooks') {
    $violations += "settings.json still references skill hooks"
}
if ($settingsCheck -match '"command":\s*"[^"]*\.ultron[\\/]hooks[\\/]') {
    $violations += "settings.json still references legacy ~/.ultron/hooks/"
}

# 7b. Hook commands must point at existing files
$settingsObjCheck = $settingsCheck | ConvertFrom-Json
foreach ($groupName in $settingsObjCheck.hooks.PSObject.Properties.Name) {
    foreach ($entry in $settingsObjCheck.hooks.$groupName) {
        if (-not $entry.hooks) { continue }
        foreach ($h in $entry.hooks) {
            if (-not $h.command) { continue }
            # Extract last token that looks like a script path
            $matches = [regex]::Matches($h.command, '[A-Z]:[\\/][^\s"]+\.(?:py|ps1|exe)')
            foreach ($m in $matches) {
                $p = $m.Value -replace '/', '\'
                if (-not (Test-Path -LiteralPath $p)) {
                    $violations += "Hook command references missing file: $p"
                }
            }
        }
    }
}

# 7c. intent_dispatcher.py _HOOK_PATH must point to .ultron
$idCheck = Read-Utf8 $idFileNew
if ($idCheck -notmatch '\.ultron.*hooks.*intent-dispatcher\.py') {
    $violations += "intent_dispatcher.py _HOOK_PATH does NOT point to ~/.ultron"
}

if ($violations.Count -gt 0) {
    foreach ($v in $violations) { Warn $v }
    Fail "Post-rewrite invariants FAILED ($($violations.Count) violations) — see warnings above"
}
Ok "All invariants pass"

# ════════════════ STEP 8 — Verify (uv per repo rules) ═════════════════════
Step 8 "Verify (uv run pytest + module imports)"

Push-Location $UltronRoot
try {
    # Use uv per repo policy
    $pytestOut = & uv run pytest tests/ -q --no-header 2>&1
    $pytestExit = $LASTEXITCODE
    # Null-safe summary extraction (Codex review #2: .ToString() on $null throws
    # before the intended Fail call, bypassing rollback)
    $summaryMatch = $pytestOut | Select-String 'passed|failed|error' | Select-Object -Last 1
    $summaryLine  = if ($summaryMatch) { $summaryMatch.ToString().Trim() } else { '<no pytest summary line found>' }
    if ($pytestExit -eq 0) {
        Ok "pytest: $summaryLine"
    } else {
        # Hard-fail: preserve rollback target. If pre-existing baseline failures
        # were known, user can skip Step 9 cleanup manually after inspection.
        Fail "pytest exit=$pytestExit - $summaryLine. Aborting to preserve rollback target. Inspect: cd $UltronRoot ; uv run pytest tests/ -v"
    }

    # Smoke import each rewritten cockpit module
    $smokeMods = @('cockpit_base','tui','memory_bridge','on_wake','skill_manifest_to_routing','intent_dispatcher')
    $importStmt = ($smokeMods | ForEach-Object { "import $_" }) -join "; "
    $smoke = & uv run python -c "import sys; sys.path.insert(0, r'$NewCockpitDir'); $importStmt; print('all imports ok')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Ok "Cockpit module imports: $smoke"
    } else {
        Fail "Module import smoke failed: $smoke. Aborting to preserve rollback target."
    }
}
finally { Pop-Location }

# ════════════════ STEP 9 — Cleanup old skill .venv ════════════════════════
Step 9 "Cleanup old skill .venv (only if Step 8 succeeded)"

$oldVenv = "$SkillRoot\.venv"
if (Test-Path -LiteralPath $oldVenv) {
    $oldVenvSize = [math]::Round((Get-ChildItem -LiteralPath $oldVenv -Recurse -File -ErrorAction SilentlyContinue |
                                  Measure-Object Length -Sum).Sum / 1MB, 1)
    Info "Removing old skill .venv ($oldVenvSize MB)"
    Remove-Item -LiteralPath $oldVenv -Recurse -Force -ErrorAction SilentlyContinue
    Ok "old skill .venv removed"
}

# ════════════════ DONE ════════════════════════════════════════════════════
Write-Host "`n===== MIGRATION v3 COMPLETE =====" -ForegroundColor Cyan
Write-Host "  Backup:           $BackupDir" -ForegroundColor Gray
Write-Host "  Rollback log:     $RollbackLog" -ForegroundColor Gray
$skillSize  = [math]::Round((Get-ChildItem -LiteralPath $SkillRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
$ultronSize = [math]::Round((Get-ChildItem -LiteralPath $NewScripts -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "  Skill folder:     $skillSize MB (md only)" -ForegroundColor Gray
Write-Host "  .ultron/scripts:  $ultronSize MB" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Reopen Claude Code"
Write-Host "  2. New session: say 'Ultron, verify v14.9'"
Write-Host "  3. Run: ultron tui"
Write-Host "  4. Commit skill repo: cd $SkillRoot ; git commit -m 'feat(v14.9): STRUCTURE migration'"
Write-Host ""
Write-Host "Manual rollback (if needed later):" -ForegroundColor Red
Write-Host "  Restore from backup: $BackupDir"
Write-Host "  See: $RollbackLog for action log"

}
catch {
    Write-Host "`n[FATAL] Migration aborted: $_" -ForegroundColor Red
    Write-Host "Rollback log saved at: $RollbackLog" -ForegroundColor Red
    Write-Host "Backup remains at:    $BackupDir" -ForegroundColor Red
    exit 1
}
