# ULTRON v14.9 STRUCTURE — Cockpit Migration Script
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
# Spec: ~/.ultron/plans/2026-05-09-v14.9-STRUCTURE.md

$ErrorActionPreference = 'Stop'

$SkillRoot   = "C:\Users\USER\.claude\skills\ultron"
$UltronRoot  = "C:\Users\USER\.ultron"
$NewScripts  = "$UltronRoot\scripts"
$NewVenv     = "$UltronRoot\.venv"
$BackupDir   = "$UltronRoot\backups\pre-v14.9-$(Get-Date -Format 'yyyy-MM-dd-HHmm')"
$SettingsFile = "C:\Users\USER\.claude\settings.json"

function Step($n, $title) {
    Write-Host ""
    Write-Host "===== STEP $n - $title =====" -ForegroundColor Cyan
}

function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X]  $msg" -ForegroundColor Red; throw $msg }

# ─────────────────────────────────────────────────────────────────────────────
Step 0 "Pre-flight"

if (-not (Test-Path "$SkillRoot\SKILL.md")) {
    Fail "Skill root not found: $SkillRoot"
}
if (-not (Test-Path "$SkillRoot\scripts\cockpit\tui.py")) {
    Fail "Skill scripts/cockpit not found - already migrated?"
}

# Confirm Claude Code is not running (any python.exe holding the venv)
$claudeProc = Get-Process claude -ErrorAction SilentlyContinue
if ($claudeProc) {
    Fail "Close Claude Code first - process still running (PID $($claudeProc.Id))."
}

$pyLocks = Get-Process python* -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($SkillRoot)
}
if ($pyLocks) {
    Fail "Python processes still holding the skill .venv. Close them first."
}

Ok "Skill folder OK"
Ok "Claude Code not running"
Ok "No python processes from skill .venv"

# ─────────────────────────────────────────────────────────────────────────────
Step 1 "Backup"

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
Copy-Item $SettingsFile "$BackupDir\settings.json" -Force
Ok "settings.json -> $BackupDir"

# Tar the skill folder (use built-in tar on Windows 10+)
$tarFile = "$BackupDir\skill-ultron.tar"
& tar -cf $tarFile -C (Split-Path $SkillRoot -Parent) (Split-Path $SkillRoot -Leaf)
if ($LASTEXITCODE -ne 0) { Fail "tar backup failed" }
Ok "skill folder -> $tarFile ($([math]::Round((Get-Item $tarFile).Length/1MB,1)) MB)"

# ─────────────────────────────────────────────────────────────────────────────
Step 2 "Move directories"

# 2a. scripts/cockpit + scripts/shared-duet.ps1
if (-not (Test-Path "$NewScripts\cockpit")) {
    Move-Item "$SkillRoot\scripts\cockpit" "$NewScripts\cockpit" -Force
    Ok "scripts/cockpit -> $NewScripts/cockpit"
} else {
    Warn "scripts/cockpit already exists - skipping"
}

if (Test-Path "$SkillRoot\scripts\shared-duet.ps1") {
    Move-Item "$SkillRoot\scripts\shared-duet.ps1" "$NewScripts\shared-duet.ps1" -Force
    Ok "shared-duet.ps1 -> $NewScripts"
}

# 2b. hooks (Python) -> scripts/hooks
$NewHooksDir = "$NewScripts\hooks"
if (-not (Test-Path $NewHooksDir)) {
    Move-Item "$SkillRoot\hooks" $NewHooksDir -Force
    Ok "hooks (Python) -> $NewHooksDir"
} else {
    Warn "scripts/hooks already exists - merging"
    Get-ChildItem "$SkillRoot\hooks" | Move-Item -Destination $NewHooksDir -Force
    Remove-Item "$SkillRoot\hooks" -Force
}

# 2c. PowerShell hooks (currently in ~/.ultron/hooks/) -> scripts/hooks
$OldPSHooks = "$UltronRoot\hooks"
if (Test-Path $OldPSHooks) {
    Get-ChildItem "$OldPSHooks\*.ps1" | Move-Item -Destination $NewHooksDir -Force
    # Move logs into logs/ to keep them
    if (Test-Path "$OldPSHooks\push-async.log") {
        Move-Item "$OldPSHooks\push-async.log" "$UltronRoot\logs\push-async.log" -Force
    }
    if (Test-Path "$OldPSHooks\stop-memory-sync.log") {
        Move-Item "$OldPSHooks\stop-memory-sync.log" "$UltronRoot\logs\stop-memory-sync.log" -Force
    }
    Remove-Item $OldPSHooks -Recurse -Force
    Ok "ps1 hooks -> $NewHooksDir, logs -> ~/.ultron/logs"
}

# 2d. tests
if (-not (Test-Path "$UltronRoot\tests")) {
    Move-Item "$SkillRoot\tests" "$UltronRoot\tests" -Force
    Ok "tests -> $UltronRoot/tests"
}

# 2e. pyproject.toml + uv.lock (copy, don't move - skill may want a stub)
Copy-Item "$SkillRoot\pyproject.toml" "$UltronRoot\pyproject.toml" -Force
Copy-Item "$SkillRoot\uv.lock"        "$UltronRoot\uv.lock"        -Force
Ok "pyproject.toml + uv.lock copied to $UltronRoot"

# 2f. clean __pycache__ everywhere
Get-ChildItem $UltronRoot -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
Get-ChildItem $SkillRoot -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
Ok "__pycache__ purged"

# ─────────────────────────────────────────────────────────────────────────────
Step 3 "Recreate .venv at new location"

if (Test-Path $NewVenv) {
    Warn ".venv already exists at $NewVenv - removing"
    Remove-Item $NewVenv -Recurse -Force
}

Push-Location $UltronRoot
try {
    & uv venv .venv 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "uv venv failed" }
    Ok ".venv created at $NewVenv"

    & uv sync 2>&1 | Tee-Object -Variable syncOut | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "uv sync failed: $syncOut" }
    Ok "uv sync completed"

    # Quick import smoke test
    $smoke = & "$NewVenv\Scripts\python.exe" -c "import textual, qdrant_client, fastembed, rich, yaml; print('imports ok')" 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "Smoke import failed: $smoke" }
    Ok "Smoke imports OK: textual, qdrant_client, fastembed, rich, yaml"
}
finally { Pop-Location }

# ─────────────────────────────────────────────────────────────────────────────
Step 4 "Rewrite paths"

# 4a. settings.json
$settings = Get-Content $SettingsFile -Raw -Encoding UTF8
$origLen  = $settings.Length
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

# 4b. Hook .py files - hardcoded _COCKPIT_PATH lines
Get-ChildItem "$NewHooksDir\*.py" | ForEach-Object {
    $content = Get-Content $_.FullName -Raw -Encoding UTF8
    $orig = $content
    # Pattern 1: Path.home() / .claude / skills / ultron / scripts / cockpit
    $content = $content -replace `
        '(?s)Path\.home\(\)\s*/\s*"\.claude"\s*/\s*"skills"\s*/\s*"ultron"\s*/\s*"scripts"\s*/\s*"cockpit"', `
        'Path.home() / ".ultron" / "scripts" / "cockpit"'
    # Pattern 2: Path(__file__).resolve().parents[1] / "scripts" / "cockpit"
    # Old hooks were at .claude/skills/ultron/hooks, parents[1] = .claude/skills/ultron, +scripts/cockpit
    # New location: .ultron/scripts/hooks, parents[1] = .ultron/scripts, +cockpit
    $content = $content -replace `
        'Path\(__file__\)\.resolve\(\)\.parents\[1\]\s*/\s*"scripts"\s*/\s*"cockpit"', `
        'Path(__file__).resolve().parent.parent / "cockpit"'

    if ($content -ne $orig) {
        Set-Content $_.FullName -Value $content -Encoding UTF8 -NoNewline
        Ok "rewrote sys.path in $($_.Name)"
    }
}

# 4c. SKILL.md workspace table
$skillMd = Get-Content "$SkillRoot\SKILL.md" -Raw -Encoding UTF8
$skillMd = $skillMd -replace `
    '(?s)## Workspace paths.*?```', `
    @'
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
Set-Content "$SkillRoot\SKILL.md" -Value $skillMd -Encoding UTF8 -NoNewline
Ok "SKILL.md workspace table updated"

# 4d. CLAUDE.md (skill) - update paths if any
# (handled separately in next session if needed)

# ─────────────────────────────────────────────────────────────────────────────
Step 5 "Verify"

$pytest = & "$NewVenv\Scripts\python.exe" -m pytest "$UltronRoot\tests\" -q --no-header 2>&1
$pytestExit = $LASTEXITCODE
$pytestSummary = $pytest | Select-String "passed|failed|error" | Select-Object -Last 1

if ($pytestExit -eq 0) {
    Ok "pytest: $pytestSummary"
} else {
    Warn "pytest exit=$pytestExit - $pytestSummary"
    Warn "Inspect: $NewVenv\Scripts\python.exe -m pytest $UltronRoot\tests -v"
}

# ─────────────────────────────────────────────────────────────────────────────
Step 6 "Summary"

Write-Host ""
Write-Host "===== MIGRATION COMPLETE =====" -ForegroundColor Cyan
Write-Host "  Backup:    $BackupDir" -ForegroundColor Gray
Write-Host "  Tests:     $pytestSummary" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Reopen Claude Code"
Write-Host "  2. Run: ultron tui   (verify TUI v14.8.0 opens)"
Write-Host "  3. New session > say 'Ultron' > verify skill activates"
Write-Host "  4. If anything fails:"
Write-Host "     tar -xf $tarFile -C (Split-Path $SkillRoot -Parent)"
Write-Host "     Copy-Item $BackupDir\settings.json $SettingsFile -Force"
Write-Host ""
Write-Host "Old skill folder remnants (safe to leave for 1 week):" -ForegroundColor Gray
Write-Host "  $SkillRoot\pyproject.toml (kept as ref, can delete)"
Write-Host "  $SkillRoot\uv.lock"
Write-Host "  $SkillRoot\.venv (rmdir if smoke tests pass tomorrow)"
