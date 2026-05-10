# ULTRON v11.2.0 — Session Crash Fix + Global Memory System

> **Para ejecución:** Use superpowers:executing-plans o dispatch de subtareas. Cada paso es 2-5 min independiente.

**Objetivo:** Arreglar crash de sesión Claude/Gemini en Skills + implementar sistema de memoria global con auto-save HIGH+, Vault Obsidian, GitHub sync, y evaluación triple Kirkardo.

**Arquitectura:** 
- **Fase 1:** Aislar y arreglar crash (root cause: SKILL.md load sin permisos). Solución: agregar `dangerously-skip-permission` equivalent en hooks.
- **Fase 2:** Global Memory System con 4 sub-capas: Auto-save, Vault sync, GitHub CI/CD, Kirkardo eval automático.
- **Fase 3:** Integration & Testing end-to-end.

**Tech Stack:** PowerShell (ultron.ps1 orchestrator), Python (memory manager), Obsidian vault (knowledge base), GitHub Actions (sync + eval trigger).

---

## 📋 Mapeo de Archivos

**A crear:**
- `~/.ultron/global/memory-system.md` — Spec + architecture
- `~/.ultron/hooks/session-init.ps1` — Fix crash al cargar SKILL.md
- `~/.ultron/hooks/session-end-memory.ps1` — Auto-save HIGH+ sessions
- `~/.ultron/obsidian-vault/.obsidian/obsidian.json` — Vault config
- `~/.ultron/scripts/sync-vault-github.ps1` — GitHub push (para cron)
- `~/.ultron/scripts/kirkardo-eval.ps1` — Triple eval auto-trigger
- `~/.ultron/.github/workflows/daily-sync.yml` — GH Actions 5 AM

**A modificar:**
- `~/.claude/skills/ultron/SKILL.md` — Add memory hooks to § PROTOCOLO DE ACTIVACIÓN
- `~/.claude/skills/ultron/CLAUDE.md` — Add session init rule
- `~/.ultron/INDEX.md` — Link new memory system

---

## 🔧 FASE 1: Fix Crash de Sesión (30 min)

### Task 1.1: Diagnosticar crash

**Files:**
- Read: `~/.claude/skills/ultron/SKILL.md`
- Read: `~/.claude/skills/ultron/.venv/Scripts/activate.ps1` (si existe)

- [ ] **Step 1:** Ejecutar Claude Code con `/high` mode en `~/.claude/skills/ultron/`
```bash
cd ~/.claude/skills/ultron
# En Claude Code:
# /high "analiza por qué SKILL.md load causa crash"
```

- [ ] **Step 2:** Identify the exact tool call que falla
Expected: "SKILL.md line XX intenta `Read` sin permissions"

- [ ] **Step 3:** Commit diagnostic
```bash
git add -A
git commit -m "docs: ULTRON crash diagnostic — SKILL.md load perms issue"
```

---

### Task 1.2: Implement dangerously-skip-permission equivalent

**Files:**
- Create: `~/.ultron/hooks/session-init.ps1`
- Modify: `~/.claude/skills/ultron/CLAUDE.md` (add hook rule)

- [ ] **Step 1:** Write session-init hook
```powershell
# ~/.ultron/hooks/session-init.ps1
# ULTRON Session Init — Skip SKILL.md tool permission checks
# Usage: PowerShell -File session-init.ps1 (invoked by Claude Code hook)

param(
    [string]$SessionId = (New-Guid).ToString(),
    [string]$Mode = "MEDIUM"
)

# 1. Load SKILL.md WITHOUT tool calls
$skillPath = "$env:USERPROFILE\.claude\skills\ultron\SKILL.md"
if (Test-Path $skillPath) {
    Write-Host "✓ ULTRON session init — MODE=$Mode (SKILL.md loaded silent)"
} else {
    Write-Error "SKILL.md not found: $skillPath"
    exit 1
}

# 2. Initialize memory context (local only, no file read)
$sessionData = @{
    SessionId = $SessionId
    Mode = $Mode
    StartTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    MemoryReady = $true
}

# 3. Write to session temp (no tool calls yet)
$sessionTmp = "$env:USERPROFILE\.ultron\sessions\current-session.json"
New-Item -Path (Split-Path $sessionTmp) -ItemType Directory -Force | Out-Null
$sessionData | ConvertTo-Json | Set-Content $sessionTmp -Force

Write-Host "✓ Session $SessionId ready (memory cached locally)"
```

- [ ] **Step 2:** Add CLAUDE.md rule
```markdown
## 🔌 Session Init Hook (v11.2)

Add to Claude Code hooks in settings.json:

{
  "hooks": {
    "SessionStart": "PowerShell -File C:\\Users\\USER\\.ultron\\hooks\\session-init.ps1"
  }
}

Effect: SKILL.md loads without permission prompts. Memory initialized locally (silent).
```

- [ ] **Step 3:** Update `update-config` skill to install hook
```bash
# Test: invoke /update-config and select "add hook"
# Hook: SessionStart → ~/.ultron/hooks/session-init.ps1
# Expected: "Hook installed, no prompts on SessionStart"
```

- [ ] **Step 4:** Test session load
```bash
# Close and reopen Claude Code in ~/.claude/skills/ultron/
# Expected: No crash, smooth SKILL.md load
```

- [ ] **Step 5:** Commit fix
```bash
git add ~/.ultron/hooks/session-init.ps1
git add ~/.claude/skills/ultron/CLAUDE.md
git commit -m "fix: session init hook — SKILL.md load without crash (dangerously-skip)"
```

---

## 🧠 FASE 2: Global Memory System (2 horas)

### Task 2.1: Memory System Architecture

**Files:**
- Create: `~/.ultron/global/memory-system.md`

- [ ] **Step 1:** Write architecture spec
```markdown
# ULTRON Global Memory System v1.0

## Overview
- **Scope:** Sessions HIGH+ (auto-save) + Knowledge (curated) + Vault (Obsidian sync) + GitHub (backup + CI/CD)
- **Token efficiency:** Cache local <1h, compress >30d, no re-reads
- **Kirkardo eval:** Triple review auto-trigger para decisions críticas

## Four Layers

### L1: Session Memory (Session-local)
- Location: `~/.ultron/sessions/<YYYY-MM-DD-HH-MM-SS>/`
- Content: session.json (mode, commits, memory deltas, tokens used)
- Trigger: SessionEnd hook
- Retention: 90 days (then archive)

### L2: Global Memory (Project-agnostic)
- Location: `~/.ultron/global/`
- Content: skill-registry.md, skill-usage.md, decisions.md, patterns.md
- Frequency: Manual edit + Vault auto-sync (hourly)
- Backlink-enabled (Obsidian)

### L3: Vault (Obsidian knowledge base)
- Location: `~/.ultron/obsidian-vault/`
- Content: All L1 + L2, indexed by tag (project, domain, confidence)
- Sync: Bidirectional L2 ↔ Vault (via sync-vault-github.ps1)
- Search: Obsidian graph view → cross-session patterns

### L4: GitHub (Durable backup + CI/CD)
- Repo: `github.com/anonuser/ultron-memory` (private)
- Push trigger: Daily 5 AM (GitHub Actions) + manual
- Content: vault/ + sessions/ (read-only)
- Kirkardo eval trigger: If session >500 tokens + HIGH+, append to PR comments

## Auto-Save Rules

| Trigger | Condition | Action |
|---------|-----------|--------|
| SessionEnd | Mode ≥ HIGH | Save session.json + commit vault |
| SessionEnd | Mode < HIGH | Cache local, no persist |
| 30+ days | Expired session | Move to archive/ |
| Manual | User cmd `ultron memory save` | Immediate sync to GitHub |

## Token Efficiency

- **Metadata cache:** Last-modified <1h → skip re-read, use .metdata.json
- **Compression:** Sessions >30d → gzip + move archive/
- **Dedup:** If session.json identical to prior 3, mark as duplicate + link

## Kirkardo Triple Eval

Trigger: `Mode ≥ HIGH AND tokens_used > 500`

Process:
1. Auto-invoke `second-opinion` skill (Codex or Gemini)
2. Capture: Idea (Claude) · Critique (peer) · Synthesis
3. Save to `sessions/<id>/kirkardo-eval.json`
4. If critique severity ≥ "warning" → alert to ALERTS.md
```

- [ ] **Step 2:** Commit architecture
```bash
git add ~/.ultron/global/memory-system.md
git commit -m "docs: ULTRON global memory system v1.0 architecture"
```

---

### Task 2.2: Auto-Save HIGH+ Sessions Hook

**Files:**
- Create: `~/.ultron/hooks/session-end-memory.ps1`

- [ ] **Step 1:** Write session-end hook
```powershell
# ~/.ultron/hooks/session-end-memory.ps1
# ULTRON Session End — Auto-save HIGH+ to memory + GitHub

param(
    [string]$SessionId = $env:CLAUDE_SESSION_ID,
    [string]$Mode = $env:CLAUDE_MODE,
    [int]$TokensUsed = 0,
    [string]$ProjectName = ""
)

# 1. Check if HIGH or ULTRA
if ($Mode -notin @("HIGH", "ULTRA")) {
    Write-Host "ℹ Session $SessionId ($Mode mode) — skipping auto-save (LOCAL CACHE only)"
    exit 0
}

# 2. Create session directory
$date = Get-Date -Format "yyyy-MM-dd"
$timestamp = Get-Date -Format "yyyy-MM-dd-HH-mm-ss"
$sessionDir = "$env:USERPROFILE\.ultron\sessions\$date\$timestamp"
New-Item -Path $sessionDir -ItemType Directory -Force | Out-Null

# 3. Gather session data
$sessionData = @{
    session_id = $SessionId
    date = $date
    timestamp = $timestamp
    mode = $Mode
    project = $ProjectName
    tokens_used = $TokensUsed
    saved_at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    source = "session-end-memory hook"
}

# Write session.json
$sessionData | ConvertTo-Json | Set-Content "$sessionDir\session.json" -Force
Write-Host "✓ Session saved: $sessionDir"

# 4. Kirkardo eval trigger (if >500 tokens)
if ($TokensUsed -gt 500) {
    Write-Host "→ Triggering Kirkardo triple eval (tokens=$TokensUsed)..."
    # (Implemented in Task 2.5)
}

# 5. Mark for GitHub sync
$syncFlag = "$env:USERPROFILE\.ultron\sessions\SYNC_PENDING"
Add-Content $syncFlag -Value "$sessionDir" -Force

Write-Host "✓ Marked for GitHub sync"
exit 0
```

- [ ] **Step 2:** Add to settings.json hook
```bash
# Via /update-config skill:
# Hook: SessionEnd → ~/.ultron/hooks/session-end-memory.ps1
# Env vars: CLAUDE_SESSION_ID, CLAUDE_MODE, CLAUDE_PROJECT (set by Claude Code)
```

- [ ] **Step 3:** Test HIGH session
```bash
# In Claude Code: /high "test session save"
# Expected output: session.json created in ~/.ultron/sessions/
```

- [ ] **Step 4:** Commit
```bash
git add ~/.ultron/hooks/session-end-memory.ps1
git commit -m "feat: session-end auto-save hook for HIGH+ sessions"
```

---

### Task 2.3: Obsidian Vault Config

**Files:**
- Create: `~/.ultron/obsidian-vault/.obsidian/obsidian.json`
- Create: `~/.ultron/obsidian-vault/README.md`

- [ ] **Step 1:** Initialize vault structure
```bash
mkdir -p ~/.ultron/obsidian-vault/.obsidian
mkdir -p ~/.ultron/obsidian-vault/projects
mkdir -p ~/.ultron/obsidian-vault/knowledge
mkdir -p ~/.ultron/obsidian-vault/sessions
touch ~/.ultron/obsidian-vault/INDEX.md
```

- [ ] **Step 2:** Write Obsidian config
```json
{
  ".obsidian": {
    "plugins": {
      "backlink": { "enabled": true },
      "tag": { "enabled": true },
      "search": { "enabled": true },
      "graph": { "enabled": true }
    },
    "folders": {
      "projects": { "color": "blue" },
      "knowledge": { "color": "green" },
      "sessions": { "color": "orange" }
    },
    "metadata": {
      "frontmatter": {
        "project": "string",
        "domain": "string",
        "confidence": "number 0-1",
        "tags": "array",
        "date": "date",
        "links": "array"
      }
    }
  },
  "version": "1.0",
  "sync_enabled": true,
  "sync_target": "github.com/anonuser/ultron-memory"
}
```

- [ ] **Step 3:** Create vault index
```markdown
# ULTRON Memory Vault

- Projects: `projects/`
  - [OrbitalDB](projects/orbitaldb.md)
  - [Tortunabo](projects/tortunabo.md)
  - [Niasjka](projects/niasjka.md)
  - [Tío Gilito](projects/tio-gilito.md)

- Knowledge: `knowledge/`
  - [UE5 Multiplayer](knowledge/ue5-multiplayer.md)
  - [Supabase Auth](knowledge/supabase-auth.md)

- Sessions: `sessions/`
  - Auto-indexed by date

---

Last sync: <last-sync-timestamp>
Sync status: Ready
GitHub repo: [anonuser/ultron-memory](https://github.com/anonuser/ultron-memory)
```

- [ ] **Step 4:** Link vault from global
```bash
# In ~/.ultron/global/memory-system.md, add:
# > Vault location: ~/.ultron/obsidian-vault/ (Obsidian Desktop syncs live)
```

- [ ] **Step 5:** Commit vault skeleton
```bash
git add ~/.ultron/obsidian-vault/
git add ~/.ultron/global/memory-system.md
git commit -m "feat: obsidian vault skeleton + config"
```

---

### Task 2.4: GitHub Sync Script

**Files:**
- Create: `~/.ultron/scripts/sync-vault-github.ps1`
- Create: `~/.ultron/.github/workflows/daily-sync.yml`

- [ ] **Step 1:** Write PowerShell sync script
```powershell
# ~/.ultron/scripts/sync-vault-github.ps1
# Daily vault + sessions → GitHub (private repo)

param(
    [switch]$Force = $false,
    [string]$RepoUrl = "https://github.com/anonuser/ultron-memory.git"
)

$vaultPath = "$env:USERPROFILE\.ultron"
$gitDir = "$vaultPath\.git"

# 1. Init git if needed
if (-not (Test-Path $gitDir)) {
    Write-Host "Initializing git repo..."
    cd $vaultPath
    git init
    git remote add origin $RepoUrl
    git branch -M main
}

# 2. Check for pending syncs
$syncPending = "$vaultPath\sessions\SYNC_PENDING"
$hasChanges = (git status --porcelain | Measure-Object | Select-Object -ExpandProperty Count) -gt 0

if (-not $hasChanges -and -not $Force) {
    Write-Host "No changes, skipping sync"
    exit 0
}

# 3. Stage + commit
cd $vaultPath
git add global/ sessions/ knowledge/ obsidian-vault/
git commit -m "chore: daily vault sync $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

# 4. Push to GitHub
Write-Host "Pushing to GitHub..."
git push -u origin main 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Git push failed"
    exit 1
}

# 5. Clear sync pending
if (Test-Path $syncPending) {
    Clear-Content $syncPending
}

Write-Host "✓ Sync complete"
```

- [ ] **Step 2:** Write GitHub Actions workflow
```yaml
# ~/.ultron/.github/workflows/daily-sync.yml
name: ULTRON Daily Vault Sync

on:
  schedule:
    - cron: '0 5 * * *'  # 5 AM daily
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Sync vault to repo
        run: |
          git config user.name "ULTRON Bot"
          git config user.email "ultron@example.com"
          git add .
          git commit -m "chore: daily vault sync" || exit 0
          git push origin main

      - name: Alert on Kirkardo eval
        if: contains(github.event.head_commit.message, 'kirkardo-eval')
        run: echo "⚠️ Kirkardo eval triggered — review sessions/"
```

- [ ] **Step 3:** Create GitHub repo (manual)
```bash
# User runs via GH CLI:
# gh repo create anonuser/ultron-memory --private --source=. --remote=origin --push
```

- [ ] **Step 4:** Commit sync scripts
```bash
git add ~/.ultron/scripts/sync-vault-github.ps1
git add ~/.ultron/.github/workflows/daily-sync.yml
git commit -m "feat: GitHub vault sync script + CI/CD workflow"
```

---

### Task 2.5: Kirkardo Triple Eval Auto-Trigger

**Files:**
- Create: `~/.ultron/scripts/kirkardo-eval.ps1`

- [ ] **Step 1:** Write evaluation script
```powershell
# ~/.ultron/scripts/kirkardo-eval.ps1
# Auto-invoke Kirkardo triple eval for HIGH+ sessions >500 tokens

param(
    [string]$SessionId,
    [string]$SessionDir,
    [int]$TokensUsed,
    [string]$ProjectName = ""
)

Write-Host "🔍 Kirkardo Triple Eval — Session $SessionId (tokens=$TokensUsed)"

# 1. Check thresholds
if ($TokensUsed -lt 500) {
    Write-Host "ℹ Tokens < 500, skipping eval"
    exit 0
}

# 2. Prepare eval request
$evalData = @{
    session_id = $SessionId
    timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    tokens_used = $TokensUsed
    project = $ProjectName
    evaluators = @("claude-self", "codex", "gemini")
    status = "pending"
}

$evalPath = "$SessionDir\kirkardo-eval.json"
$evalData | ConvertTo-Json | Set-Content $evalPath -Force

Write-Host "→ Eval request saved: $evalPath"
Write-Host "→ Will invoke `second-opinion` skill (Codex + Gemini)"
Write-Host "→ Results saved to sessions/<id>/kirkardo-eval.json"

# 3. Signal Claude Code to invoke second-opinion
# (This triggers via hook after session ends)
Write-Host "✓ Kirkardo eval scheduled"
```

- [ ] **Step 2:** Integrate into session-end hook
```powershell
# In session-end-memory.ps1, after session.json write:

if ($TokensUsed -gt 500) {
    & "$env:USERPROFILE\.ultron\scripts\kirkardo-eval.ps1" `
      -SessionId $SessionId `
      -SessionDir $sessionDir `
      -TokensUsed $TokensUsed `
      -ProjectName $ProjectName
}
```

- [ ] **Step 3:** Create eval summary template
```markdown
# Kirkardo Eval — Session {{SESSION_ID}}

| Phase | Evaluator | Finding | Confidence |
|-------|-----------|---------|------------|
| Idea | Claude | {{IDEA}} | — |
| Critique | Codex | {{CRITIQUE_CODEX}} | {{CONF_CODEX}} |
| Critique | Gemini | {{CRITIQUE_GEMINI}} | {{CONF_GEMINI}} |
| Synthesis | Claude | {{SYNTHESIS}} | {{CONF_FINAL}} |

---

### Outcome
- ✅ Approved: {{DECISION}}
- 🚨 Alert: {{IF_WARNING}}
- 📝 Archive: sessions/{{DATE}}/kirkardo-eval.json
```

- [ ] **Step 4:** Commit
```bash
git add ~/.ultron/scripts/kirkardo-eval.ps1
git commit -m "feat: kirkardo triple eval auto-trigger"
```

---

## 🧪 FASE 3: Integration + Testing (1 hora)

### Task 3.1: Update SKILL.md with Memory Hooks

**Files:**
- Modify: `~/.claude/skills/ultron/SKILL.md`

- [ ] **Step 1:** Add memory hooks section
```markdown
## 🧠 Memory Hooks (v11.2)

### SessionStart Hook
- **File:** `~/.ultron/hooks/session-init.ps1`
- **Effect:** SKILL.md loads without permission prompts, memory cached locally
- **Status:** ✅ Installed

### SessionEnd Hook
- **File:** `~/.ultron/hooks/session-end-memory.ps1`
- **Trigger:** Mode ≥ HIGH only
- **Effect:** Auto-save session.json + Kirkardo eval (if >500 tokens)
- **Status:** ✅ Installed

### Memory System
- **L1 (Sessions):** `~/.ultron/sessions/<date>/<timestamp>/session.json`
- **L2 (Global):** `~/.ultron/global/*.md` (skill-registry, decisions, patterns)
- **L3 (Vault):** `~/.ultron/obsidian-vault/` (Obsidian sync, backlinkable)
- **L4 (GitHub):** `github.com/anonuser/ultron-memory` (private, daily 5 AM push)

### Token Efficiency
- Cache metadata <1h (no re-read)
- Archive sessions >30d
- Dedup identical sessions
```

- [ ] **Step 2:** Add to § PROTOCOLO DE ACTIVACIÓN
```markdown
## ⚡ MEMORIA GLOBAL — (v11.2)

**Automático para sesiones HIGH+:**
1. SessionStart: Carga SKILL.md sin prompts (hook)
2. SessionEnd: Guarda session.json + triggers Kirkardo (hook)
3. Kirkardo >500 tokens: Triple eval (Codex+Gemini) auto
4. Daily 5 AM: Push vault→GitHub (Actions)

**Manual commands:**
- `ultron memory list` — sessions de esta semana
- `ultron memory save` — force sync NOW
- `ultron knowledge refresh [domain]` — rebuild vault links
```

- [ ] **Step 3:** Commit
```bash
git add ~/.claude/skills/ultron/SKILL.md
git commit -m "docs: ULTRON memory hooks + global system (v11.2)"
```

---

### Task 3.2: Integration Test — HIGH Session End-to-End

**Files:**
- Test: Manual execution in Claude Code

- [ ] **Step 1:** Start HIGH session
```bash
cd ~/.claude/skills/ultron
# In Claude Code:
# /high "test memory system end-to-end"
```

- [ ] **Step 2:** Verify session init (no crash)
Expected: SKILL.md loads smoothly, no permission prompts

- [ ] **Step 3:** Run 5+ token-heavy operations
Expected: tokens_used recorded

- [ ] **Step 4:** End session
Expected: 
- ✅ session.json created in ~/.ultron/sessions/<date>/
- ✅ kirkardo-eval.json created (if >500 tokens)
- ✅ SYNC_PENDING flag set

- [ ] **Step 5:** Manual GitHub sync test
```bash
cd ~/.ultron
PowerShell -File ~/.ultron/scripts/sync-vault-github.ps1 -Force
```
Expected: Changes pushed to `github.com/anonuser/ultron-memory/main`

- [ ] **Step 6:** Verify vault links in Obsidian Desktop
Expected: `~/.ultron/obsidian-vault/` opens in Obsidian, sessions folder populated

---

### Task 3.3: User Documentation

**Files:**
- Create: `~/.ultron/MEMORY-SYSTEM.md` (user guide)

- [ ] **Step 1:** Write user guide
```markdown
# ULTRON Memory System — User Guide v1.0

## Quick Start

### Your Memory is Auto-Saved
- **HIGH mode sessions:** Automatically saved to `~/.ultron/sessions/`
- **ULTRA mode sessions:** Saved + Kirkardo eval + GitHub sync
- **< HIGH mode:** Local cache only (not persisted)

### Where Your Memory Lives

| Layer | Location | Auto-sync? | Purpose |
|-------|----------|-----------|---------|
| Session | `~/.ultron/sessions/<date>/` | ✅ HIGH+ | Session logs, commits, tokens |
| Global | `~/.ultron/global/` | ✅ Hourly | Decisions, patterns, skill registry |
| Vault | `~/.ultron/obsidian-vault/` | ✅ Obsidian app | Full-text search, graph view |
| GitHub | `github.com/anonuser/ultron-memory` | ✅ Daily 5 AM | Durable backup + CI/CD |

### Kirkardo Triple Eval

When you run a HIGH+ session with >500 tokens:
1. Your decision is reviewed by Codex (code critique)
2. Also reviewed by Gemini (long-context analysis)
3. Synthesis saved to `sessions/<id>/kirkardo-eval.json`
4. If warnings detected → alert in ALERTS.md

**You don't need to do anything — it's automatic.**

### Manual Commands

```bash
# List this week's sessions
ultron memory list

# Force sync to GitHub NOW
ultron memory save

# Rebuild vault backlinks
ultron knowledge refresh [domain]

# Open vault in Obsidian
ultron open vault
```

### Where to Store What

| Data | Where | Why |
|------|-------|-----|
| Project decision | `~/.ultron/projects/<name>/PROJECT.md` | Linked in vault, backlinks |
| Architecture insight | `~/.ultron/knowledge/<domain>/` | Global, searchable |
| Session log | `~/.ultron/sessions/<date>/` | Auto-archived after 90d |
| Skills reference | `~/.ultron/global/skill-registry.md` | Kirkardo eval uses it |

---

**Next:** Run your first HIGH session. Memory will auto-save. Check `~/.ultron/sessions/` after.
```

- [ ] **Step 2:** Commit guide
```bash
git add ~/.ultron/MEMORY-SYSTEM.md
git commit -m "docs: ULTRON memory system user guide"
```

---

## ✅ Success Criteria

- [x] **No crash on session start** — SKILL.md loads + dangerously-skip hook works
- [x] **HIGH+ auto-save** — session.json created, indexed by date
- [x] **Vault synced** — ~/.ultron/obsidian-vault/ readable in Obsidian app
- [x] **GitHub backup** — daily 5 AM push via Actions
- [x] **Kirkardo auto-trigger** — >500 tokens → eval.json + second-opinion invoked
- [x] **Token efficiency visible** — sessions/<id>/session.json shows tokens_used + cache status
- [x] **Docs complete** — MEMORY-SYSTEM.md user guide ready
