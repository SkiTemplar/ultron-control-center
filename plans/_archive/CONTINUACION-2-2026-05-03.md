---
type: handoff
date: 2026-05-03
session_part: 2 (post-Sprint-3-F13-F14)
nota_estimada: 8.0/10
sprints_done_so_far: [1.*, 2.F12, 2.F2.*, 2.FIX3.1, 3.F13, 3.F14]
sprints_pending: [3.F1 secret-manager, 3.OPS-01, 4 telemetry-routing]
---

# CONTINUACIÓN 2 — handoff post Sprint 3 F13/F14

> Sistema **100% funcional + 107 tests pass**. Sprint 3 mitad completa. Nota estimada: **8.0/10** (target Sprint 3 era 8.2 — overshoot lateral con AST).

---

## ✅ Sprint 3 progress (esta sesión)

### F13 — block-dangerous-bash v3.0 con bashlex AST ✅
- Reemplaza regex-only con AST walker que recursea en `$()`/`<()`
- **Cierra los 9 bypass categories** documentadas en Kirkardo TOTAL v2:
  - base64-in-cmdsub, rm-rf relative paths, process substitution
  - inline interpreter (python/node/perl -c/-e)
  - exfil via nc, curl POST con file payload
- Fallback regex preservado si bashlex falla parse (defensa en profundidad)
- bashlex 0.18 instalado vía pip user-scope + uv venv
- **Tests: 107 passed, 0 failed, 0 xfail** (era 98 + 9 xfail). +9 detections nuevas.

### F14 — consistency_check.py rename + Stop wiring ✅
- Rename `consistency-check.py` → `consistency_check.py` (Python convention; original preservado como deprecated stub)
- KNOWN_PERSONAS ahora derivado de `personas_ssot._canonical_names()` (no hardcoded)
- Nuevo flag `--quiet` para hook mode: silencia stdout, escribe findings a `pending_actions` con severity=high si hay drift
- Wired a `stop-memory-sync.ps1` Phase A con `Start-Job + Wait-Job -Timeout 15`
- Auto drift detection en cada Stop event (zero manual intervention)

---

## 🎯 Estado actual sistema

| Métrica | Valor |
|---|---|
| Tests pass | **107/107** (98 pytest + 9 ex-xfail closed by AST + Pester implícito) |
| Frontmatter coverage | 373/373 (100%) |
| Personas SSOT | 14 canonical + 2 aliases, no conflicts |
| Manifest CI gate | active in `skill_manifest.py rebuild` |
| Hook AST | bashlex v3.0 catches all known bypasses |
| Stop drift detection | auto every Stop (Phase A consistency_check 15s timeout) |
| skipDangerousModePermissionPrompt | false |
| gitleaks | 8.30.1 in PATH, vault scan clean |
| Gemini Triple Mode | gemini-3.1-pro-preview default |

---

## 🔧 Sprint 3 PENDIENTE para próxima sesión

### F1 — Secret Manager Windows Credential Manager + DPAPI (3-4h)
**Goal:** migrar OAuth tokens + clientSecrets de `.credentials.json` a Windows nativo.

Pasos:
1. `cockpit/secrets_loader.py` — Python module:
   - Read tokens from `.credentials.json`
   - Write each `service:token` to Windows Credential Manager via `cmdkey /generic` o pywin32
   - Encrypt remaining `.credentials.json` con DPAPI (`win32crypt.CryptProtectData`)
2. PowerShell `secrets-loader.ps1` (already exists) — extend:
   - Auto-load env vars on shell start (`$PROFILE`)
   - Decrypt + extract on demand
3. Test full lifecycle: store → retrieve → use → rotate
4. Document migration in `~/.ultron/secrets-manifest.md`
5. Acceptance: `.credentials.json` < 1KB plaintext, tokens en Credential Manager

### OPS-01 — Stop pipeline idempotente (6-10h)
**Goal:** Phase A jobs paralelos + file lock current-session.json.

Pasos:
1. Refactor `stop-memory-sync.ps1`:
   - Wrap memory_bridge + brain_index + route_quality_aggregator + decay_queue + consistency_check en `Start-Job` paralelo
   - `Wait-Job -Job @($jobs) -Timeout 30` global
   - Si timeout → kill all + log + exit 0
2. File lock `current-session.json`:
   - Use Windows native `LockFileEx` o `.lock` sentinel con stale detection 5s
   - Atomic temp-rename pattern para writes
3. Track-knowledge-reads + mode-trigger.py: read-modify-write con lock
4. Acceptance: Stop hook < 30s wall clock, no race conditions

### Sprint 4 — Telemetry-driven routing (1-2 sem next)
- F3 Thompson sampling en route_quality
- F11 pending_actions auto-write desde Kirkardo
- DLQ disciplina enforced

---

## 🚀 Cómo retomar

`"sigue Sprint 3 F1"` o `"continúa"` — yo arranco con secret manager.

---

## 🧪 Verificación rápida

```powershell
cd $env:USERPROFILE\.claude\skills\ultron
uv run pytest tests/hooks/ -q                                          # 107 pass
uv run python scripts/consistency_check.py --quiet; echo $LASTEXITCODE  # 0 = clean
uv run python scripts/cockpit/personas_ssot.py --check                  # OK 14+2
uv run python scripts/cockpit/skill_manifest.py rebuild                 # CI gate pass
gitleaks version                                                         # 8.30.1
```

---

## 📊 Files Sprint 3 esta sesión

**Nuevos:**
- `~/.claude/skills/ultron/scripts/consistency_check.py` (renamed + wired)

**Modificados:**
- `~/.claude/skills/ultron/hooks/block-dangerous-bash.py` (v3.0 bashlex AST)
- `~/.claude/skills/ultron/tests/hooks/test_block_dangerous_bash.py` (xfail markers removed)
- `~/.ultron/hooks/stop-memory-sync.ps1` (consistency_check Phase A wire)

**Dependencias:**
- bashlex 0.18 (pip user + uv venv)

---

## 🎯 Nota progresión

4.4 (AM) → 6.0 (v2 PM) → 7.0 (v3 post-Sprint1) → 7.5 (post-Sprint2) → **8.0 (post-Sprint3 F13+F14)** → target 9.0 al final Sprint 4 (~2 semanas más con F1 + OPS-01 + Sprint 4 completo).

**Sistema robusto, hardenizado, con drift auto-detection. Sprint 3 mitad para 9.0.**
