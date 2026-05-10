# ULTRON v14.9 STRUCTURE — Cockpit Migration Script (v2)
#
# Migrates scripts/ + tests/ + hooks/ + .venv/ from ~/.claude/skills/ultron/
# into ~/.ultron/, keeping SKILL.md and other markdown definition in .claude/.
#
# RUN OUTSIDE CLAUDE CODE (so .venv files are not locked).
#
#   1. Close Claude Code completely
#   2. Open a fresh PowerShell window
#   3. pwsh -ExecutionPolicy Bypass -File C:\Users\USER\.ultron\scripts\migrate-v14.9.ps1
#   4. Reopen Claude Code, run `ultron tui` to verify
#
# v2 fixes vs v1:
#   - Rewrites parents[2]/parent.parent.parent in 5+ cockpit scripts
#   - Edits CLAUDE.md (skill) workspace table — not SKILL.md
#   - Edits ~/.claude/CLAUDE.md global for context_primer.py path
#   - git rm -r the moved dirs in skill repo (clean stage)
#   - Detects ultron CLI alias in user $PROFILE and warns
#
# Spec: ~/.ultron/plans/2026-05-09-v14.9-STRUCTURE.md

$ErrorActionPreference = 'Stop'

$SkillRoot     = "C:\Users\USER\.claude\skills\ultron"
$UltronRoot    = "C:\Users\USER\.ultron"
$NewScripts    = "$UltronRoot\scripts"
$NewVenv       = "$UltronRoot\.venv"
$NewHooksDir   = "$NewScripts\hooks"
$NewCockpitDir = "$NewScripts\cockpit"
$BackupDir     = "$UltronRoot\backups\pre-v14.9-$(Get-Date -Format 'yyyy-MM-dd-HHmm')"
$SettingsFile  = "C:\Users\USER\.claude\settings.json"
$GlobalClaudeMd = "C:\Users\USER\.claude\CLAUDE.md"
$SkillClaudeMd = "$SkillRoot\CLAUDE.md"

function Step($n, $title) { Write-Host ""; Write-Host "===== STEP $n - $title =====" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X]  $msg" -ForegroundColor Red; throw $msg }

# ─────────────────────────────────────────────────────────────────────────────
Step 0 "Pre-flight"

if (-not (Test-Path "$SkillRoot\SKILL.md"))           { Fail "Skill root not found: $SkillRoot" }
if (-not (Test-Path "$SkillRoot\scripts\cockpit\tui.py")) { Fail "Skill scripts/cockpit not found - already migrated?" }

$claudeProc = Get-Process claude -ErrorAction SilentlyContinue
if ($claudeProc) { Fail "Close Claude Code first (PID $($claudeProc.Id))." }

$pyLocks = Get-Process python* -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($SkillRoot) }
if ($pyLocks) { Fail "Python from skill .venv still running. Kill them first." }

# Check git clean
$gitStatus = & git -C $SkillRoot status --porcelain 2>&1
if ($gitStatus) {
    Warn "Skill repo has uncommitted changes:"
    $gitStatus | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Warn "Recommend committing first. Continuing anyway in 5s (Ctrl+C to abort)..."
    Start-Sleep 5
} else { Ok "Skill repo clean" }

# Check ultron CLI alias / shortcut
$profileContent = if (Test-Path $PROFILE) { Get-Content $PROFILE -Raw } else { "" }
if ($profileContent -match 'ultron|skills.ultron.scripts.cockpit.ultron\.ps1') {
    Warn "Found 'ultron' reference in `$PROFILE — review after migration:"
    Select-String -Path $PROFILE -Pattern "ultron" | ForEach-Object { Write-Host "    L$($_.LineNumber): $($_.Line.Trim())" -ForegroundColor DarkGray }
}
Ok "Pre-flight OK"

# ─────────────────────────────────────────────────────────────────────────────
Step 1 "Backup"

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
Copy-Item $SettingsFile "$BackupDir\settings.json" -Force
Copy-Item $GlobalClaudeMd "$BackupDir\CLAUDE.md.global" -Force
Copy-Item $SkillClaudeMd  "$BackupDir\CLAUDE.md.skill"  -Force
Ok "settings + CLAUDE.md backups -> $BackupDir"

$tarFile = "$BackupDir\skill-ultron.tar"
& tar -cf $tarFile -C (Split-Path $SkillRoot -Parent) (Split-Path $SkillRoot -Leaf)
if ($LASTEXITCODE -ne 0) { Fail "tar backup failed" }
Ok "skill folder -> $tarFile ($([math]::Round((Get-Item $tarFile).Length/1MB,1)) MB)"

# ─────────────────────────────────────────────────────────────────────────────
Step 2 "Move directories"

if (-not (Test-Path $NewCockpitDir)) {
    Move-Item "$SkillRoot\scripts\cockpit" $NewCockpitDir -Force
    Ok "scripts/cockpit -> $NewCockpitDir"
} else { Warn "scripts/cockpit already at destination - skipping" }

if (Test-Path "$SkillRoot\scripts\shared-duet.ps1") {
    Move-Item "$SkillRoot\scripts\shared-duet.ps1" "$NewScripts\shared-duet.ps1" -Force
    Ok "shared-duet.ps1 -> $NewScripts"
}

# Any other files in skill scripts/?
$leftoverScripts = Get-ChildItem "$SkillRoot\scripts" -ErrorAction SilentlyContinue
if ($leftoverScripts) {
    Warn "Leftover in skill scripts/: $($leftoverScripts.Name -join ', ') - moving to $NewScripts"
    $leftoverScripts | Move-Item -Destination $NewScripts -Force
}
Remove-Item "$SkillRoot\scripts" -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $NewHooksDir)) {
    Move-Item "$SkillRoot\hooks" $NewHooksDir -Force
    Ok "hooks (Python) -> $NewHooksDir"
} else {
    Warn "scripts/hooks already exists - merging"
    Get-ChildItem "$SkillRoot\hooks" | Move-Item -Destination $NewHooksDir -Force
    Remove-Item "$SkillRoot\hooks" -Force
}

# Move PowerShell hooks from ~/.ultron/hooks/ to consolidated location
$OldPSHooks = "$UltronRoot\hooks"
if (Test-Path $OldPSHooks) {
    Get-ChildItem "$OldPSHooks\*.ps1" -ErrorAction SilentlyContinue | Move-Item -Destination $NewHooksDir -Force
    foreach ($log in @('push-async.log','stop-memory-sync.log')) {
        if (Test-Path "$OldPSHooks\$log") { Move-Item "$OldPSHooks\$log" "$UltronRoot\logs\$log" -Force }
    }
    Remove-Item $OldPSHooks -Recurse -Force
    Ok "ps1 hooks -> $NewHooksDir, logs -> ~/.ultron/logs"
}

if (-not (Test-Path "$UltronRoot\tests")) {
    Move-Item "$SkillRoot\tests" "$UltronRoot\tests" -Force
    Ok "tests -> $UltronRoot/tests"
}

Copy-Item "$SkillRoot\pyproject.toml" "$UltronRoot\pyproject.toml" -Force
Copy-Item "$SkillRoot\uv.lock"        "$UltronRoot\uv.lock"        -Force
Ok "pyproject.toml + uv.lock copied to $UltronRoot"

# Clean __pycache__ everywhere
foreach ($root in @($UltronRoot, $SkillRoot)) {
    Get-ChildItem $root -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
}
Ok "__pycache__ purged"

# ─────────────────────────────────────────────────────────────────────────────
Step 3 "Recreate .venv"

if (Test-Path $NewVenv) { Warn ".venv exists at $NewVenv - removing"; Remove-Item $NewVenv -Recurse -Force }

Push-Location $UltronRoot
try {
    & uv venv .venv 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "uv venv failed" }
    Ok ".venv created at $NewVenv"

    & uv sync 2>&1 | Tee-Object -Variable syncOut | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "uv sync failed: $syncOut" }
    Ok "uv sync completed"

    $smoke = & "$NewVenv\Scripts\python.exe" -c "import textual, qdrant_client, fastembed, rich, yaml; print('imports ok')" 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "Smoke imports failed: $smoke" }
    Ok "Smoke imports OK"
}
finally { Pop-Location }

# ─────────────────────────────────────────────────────────────────────────────
Step 4 "Rewrite paths"

# 4a. settings.json — 14 hooks
$settings = Get-Content $SettingsFile -Raw -Encoding UTF8
$origLen = $settings.Length
$settings = $settings.Replace(
    'C:/Users/USER/.claude/skills/ultron/.venv/Scripts/python.exe',
    'C:/Users/USER/.ultron/.venv/Scripts/python.exe')
$settings = $settings.Replace(
    'C:/Users/USER/.claude/skills/ultron/hooks/',
    'C:/Users/USER/.ultron/scripts/hooks/')
$settings = $settings.Replace(
    'C:/Users/USER/.ultron/hooks/',
    'C:/Users/USER/.ultron/scripts/hooks/')
Set-Content $SettingsFile -Value $settings -Encoding UTF8 -NoNewline
Ok "settings.json rewritten ($origLen -> $($settings.Length) bytes)"

# 4b. Hook .py — sys.path patterns
foreach ($f in (Get-ChildItem "$NewHooksDir\*.py" -ErrorAction SilentlyContinue)) {
    $c = Get-Content $f.FullName -Raw -Encoding UTF8; $orig = $c
    $c = $c -replace `
        '(?s)Path\.home\(\)\s*/\s*"\.claude"\s*/\s*"skills"\s*/\s*"ultron"\s*/\s*"scripts"\s*/\s*"cockpit"', `
        'Path.home() / ".ultron" / "scripts" / "cockpit"'
    $c = $c -replace `
        'Path\(__file__\)\.resolve\(\)\.parents\[1\]\s*/\s*"scripts"\s*/\s*"cockpit"', `
        'Path(__file__).resolve().parent.parent / "cockpit"'
    if ($c -ne $orig) {
        Set-Content $f.FullName -Value $c -Encoding UTF8 -NoNewline
        Ok "rewrote sys.path in hooks/$($f.Name)"
    }
}

# 4c. Cockpit scripts — parents[2] / parent.parent.parent SKILL_ROOT calculations
# These compute the SKILL folder which STAYS at ~/.claude/skills/ultron/
$skillRootHardcode = 'Path.home() / ".claude" / "skills" / "ultron"'
$cockpitFiles = Get-ChildItem "$NewCockpitDir\*.py" -ErrorAction SilentlyContinue
foreach ($f in $cockpitFiles) {
    $c = Get-Content $f.FullName -Raw -Encoding UTF8; $orig = $c
    # Pattern A: SKILL_ROOT or ULTRON_ROOT = Path(__file__).resolve().parents[2]
    $c = $c -replace `
        'Path\(__file__\)\.resolve\(\)\.parents\[2\]', `
        $skillRootHardcode
    # Pattern B: Path(__file__).parent.parent.parent (tui.py:47)
    $c = $c -replace `
        'Path\(__file__\)\.parent\.parent\.parent(?!\.parent)', `
        $skillRootHardcode
    # Pattern C: Path(__file__).parents[2] (intent_dispatcher.py:18)
    # This one points to a HOOK (not skill root). Special-case for that file.
    if ($c -ne $orig) {
        Set-Content $f.FullName -Value $c -Encoding UTF8 -NoNewline
        Ok "rewrote SKILL_ROOT in cockpit/$($f.Name)"
    }
}

# 4d. intent_dispatcher.py — _HOOK_PATH points to the hook now in ~/.ultron/scripts/hooks
$idFile = "$NewCockpitDir\intent_dispatcher.py"
if (Test-Path $idFile) {
    $c = Get-Content $idFile -Raw -Encoding UTF8; $orig = $c
    $c = $c -replace `
        'Path\(__file__\)\.parents\[2\]\s*/\s*"hooks"\s*/\s*"intent-dispatcher\.py"', `
        'Path.home() / ".ultron" / "scripts" / "hooks" / "intent-dispatcher.py"'
    if ($c -ne $orig) {
        Set-Content $idFile -Value $c -Encoding UTF8 -NoNewline
        Ok "rewrote _HOOK_PATH in cockpit/intent_dispatcher.py"
    }
}

# 4e. Skill CLAUDE.md workspace table
$claudeMdSkill = Get-Content $SkillClaudeMd -Raw -Encoding UTF8
$workspaceBlock = @'
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
if ($claudeMdSkill -match '(?s)## Workspace paths.*?```[^`]*```') {
    $claudeMdSkill = $claudeMdSkill -replace '(?s)## Workspace paths.*?```[^`]*```', $workspaceBlock
    Set-Content $SkillClaudeMd -Value $claudeMdSkill -Encoding UTF8 -NoNewline
    Ok "CLAUDE.md (skill) workspace table updated"
} else {
    Warn "Workspace table pattern not found in CLAUDE.md (skill) - inspect manually"
}

# 4f. Global ~/.claude/CLAUDE.md — context_primer.py path
$globalMd = Get-Content $GlobalClaudeMd -Raw -Encoding UTF8; $origGlobal = $globalMd
$globalMd = $globalMd -replace `
    '~/\.claude/skills/ultron/scripts/cockpit/', `
    '~/.ultron/scripts/cockpit/'
if ($globalMd -ne $origGlobal) {
    Set-Content $GlobalClaudeMd -Value $globalMd -Encoding UTF8 -NoNewline
    Ok "Global ~/.claude/CLAUDE.md paths updated"
}

# ─────────────────────────────────────────────────────────────────────────────
Step 5 "Stage skill repo deletions"

Push-Location $SkillRoot
try {
    foreach ($p in @('scripts', 'hooks', 'tests')) {
        if (-not (Test-Path "$SkillRoot\$p")) {
            & git rm -r --cached --quiet $p 2>&1 | Out-Null
            Ok "git rm -r --cached $p"
        }
    }
}
finally { Pop-Location }

# ─────────────────────────────────────────────────────────────────────────────
Step 6 "Verify"

$pytest = & "$NewVenv\Scripts\python.exe" -m pytest "$UltronRoot\tests\" -q --no-header 2>&1
$pytestExit = $LASTEXITCODE
$pytestSummary = ($pytest | Select-String "passed|failed|error" | Select-Object -Last 1).ToString().Trim()

if ($pytestExit -eq 0) { Ok "pytest: $pytestSummary" }
else { Warn "pytest exit=$pytestExit - inspect: $NewVenv\Scripts\python.exe -m pytest $UltronRoot\tests -v" }

# Smoke test: import each rewritten module
$smokeMods = @('cockpit_base','tui','memory_bridge','on_wake','skill_manifest_to_routing','intent_dispatcher')
$importTest = ($smokeMods | ForEach-Object { "import $_" }) -join "; "
$smoke = & "$NewVenv\Scripts\python.exe" -c "import sys; sys.path.insert(0, r'$NewCockpitDir'); $importTest; print('all imports ok')" 2>&1
if ($LASTEXITCODE -eq 0) { Ok "Cockpit modules import: $smoke" }
else { Warn "Module import smoke failed: $smoke" }

# ─────────────────────────────────────────────────────────────────────────────
Step 7 "Summary"

Write-Host ""
Write-Host "===== MIGRATION COMPLETE =====" -ForegroundColor Cyan
Write-Host "  Backup:      $BackupDir" -ForegroundColor Gray
Write-Host "  Tests:       $pytestSummary" -ForegroundColor Gray
Write-Host "  Skill size:  $([math]::Round((Get-ChildItem $SkillRoot -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)) MB" -ForegroundColor Gray
Write-Host "  Code size:   $([math]::Round((Get-ChildItem $NewScripts -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)) MB" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Reopen Claude Code"
Write-Host "  2. New session > say 'Ultron, verify v14.9'"
Write-Host "  3. Run: ultron tui"
Write-Host "  4. Commit skill repo: cd $SkillRoot ; git commit -m 'feat(v14.9): STRUCTURE migration'"
Write-Host ""
Write-Host "If broken:" -ForegroundColor Red
Write-Host "  Remove-Item -Recurse $SkillRoot ; tar -xf '$tarFile' -C (Split-Path $SkillRoot -Parent)"
Write-Host "  Copy-Item '$BackupDir\settings.json' '$SettingsFile' -Force"
Write-Host "  Copy-Item '$BackupDir\CLAUDE.md.global' '$GlobalClaudeMd' -Force"
Write-Host "  Remove-Item -Recurse $NewVenv, $NewCockpitDir, $NewHooksDir, $UltronRoot\tests"
