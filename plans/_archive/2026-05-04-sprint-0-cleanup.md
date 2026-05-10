# Sprint 0 — Cleanup & Cuts (detailed plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (preferred for sequential cleanup) or `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax. Each task = 2-5 min.

**Goal:** Eliminar 85+ MB de cruft confirmado, desinstalar 4 plugins redundantes, remover MCP `memory` server, capturar baseline de métricas — todo con backup + rollback + verificación.

**Architecture:** Backup-first → grep-verify-no-references → atomic-deletes → JSON edits via Python (preserva formato) → post-cleanup verification → rollback script generado.

**Tech Stack:** PowerShell 7 (filesystem ops), Python 3.11 via `uv` (JSON edits), Compress-Archive (backup tarballs).

**Parent plan:** `~/.ultron/plans/2026-05-04-ultron-v14-overhaul-master.md`

---

## Pre-conditions

- ULTRON v13.2.0 baseline (verificable en `SKILL.md` línea 1)
- `~/.ultron/backups/` directorio existe (ya creado en setup)
- `~/.ultron/telemetry/v14-overhaul/` directorio existe
- Claude Code session SIN trabajo en progreso (sprint puede causar 1 reinicio)

---

## Task 1: Pre-flight check + capture PRE baseline

**Files:**
- Create: `C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-pre.json`

- [x] **Step 1: Verify ULTRON state**

```powershell
$skillMd = 'C:\Users\USER\.claude\skills\ultron\SKILL.md'
$version = (Select-String -Path $skillMd -Pattern 'v\d+\.\d+\.\d+' | Select-Object -First 1).Matches.Value
Write-Host "ULTRON version: $version"
if ($version -ne 'v13.2.0' -and $version -ne 'v12.5.0') {
    Write-Host "WARN: unexpected version. Plan assumes v13.2.0 / v12.5.0" -ForegroundColor Yellow
}
```

Expected: `v13.2.0` or `v12.5.0` (per current SKILL.md).

- [x] **Step 2: Capture baseline metrics**

```powershell
$settings = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
$enabledPlugins = $settings.enabledPlugins
$pluginCount = if ($enabledPlugins -is [array]) { $enabledPlugins.Count } else { ($enabledPlugins.PSObject.Properties | Measure-Object).Count }

$baseline = [ordered]@{
    timestamp                = (Get-Date).ToString('o')
    ultron_version           = $version
    settings_json_size_bytes = (Get-Item 'C:\Users\USER\.claude\settings.json').Length
    enabled_plugins_count    = $pluginCount
    mcp_servers              = @($settings.mcpServers.PSObject.Properties.Name)
    mcp_servers_count        = ($settings.mcpServers.PSObject.Properties | Measure-Object).Count
    ultron_dir_size_mb       = [math]::Round((Get-ChildItem 'C:\Users\USER\.ultron' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 2)
    brain_index_size_kb      = if (Test-Path 'C:\Users\USER\.ultron\brain_index\index.db') { [math]::Round((Get-Item 'C:\Users\USER\.ultron\brain_index\index.db').Length / 1KB, 2) } else { 0 }
}
$baseline | ConvertTo-Json -Depth 5 | Set-Content 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-pre.json' -Encoding utf8
Get-Content 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-pre.json'
```

Expected: JSON pretty-printed con valores no nulos. Anotar `ultron_dir_size_mb` para comparar al final.

---

## Task 2: Create backup snapshot

**Files:**
- Create: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\settings.json.bak`
- Create: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\settings.local.json.bak` (if exists)
- Create: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\<cruft>.zip` × 6

- [x] **Step 1: Create backup directory**

```powershell
New-Item -Path 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0' -ItemType Directory -Force | Out-Null
```

- [x] **Step 2: Backup settings files**

```powershell
$bk = 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0'
Copy-Item 'C:\Users\USER\.claude\settings.json' "$bk\settings.json.bak" -Force
if (Test-Path 'C:\Users\USER\.claude\settings.local.json') {
    Copy-Item 'C:\Users\USER\.claude\settings.local.json' "$bk\settings.local.json.bak" -Force
}
Get-ChildItem $bk -Filter '*.bak' | Format-Table Name, Length
```

Expected: 1-2 .bak files listed.

- [x] **Step 3: Tarball cruft folders BEFORE deleting**

```powershell
$bk = 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0'
$cruftPaths = @(
    'C:\Users\USER\.ultron\_knowledge-deprecated-v12.5',
    'C:\Users\USER\.ultron\archive\v6.x-legacy',
    'C:\Users\USER\.ultron\archive\deprecated-memory-system',
    'C:\Users\USER\.ultron\.tmp.driveupload',
    'C:\Users\USER\.ultron\archive\skill_installs\20260430-coding-sync',
    'C:\Users\USER\.ultron\archive\cleanup-2026-05-02'
)
foreach ($p in $cruftPaths) {
    if (Test-Path $p) {
        $name = Split-Path $p -Leaf
        $zipPath = Join-Path $bk "$name.zip"
        Compress-Archive -Path $p -DestinationPath $zipPath -Force
        Write-Host "Zipped: $name -> $zipPath"
    } else {
        Write-Host "Skipping (not found): $p" -ForegroundColor Yellow
    }
}
Get-ChildItem $bk -Filter '*.zip' | Format-Table Name, @{N='Size_MB';E={[math]::Round($_.Length/1MB,2)}}
```

Expected: 6 .zip files (some may be skipped if path doesn't exist on this system — that's OK).

- [x] **Step 4: Verify backup integrity**

```powershell
$bk = 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0'
$totalMB = [math]::Round((Get-ChildItem $bk -File -Recurse | Measure-Object Length -Sum).Sum / 1MB, 2)
Write-Host "Backup total: $totalMB MB"
if ($totalMB -lt 1) { Write-Host "WARN: backup is suspiciously small. Investigate." -ForegroundColor Red }
```

Expected: total >50 MB (debido al `20260430-coding-sync` zip).

---

## Task 3: Verify no active references to cruft folders

**Files:** None (read-only audit).

- [x] **Step 1: Grep cruft path patterns across active scripts**

```powershell
$patterns = @(
    '_knowledge-deprecated',
    'v6.x-legacy',
    'deprecated-memory-system',
    '\.tmp\.driveupload',
    '20260430-coding-sync',
    'cleanup-2026-05-02',
    'push-async\.log'
)
foreach ($pat in $patterns) {
    Write-Host "=== $pat ===" -ForegroundColor Cyan
    $hits = Get-ChildItem 'C:\Users\USER\.claude\skills\ultron' -Recurse -File -Include '*.py','*.ps1','*.md','*.json','*.yaml','*.toml' -ErrorAction SilentlyContinue |
        Select-String -Pattern $pat -ErrorAction SilentlyContinue
    if ($hits) {
        $hits | Select-Object @{N='File';E={$_.Path -replace [regex]::Escape('C:\Users\USER\.claude\skills\ultron\'), ''}}, LineNumber, @{N='Line';E={$_.Line.Trim().Substring(0,[Math]::Min(80,$_.Line.Trim().Length))}}
    } else {
        Write-Host "  (no hits — safe to delete)" -ForegroundColor Green
    }
}
```

Expected: only documentation hits (CHANGELOG, README mentioning past cleanup) — no active code references.

- [x] **Step 2: Decision gate**

If any hits in `*.py` or `*.ps1` files → **STOP**. Do NOT proceed to Task 5. Investigate the reference and update the plan.

If hits only in `.md` (changelogs, READMEs) → safe to proceed.

---

## Task 4: Verify no active references to redundant plugins

**Files:** None (read-only audit).

- [x] **Step 1: Grep plugin names across `~/.claude/`**

```powershell
$plugins = @('claude-mem@thedotmack', 'pensyve@major7apps', 'code-simplifier@claude-plugins-official', 'context7@claude-plugins-official', '"memory":\s*\{')
foreach ($plug in $plugins) {
    Write-Host "=== $plug ===" -ForegroundColor Cyan
    $hits = Get-ChildItem 'C:\Users\USER\.claude' -Recurse -File -Include '*.json','*.md','*.py','*.ps1','*.yaml' -ErrorAction SilentlyContinue |
        Select-String -Pattern $plug -ErrorAction SilentlyContinue |
        Group-Object Path |
        Select-Object @{N='File';E={$_.Name -replace [regex]::Escape('C:\Users\USER\.claude\'), ''}}, @{N='Hits';E={$_.Count}}
    if ($hits) { $hits | Sort-Object Hits -Descending | Format-Table -AutoSize }
    else { Write-Host "  (no hits)" -ForegroundColor Green }
}
```

Expected:
- `settings.json` aparece (intended — vamos a limpiarlo)
- `SKILL.md` puede tener menciones (documentación) — OK
- Plugin internal directories en `~/.claude/plugins/cache/...` — OK, se limpian al desinstalar
- NO referencias en `~/.claude/skills/ultron/scripts/` o hooks activos

- [x] **Step 2: Decision gate**

Si aparecen referencias en scripts cockpit verificados (lista del master plan No-Touch) → **STOP** y revisar.

---

## Task 5: Delete cruft folders

**Files:**
- Delete: 6 cruft folders + `push-async.log` (paths en Task 2 step 3)

- [x] **Step 1: Verify backup zips exist**

```powershell
$bk = 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0'
$zipCount = (Get-ChildItem $bk -Filter '*.zip').Count
Write-Host "Backup zips: $zipCount"
if ($zipCount -lt 1) { Write-Host "ABORT: no backups found. Run Task 2 first." -ForegroundColor Red; exit 1 }
```

- [x] **Step 2: Delete cruft folders**

```powershell
$cruftPaths = @(
    'C:\Users\USER\.ultron\_knowledge-deprecated-v12.5',
    'C:\Users\USER\.ultron\archive\v6.x-legacy',
    'C:\Users\USER\.ultron\archive\deprecated-memory-system',
    'C:\Users\USER\.ultron\.tmp.driveupload',
    'C:\Users\USER\.ultron\archive\skill_installs\20260430-coding-sync',
    'C:\Users\USER\.ultron\archive\cleanup-2026-05-02'
)
foreach ($p in $cruftPaths) {
    if (Test-Path $p) {
        Remove-Item -Path $p -Recurse -Force -Confirm:$false
        Write-Host "DELETED: $p" -ForegroundColor Green
    } else {
        Write-Host "SKIP (not present): $p" -ForegroundColor Yellow
    }
}
```

- [x] **Step 3: Delete `push-async.log`**

```powershell
$logPath = 'C:\Users\USER\.ultron\hooks\push-async.log'
if (Test-Path $logPath) {
    Remove-Item $logPath -Force
    Write-Host "DELETED: $logPath" -ForegroundColor Green
} else {
    Write-Host "SKIP (not present): $logPath" -ForegroundColor Yellow
}
```

- [x] **Step 4: Verify deletes**

```powershell
$cruftPaths = @(
    'C:\Users\USER\.ultron\_knowledge-deprecated-v12.5',
    'C:\Users\USER\.ultron\archive\v6.x-legacy',
    'C:\Users\USER\.ultron\archive\deprecated-memory-system',
    'C:\Users\USER\.ultron\.tmp.driveupload',
    'C:\Users\USER\.ultron\archive\skill_installs\20260430-coding-sync',
    'C:\Users\USER\.ultron\archive\cleanup-2026-05-02',
    'C:\Users\USER\.ultron\hooks\push-async.log'
)
$failed = @()
foreach ($p in $cruftPaths) {
    if (Test-Path $p) { $failed += $p }
}
if ($failed.Count -eq 0) { Write-Host "ALL CRUFT REMOVED" -ForegroundColor Green }
else { Write-Host "STILL EXISTS:" -ForegroundColor Red; $failed | ForEach-Object { Write-Host "  $_" } }
```

Expected: `ALL CRUFT REMOVED`.

---

## Task 6: Remove redundant plugins from `settings.json`

**Files:**
- Modify: `C:\Users\USER\.claude\settings.json` (`enabledPlugins`)
- Create: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\remove_plugins.py` (idempotent script)

- [x] **Step 1: Inspect current `enabledPlugins` structure**

```powershell
$settings = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
$type = if ($settings.enabledPlugins -is [array]) { 'array' } elseif ($settings.enabledPlugins -is [System.Management.Automation.PSCustomObject]) { 'object' } else { 'unknown' }
Write-Host "enabledPlugins type: $type"
$settings.enabledPlugins | ConvertTo-Json -Depth 5
```

Expected: array of strings OR object `{ "plugin@source": true/false }`.

- [x] **Step 2: Create idempotent removal script**

```powershell
$scriptPath = 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\remove_plugins.py'
@'
"""Remove specified plugins from Claude Code settings.json. Idempotent — handles array or object form."""
import json
from pathlib import Path

SETTINGS = Path(r"C:\Users\USER\.claude\settings.json")
TO_REMOVE = [
    "claude-mem@thedotmack",
    "pensyve@major7apps-pensyve",
    "code-simplifier@claude-plugins-official",
    "context7@claude-plugins-official",
]

data = json.loads(SETTINGS.read_text(encoding="utf-8"))
ep = data.get("enabledPlugins", {})
removed = []

if isinstance(ep, list):
    new_list = [p for p in ep if p not in TO_REMOVE]
    removed = [p for p in ep if p in TO_REMOVE]
    data["enabledPlugins"] = new_list
elif isinstance(ep, dict):
    for key in TO_REMOVE:
        if key in ep:
            del ep[key]
            removed.append(key)
    data["enabledPlugins"] = ep
else:
    print(f"WARN: enabledPlugins is type {type(ep).__name__} — not modifying")

SETTINGS.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Removed: {removed}")
print(f"Remaining count: {len(ep) if hasattr(ep, '__len__') else 'n/a'}")
'@ | Set-Content -Path $scriptPath -Encoding utf8
```

- [x] **Step 3: Run removal script**

```powershell
uv run python 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\remove_plugins.py'
```

Expected output: `Removed: [...]` listing 1-4 plugins (some may already be absent).

- [x] **Step 4: Verify settings.json is still valid JSON**

```powershell
try {
    $s = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
    Write-Host "settings.json: VALID JSON" -ForegroundColor Green
    Write-Host "Remaining plugins:"
    $s.enabledPlugins | ConvertTo-Json -Depth 3
} catch {
    Write-Host "settings.json: INVALID — restoring from backup" -ForegroundColor Red
    Copy-Item 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\settings.json.bak' 'C:\Users\USER\.claude\settings.json' -Force
}
```

Expected: VALID JSON, remaining list does NOT contain `claude-mem`, `pensyve`, `code-simplifier@claude-plugins-official`, `context7@claude-plugins-official`.

---

## Task 7: Remove MCP `memory` server

**Files:**
- Modify: `C:\Users\USER\.claude\settings.json` (`mcpServers.memory`)
- Create: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\remove_mcp_memory.py`

- [x] **Step 1: Inspect current MCP servers**

```powershell
$settings = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
$settings.mcpServers.PSObject.Properties.Name | Sort-Object
```

Expected: list de servidores. Verificar que `memory` está presente.

- [x] **Step 2: Create removal script**

```powershell
$scriptPath = 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\remove_mcp_memory.py'
@'
"""Remove mcpServers.memory entry from settings.json. Idempotent."""
import json
from pathlib import Path

SETTINGS = Path(r"C:\Users\USER\.claude\settings.json")

data = json.loads(SETTINGS.read_text(encoding="utf-8"))
mcp = data.get("mcpServers", {})

if "memory" in mcp:
    del mcp["memory"]
    print("Removed: mcpServers.memory")
else:
    print("Not found: mcpServers.memory (already absent)")

data["mcpServers"] = mcp

SETTINGS.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Remaining MCP servers: {sorted(mcp.keys())}")
'@ | Set-Content -Path $scriptPath -Encoding utf8
```

- [x] **Step 3: Run script**

```powershell
uv run python 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\remove_mcp_memory.py'
```

Expected: `Removed: mcpServers.memory` (o `Not found` si ya estaba ausente — idempotente).

- [x] **Step 4: Verify**

```powershell
$s = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
$mcps = $s.mcpServers.PSObject.Properties.Name
Write-Host "Remaining MCPs: $($mcps -join ', ')"
if ($mcps -contains 'memory') {
    Write-Host "FAIL: memory still present" -ForegroundColor Red
} else {
    Write-Host "OK: memory removed" -ForegroundColor Green
}
```

---

## Task 8: Post-cleanup verification

**Files:** None (read-only verification).

- [x] **Step 1: Validate `settings.json` final state**

```powershell
$s = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
$shouldBeGone = @('claude-mem@thedotmack','pensyve@major7apps-pensyve','code-simplifier@claude-plugins-official','context7@claude-plugins-official')

$ep = $s.enabledPlugins
$pluginNames = if ($ep -is [array]) { $ep } else { $ep.PSObject.Properties.Name }

$failures = @()
foreach ($p in $shouldBeGone) {
    if ($pluginNames -contains $p) { $failures += "PLUGIN STILL PRESENT: $p" }
}
if ($s.mcpServers.PSObject.Properties.Name -contains 'memory') { $failures += "MCP memory still present" }

if ($failures.Count -eq 0) {
    Write-Host "VERIFICATION PASSED" -ForegroundColor Green
} else {
    Write-Host "VERIFICATION FAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  $_" }
}
```

- [x] **Step 2: Verify brain_index DB intact**

```powershell
uv run python C:\Users\USER\.claude\skills\ultron\scripts\cockpit\brain_index.py status
```

Expected: stats showing notes indexed (~970 per master plan baseline).

- [x] **Step 3: Test `ultron sync` still works**

```powershell
& 'C:\Users\USER\.claude\skills\ultron\scripts\ultron.ps1' sync
```

Expected: completes sin warnings ni errors.

- [x] **Step 4: Manual smoke test (HUMAN)**

Open new Claude Code session in a **separate terminal window**:

```
claude "Ultron, status"
```

Expected: ULTRON responds normally, no errors about missing plugins/MCPs. Cierra esa sesión sin guardar.

---

## Task 9: Capture POST baseline + diff

**Files:**
- Create: `C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-post.json`
- Create: `C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-diff.md`

- [x] **Step 1: Capture POST metrics**

```powershell
$settings = Get-Content 'C:\Users\USER\.claude\settings.json' -Raw | ConvertFrom-Json
$ep = $settings.enabledPlugins
$pluginCount = if ($ep -is [array]) { $ep.Count } else { ($ep.PSObject.Properties | Measure-Object).Count }

$baseline = [ordered]@{
    timestamp                = (Get-Date).ToString('o')
    ultron_version           = 'v13.3.0-pending-review'
    settings_json_size_bytes = (Get-Item 'C:\Users\USER\.claude\settings.json').Length
    enabled_plugins_count    = $pluginCount
    mcp_servers              = @($settings.mcpServers.PSObject.Properties.Name)
    mcp_servers_count        = ($settings.mcpServers.PSObject.Properties | Measure-Object).Count
    ultron_dir_size_mb       = [math]::Round((Get-ChildItem 'C:\Users\USER\.ultron' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 2)
    brain_index_size_kb      = if (Test-Path 'C:\Users\USER\.ultron\brain_index\index.db') { [math]::Round((Get-Item 'C:\Users\USER\.ultron\brain_index\index.db').Length / 1KB, 2) } else { 0 }
}
$baseline | ConvertTo-Json -Depth 5 | Set-Content 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-post.json' -Encoding utf8
Get-Content 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-post.json'
```

- [x] **Step 2: Generate diff report**

```powershell
$diffScript = @'
import json
from pathlib import Path

base = Path(r"C:\Users\USER\.ultron\telemetry\v14-overhaul")
pre = json.loads((base / "sprint-0-baseline-pre.json").read_text(encoding="utf-8"))
post = json.loads((base / "sprint-0-baseline-post.json").read_text(encoding="utf-8"))

lines = ["# Sprint 0 Baseline Diff", ""]
lines.append("| Metric | PRE | POST | Delta |")
lines.append("|--------|-----|------|-------|")
for k in pre:
    if k == "timestamp": continue
    pv, qv = pre.get(k), post.get(k)
    if isinstance(pv, (int, float)) and isinstance(qv, (int, float)):
        delta = qv - pv
        delta_str = f"{delta:+.2f}" if isinstance(pv, float) else f"{delta:+d}"
    else:
        delta_str = "—"
    lines.append(f"| {k} | {pv} | {qv} | {delta_str} |")

out = base / "sprint-0-diff.md"
out.write_text("\n".join(lines), encoding="utf-8")
print(out.read_text(encoding="utf-8"))
'@
$diffScript | Set-Content 'C:\Users\USER\.ultron\telemetry\v14-overhaul\diff_gen.py' -Encoding utf8
uv run python 'C:\Users\USER\.ultron\telemetry\v14-overhaul\diff_gen.py'
```

Expected (values illustrative):
- `ultron_dir_size_mb`: PRE ~250 → POST ~165 (delta -85)
- `enabled_plugins_count`: PRE N → POST N-4
- `mcp_servers_count`: PRE M → POST M-1

---

## Task 10: Generate rollback script + changelog entry

**Files:**
- Create: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\rollback.ps1`
- Modify: `C:\Users\USER\.claude\skills\ultron\references\changelog.md` (append)

- [x] **Step 1: Generate rollback.ps1**

```powershell
$rollbackScript = @'
# ULTRON Sprint 0 Rollback Script
# Restores plugins, MCP memory, and cruft folders from this backup snapshot.
# Usage: powershell -File .\rollback.ps1

$ErrorActionPreference = 'Stop'
$backupDir = $PSScriptRoot
$ultronDir = 'C:\Users\USER\.ultron'
$claudeDir = 'C:\Users\USER\.claude'

Write-Host "=== ULTRON Sprint 0 Rollback ===" -ForegroundColor Cyan
Write-Host "Backup source: $backupDir"
$confirm = Read-Host "Restore from backup? (yes/no)"
if ($confirm -ne 'yes') { Write-Host "Aborted." -ForegroundColor Yellow; exit 1 }

# 1. Restore settings files
if (Test-Path "$backupDir\settings.json.bak") {
    Copy-Item "$backupDir\settings.json.bak" "$claudeDir\settings.json" -Force
    Write-Host "Restored: settings.json"
}
if (Test-Path "$backupDir\settings.local.json.bak") {
    Copy-Item "$backupDir\settings.local.json.bak" "$claudeDir\settings.local.json" -Force
    Write-Host "Restored: settings.local.json"
}

# 2. Restore cruft folders from zips
$zipMap = @{
    '_knowledge-deprecated-v12.5'  = $ultronDir
    'v6.x-legacy'                  = "$ultronDir\archive"
    'deprecated-memory-system'     = "$ultronDir\archive"
    '.tmp.driveupload'             = $ultronDir
    '20260430-coding-sync'         = "$ultronDir\archive\skill_installs"
    'cleanup-2026-05-02'           = "$ultronDir\archive"
}
foreach ($zip in Get-ChildItem "$backupDir\*.zip") {
    $name = $zip.BaseName
    $dest = $zipMap[$name]
    if (-not $dest) { Write-Host "WARN: no destination map for $name" -ForegroundColor Yellow; continue }
    if (-not (Test-Path $dest)) { New-Item $dest -ItemType Directory -Force | Out-Null }
    Expand-Archive -Path $zip.FullName -DestinationPath $dest -Force
    Write-Host "Restored: $name -> $dest"
}

Write-Host "`n=== Rollback complete ===" -ForegroundColor Green
Write-Host "Restart Claude Code to reload plugins/MCPs."
'@
$rollbackScript | Set-Content 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\rollback.ps1' -Encoding utf8
Write-Host "Rollback script written."
```

- [x] **Step 2: Test rollback script syntax (don't execute)**

```powershell
powershell -NoProfile -Command "Get-Command -Syntax 'C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\rollback.ps1'"
```

Expected: prints script path without errors. (Script body not executed.)

- [x] **Step 3: Append changelog entry**

```powershell
$changelog = 'C:\Users\USER\.claude\skills\ultron\references\changelog.md'
$entry = @"

## v13.3.0 (pending peer review) — 2026-05-04 — Sprint 0: Cleanup & Cuts

**Removed:**
- Carpetas: ``_knowledge-deprecated-v12.5/``, ``archive/v6.x-legacy/``, ``archive/deprecated-memory-system/``, ``.tmp.driveupload/``, ``archive/skill_installs/20260430-coding-sync/``, ``archive/cleanup-2026-05-02/``
- Archivo: ``hooks/push-async.log``
- Plugins: ``claude-mem@thedotmack``, ``pensyve@major7apps-pensyve``, ``code-simplifier@claude-plugins-official``, ``context7@claude-plugins-official``
- MCP server: ``memory``

**Reason:** Sprint 0 of v14 overhaul — eliminate cruft accumulated across v6-v13 + redundant memory tooling (brain_index + vault L2 supersede external memory plugins).

**Backup:** ``~/.ultron/backups/2026-05-04-pre-S0/`` (settings + zipped cruft + rollback.ps1)

**Metrics:** see ``~/.ultron/telemetry/v14-overhaul/sprint-0-diff.md``
"@
Add-Content -Path $changelog -Value $entry -Encoding utf8
Write-Host "Changelog entry appended."
```

---

## Task 11: Trigger MaxDual peer review

**Files:**
- Create: `C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-peer-review.md`

- [x] **Step 1: Invoke MaxDual via shared-duet.ps1**

```powershell
& 'C:\Users\USER\.claude\skills\ultron\scripts\shared-duet.ps1' `
    -Peers codex `
    -Rounds 3 `
    -Topic "Sprint 0 ULTRON cleanup review" `
    -Context @"
ULTRON v14 overhaul Sprint 0 just completed. Validate:
1. settings.json still valid JSON, no orphaned references
2. Removed plugins (claude-mem, pensyve, code-simplifier, context7) don't have transitive dependents
3. MCP memory removal doesn't break any wired-up tooling
4. Cruft deletes match what was zipped in backup (no false positives)
5. Rollback script (~/.ultron/backups/2026-05-04-pre-S0/rollback.ps1) is correct

Files to review:
- ~/.claude/settings.json (current state)
- ~/.ultron/backups/2026-05-04-pre-S0/rollback.ps1
- ~/.ultron/telemetry/v14-overhaul/sprint-0-diff.md
- ~/.claude/skills/ultron/references/changelog.md (latest entry)

Report: green-light | concerns | blockers
"@ `
    -OutputPath 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-peer-review.md'
```

Expected: file `sprint-0-peer-review.md` con verdict `green-light` o lista de concerns.

- [x] **Step 2: Read peer review verdict**

```powershell
Get-Content 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-peer-review.md'
```

- [x] **Step 3: Decision gate**

- Si **green-light** → proceed to Task 12 (version bump)
- Si **concerns** → resolve antes de Task 12
- Si **blockers** → run rollback script, fix plan, retry

---

## Task 12: Version bump + close sprint

**Files:**
- Modify: `C:\Users\USER\.claude\skills\ultron\SKILL.md` (version line)
- Modify: `C:\Users\USER\.claude\skills\ultron\CLAUDE.md` (version line)
- Modify: `C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-post.json` (replace `pending-review` con `v13.3.0`)

- [x] **Step 1: Bump SKILL.md version**

```powershell
$skillMd = 'C:\Users\USER\.claude\skills\ultron\SKILL.md'
$content = Get-Content $skillMd -Raw
$content = $content -replace 'ULTRON v12\.5\.0', 'ULTRON v13.3.0'
$content = $content -replace 'ULTRON v13\.2\.0', 'ULTRON v13.3.0'
Set-Content -Path $skillMd -Value $content -Encoding utf8
Select-String -Path $skillMd -Pattern 'v13\.3\.0' | Select-Object -First 3
```

- [x] **Step 2: Bump CLAUDE.md version**

```powershell
$claudeMd = 'C:\Users\USER\.claude\skills\ultron\CLAUDE.md'
$content = Get-Content $claudeMd -Raw
$content = $content -replace 'ULTRON v13\.2\.0', 'ULTRON v13.3.0'
$content = $content -replace 'CAPACIDADES ACTIVAS v13\.1\.0', 'CAPACIDADES ACTIVAS v13.3.0'
Set-Content -Path $claudeMd -Value $content -Encoding utf8
```

- [x] **Step 3: Finalize POST baseline**

```powershell
$postPath = 'C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline-post.json'
$content = Get-Content $postPath -Raw
$content = $content -replace 'v13\.3\.0-pending-review', 'v13.3.0'
Set-Content -Path $postPath -Value $content -Encoding utf8
```

- [x] **Step 4: Update master plan checkbox**

Open `~/.ultron/plans/2026-05-04-ultron-v14-overhaul-master.md`, find Sprint 0 section, mark all DONE criteria as `[x]`.

```powershell
Write-Host "MANUAL: open master plan and tick Sprint 0 checkboxes"
& notepad++ 'C:\Users\USER\.ultron\plans\2026-05-04-ultron-v14-overhaul-master.md' 2>$null
```

(Or use any editor — notepad++ optional.)

- [x] **Step 5: Sprint 0 closed — announce**

```
Sprint 0 complete: ULTRON 13.2.0 -> 13.3.0
- N MB reclaimed (see diff)
- N plugins removed
- 1 MCP server removed
- Backup + rollback at ~/.ultron/backups/2026-05-04-pre-S0/
- Peer review: GREEN-LIGHT
Ready for Sprint 1 (Silent Execution Audit).
```

---

## Self-Review

**Spec coverage:**
- Backup before destructive ops ✅ (Task 2)
- Verify no references before delete ✅ (Tasks 3-4)
- Atomic deletes with rollback ✅ (Tasks 5, 10)
- JSON edits via Python (preserva formato) ✅ (Tasks 6-7)
- Post-cleanup verification ✅ (Task 8)
- Métricas comparables PRE/POST ✅ (Tasks 1, 9)
- Peer review MaxDual ✅ (Task 11)
- Version bump solo después de peer ✅ (Task 12)

**Placeholder scan:** ✅ No TBD/TODO. Cada step tiene comando exacto + expected output.

**Idempotencia:** ✅ Tasks 6-7 scripts manejan caso "ya removido". Tasks 5 manejan "path not found" sin fallar.

**Risk mitigations applied:**
- Plugin reference grep en Task 4 antes de remove
- JSON validation post-edit en Tasks 6, 7, 8
- Rollback script generado en Task 10 antes del peer review
- Sprint NO se cierra (Task 12) hasta peer green-light

---

## Execution Handoff

Plan complete. Saved to `C:\Users\USER\.ultron\plans\2026-05-04-sprint-0-cleanup.md`.

**Estimated time:** 30-45 min if executed sequentially without issues. 60-90 min con peer review iteration.

**Next step:** ¿Cómo ejecutamos?

1. **Tú ejecutas** los 12 tasks en orden, copiando comandos PowerShell — máximo control
2. **Yo ejecuto** task-by-task con confirmación tuya entre cada uno — colaborativo
3. **Subagent-driven** — un subagente fresco corre todo el sprint con `superpowers:subagent-driven-development`, yo reviso al final — más rápido

Recomendación: **opción 2** (yo ejecuto + tú confirmas entre tasks) para esta sesión, ya que es destructivo y queremos control granular. Tasks 1-4 son audit/backup (safe) → tasks 5-7 son destructivos → tasks 8-12 verify+close.
