---
title: ULTRON — MASTER de pendientes (auto-generado)
date: 2026-05-09
status: ACTIVE — single source: PLANS.json
source: ~/.ultron/plans/PLANS.json
---

# ULTRON — MASTER de pendientes

> **Auto-generado desde `PLANS.json` por `ultron plans render`.**
> No editar este .md manualmente — usa los comandos `ultron plans add|done|defer|reopen`.

**Snapshot:** 17 open · 0 in-progress · 2 deferred · 2 resolved · 21 total

## 📋 ABIERTOS (17)

| Pri | Kind | ID | Título | Effort | Tags |
|---|---|---|---|---|---|
| p0 | 🐛 Bug | `si-p0-2` | pending_actions.py no valida timestamps futuros ni rechaza inyecciÃ³n sin producer | 2-4h | security, hardening, queue |
| p1 | 🚀 Sprint | `arch-01-ssot` | SSOT contractual + paths resolver (3 manifests â†’ 1) | 8-12h | architecture, refactor |
| p1 | 🚀 Sprint | `ops-01-stop-pipeline` | Stop pipeline idempotente (timeout global, file lock) | 6-10h | hooks, concurrency |
| p1 | 🚀 Sprint | `v14.9-structure` [📄](~/.ultron/plans/2026-05-09-v14.9-STRUCTURE.md) | Migrar scripts/tests/hooks de .claude a .ultron | 2-3h | structure, migration |
| p1 | 🚀 Sprint | `v15.0-installer` [📄](~/.ultron/plans/specs/v15.0-installer.md) | Publicar ULTRON en GitHub + instalador personalizable | 10-14h | release, installer, open-source |
| p2 | ✨ Polish | `doctor-warns-cleanup` | Reducir las 47 warnings restantes de doctor (deadwood, drifts misc) | 1-2h | doctor, cleanup |
| p2 | ✨ Polish | `fix-2-d3-hook-tests` | D3 security authority + hook test corpus | 4-6h | security, tests, hooks |
| p2 | ✨ Polish | `fix-4-lifecycle-hooks` | Lifecycle hooks bounded + atomic | 3-5h | hooks, atomic |
| p2 | ✨ Polish | `fix-5-feedback-loops` | Wire feedback loops (Codex #5) | 2-4h | feedback, telemetry |
| p2 | ✨ Polish | `si-p1-b-auto-updater` | auto_updater.py L2/L3 expuestos con --dangerously-skip-permissions | 2-3h | auto-updater, self-improve |
| p2 | ✨ Polish | `tui-buttons-meta-prompter` | TUI buttons para v14.5 META-PROMPTER (Mejorar / Eval) | 1-2h | tui, ux |
| p2 | ✨ Polish | `ultron-skill-md-budget` | SKILL.md de ULTRON excede budget de tokens (3850 > 3000) | 1-2h | tokens skill-md budget |
| p2 | 🌟 Nueva dirección | `v15.1-bus-foundation` | Cross-session bus: MCP server + mailbox + registry | 32-40h | automation, cross-session, bus |
| p2 | 🌟 Nueva dirección | `v15.2-supervisor` | Supervisor daemon que lanza sesiones desde queue | 24-32h | automation, cross-session |
| p2 | 🌟 Nueva dirección | `v15.3-pipeline` | DAG scheduler con dependencies (plan YAML) | 24-32h | automation, cross-session |
| p2 | 🌟 Nueva dirección | `v15.4-overnight` | Overnight loop timeboxed con kill-switches | 16-24h | automation, cross-session, safety |
| p2 | 🌟 Nueva dirección | `v15.5-mobile` | ULTRON Remote â€” PWA mobile via Tailscale | 40-56h | mobile, pwa, remote |

## ⏸  DIFERIDOS (2)

| Pri | Kind | ID | Título | Effort | Tags |
|---|---|---|---|---|---|
| p2 | 🔬 Research | `gemini-mcp-rate-limit` | Gemini Pro MCP rate-limit en API key plana | 0-1h | mcp, gemini |
| p2 | 🔬 Research | `scan-projects-claude-md` | scan_projects: heurÃ­stica para carpetas-contenedoras CLAUDE.md | 2-3h | scanner, ux |

## ✅ RESUELTOS (recientes) (2)

| Pri | Kind | ID | Título | Effort | Tags |
|---|---|---|---|---|---|
| p1 | 🚀 Sprint | `intent-rules-precision` | Refactor intent-rules.yaml: word-boundaries + contexto exigido para todas las reglas | 3-5h | routing detection precision |
| p1 | 🚀 Sprint | `v15.0-spec-doc` | v15.0 spec ya escrito | 0-1h | doc spec |

---

## 🎯 DETALLE: en curso + p0 abiertos

### `si-p0-2` — pending_actions.py no valida timestamps futuros ni rechaza inyecciÃ³n sin producer

Hardening del propio queue de pending actions. AÃ±adir: validar created_at/resolved_at <= now+5min, rechazar entries sin campo `producer`, schema validate al cargar, tests de inyecciÃ³n.

---
*Última render: 2026-05-09T22:25:36+02:00. Comandos: `ultron plans list|add|done|defer|render|clean`.*
