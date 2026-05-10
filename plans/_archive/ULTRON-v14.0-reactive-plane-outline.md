---
type: architecture-outline
version: v14.0 "The Reactive Plane"
created: 2026-05-03
status: HORIZON (no implementation, no schedule yet)
parent_audit: kirkardo-total-triple-2026-05-03
inspired_by: Gemini CLI Phase-3 SOTA recommendation
estimated_effort: 2-4 semanas
---

# ULTRON v14.0 "The Reactive Plane" — Outline

## Premisa

Gemini Phase-3 SOTA evaluation (gemini-3.1-pro-preview):

> "**Nuke the custom imperative Python Cockpit and rebuild the Orchestration Plane on an Event-Driven Graph.**
> ULTRON is suffocating under imperative technical debt — a single comma killed cron for 3 days. Transitioning to a reactive state-machine (LangGraph or local equivalent) shifts ULTRON from a static script runner to a true 2026 autonomous agent."

Score Gemini SOTA actual: Innovation 8.5 · **Robustness 3.0** · Maintainability 4.0 · Security 5.0 · Capability ceiling 9.5.

v14.0 ataca Robustness y Maintainability levantando el ceiling.

## Filosofía

- **Imperative → Reactive:** scripts como nodos en grafo, transiciones explícitas, retries automáticos.
- **Hand-coded → Learned:** routing FAST PATH regex → semantic embedding router cached.
- **FTS5 → Hybrid:** sparse (FTS5) + dense (LanceDB/Chroma vectors) en pipeline.
- **Stdout logs → OpenTelemetry:** structured tracing, sampling, dashboards locales.
- **Manual sprints → Auto-regression:** Kirkardo regression detector + CI canary.

## Mejoras propuestas (high-level)

### 1. State-machine reactiva para cockpit
- Reemplazar cron jobs imperativos (`should_run.py` + `retention.py` + `ai_standup.py` + ...) por un grafo declarativo.
- Candidatos: **LangGraph** (Python, ya familiar a USER), **Inngest local**, **Temporal Lite**, o implementación custom minimal.
- Beneficio: single-comma errors no derriban TODO. Cada nodo tiene retry/timeout/fallback explícito. State observable.

### 2. Semantic Router (reemplaza mode-trigger.py 13s)
- Embeddings cached del prompt → similarity vs persona descriptions.
- Top-3 personas con score → dispatcher elige por threshold.
- Fallback a regex FAST PATH si embedding falla.
- Beneficio: latencia <50ms vs 13s. Tolerante a frases nuevas. Aprende de routing telemetry.

### 3. Vector DB Hybrid Memory
- **LanceDB local** (Rust + Python bindings, embedded, no server) o **Chroma**.
- Conserva FTS5 para keyword exacto + añade dense embeddings para semántico.
- Dual retrieval: `MATCH x | embed(x) → top-K` → reranker → context inject.
- Beneficio: 9 personas que ignoran memoria pueden recuperar relevante via embedding sin tener que conocer keywords exactos.

### 4. Universal Sandbox
- Reemplazar bashlex AST por sandbox cross-shell:
  - **Bash:** bashlex (existing)
  - **PowerShell:** PSReadLine AST (PowerShell 7 has native AST)
  - **CMD:** simple regex (limited grammar)
  - **WSL:** delegate to bashlex inside WSL
- Unified policy file: `~/.ultron/sandbox-policy.json` con reglas declarativas.
- Beneficio: cierra el bypass `pwsh -c "Remove-Item ..."` que F05 mitiga parcialmente.

### 5. OpenTelemetry tracing
- Reemplazar `stop-memory-sync.log` y otros stdout logs por traces OpenTelemetry.
- Backend: Jaeger local o **uptrace** o simplemente JSONL structured logs.
- Cada hook fire = un trace. Cada subprocess spawn = un span hijo.
- Dashboard local con duración de hooks, error rate, retry counts.
- Beneficio: latencia perceptible debugable. Detección de regression performance.

### 6. Pre-commit syntax check para cockpit
- `pre-commit-config.yaml` con `ruff` + `pytest --collect-only` para `~/.claude/skills/ultron/scripts/cockpit/*.py`.
- GitHub Actions opcional si USER decide push del control plane a GitHub.
- Beneficio: nunca más una coma huérfana en should_run.py durmiendo 3 días.

### 7. Meta-Kirkardo trimestral
- `kirkardo-rubric.json` versionado.
- Cada quarter: Kirkardo TOTAL Triple sobre `repo-evaluator/SKILL.md` mismo (auditor se audita).
- Detecta drift de la rúbrica (¿se está volviendo más permisivo? ¿hay sesgos?).

### 8. Regression Detector Automatizado
- `kirkardo_regression.py audit-A audit-B`:
  - Diff por finding-id
  - Reporta: persistent (en ambos), resolved (en A, no en B), new (no en A, sí en B)
  - Heatmap de findings recurrentes
- Integración con `pending_actions.json` para auto-priorizar persistents.

### 9. Semantic Skill Discovery
- En lugar de `skill_discover.py` regex match, embedding-based skill matcher.
- Query "mi PR de Vercel falla" → top skills: `vercel-deploy`, `ci-cd-debugger`, `devops-incident-responder`.
- Beneficio: 330 skills "huérfanas" del routing-tables.md se vuelven descubribles.

### 10. TUI rehab definitivo o eliminar
- 105KB tui.py "DEGRADED/disabled" sin plan.
- Decisión: o se rehab + valida (~3 días) o se elimina + se documenta CLI alternative.
- Si rehab: usar Textual moderno (no la versión original 105KB de un solo archivo).

### 11. Test suite ≥60% cobertura
- Pytest harness completo para `scripts/cockpit/*.py`.
- Smoke tests: cada subcomando de `ultron.ps1` ejecuta sin error.
- Property tests para invariants críticos (job exit_code, manifest schema).

### 12. Async memory pipeline
- Stop hook actualmente: 5 jobs paralelos via `Start-Job` PowerShell + Wait-Job global.
- Reemplazar por async Python (`asyncio.gather`) o continuations en state-machine.
- Beneficio: latencia Stop más predecible.

### 13. CLI Cred Manager Wrapper
- Wrapper Python sobre Windows Credential Manager.
- Eliminar definitivamente plaintext keys en `.claude.json`.
- API: `creds.get("gemini_api_key")` → secure.
- Beneficio: F02 cierra estructuralmente, no como fix puntual.

### 14. PII Scanner pre-push
- Pre-push hook git que escanea diffs por patrones PII (email, IBAN, paths con username).
- Bloquea push si encuentra PII en lugar de redactar manualmente post-hoc.
- Beneficio: cierra el riesgo de leak vault L3 a GitHub público accidental.

### 15. Multi-machine sync (opcional)
- ULTRON portable a otros Windows + Linux machines via `ultron_paths` + envvars.
- ARCH-01 v13.0 lo habilita; v14.0 podría completar para WSL/Linux.

---

## Enfoque incremental sugerido

**Fase 14.1 (semana 1):** OpenTelemetry tracing + pre-commit hooks + test suite 30%
**Fase 14.2 (semana 2):** Universal sandbox + cred manager wrapper + regression detector
**Fase 14.3 (semana 3):** Vector DB hybrid + semantic skill discovery
**Fase 14.4 (semana 4):** State-machine cockpit migration + semantic router
**Fase 14.5 (opcional):** TUI rehab/elim + multi-machine

NO **big-bang rewrite**. Cada fase es shippable independientemente.

---

## Riesgos

- **Scope creep:** v14.0 toca todo. Disciplina necesaria para fasear.
- **LangGraph dependency:** añade Python deps pesadas. Alternativa: implementación minimal custom.
- **Vector DB cost:** LanceDB embeddings storage = ~2x size brain_index. Aceptable.
- **Regression risk:** state-machine migration podría romper Stop hook. Feature flag `ULTRON_REACTIVE_PLANE=1` con fallback.

## Dependencies

- v13.0 shipped (truth boundary establecido, audits→FTS5, kirkardo-rubric)
- Decisión sobre framework state-machine (LangGraph vs custom)
- Embedding model local (sentence-transformers o all-MiniLM)

## NO en v14.0

- Migrar a Linux nativo (WSL OK pero no nativo)
- Reescritura full Python → Rust/Go
- Multi-user / SaaS-ización
- Replace Claude Code (sigue siendo la base)

---

## Score forecast

Si v14.0 fases 14.1-14.4 completadas:

| Dim | v13.0 forecast | v14.0 forecast |
|---|---:|---:|
| Innovation | 8.5 | 9.2 (state-machine + semantic + hybrid memory) |
| Robustness | 6.0 | 9.0 (pre-commit + tests + retries + traces) |
| Maintainability | 6.0 | 8.5 (state declarado, cobertura ≥60%) |
| Security | 7.0 | 8.5 (universal sandbox + cred manager) |
| Capability ceiling | 9.5 | 9.7 |
| **Global** | **~8.4** | **~9.0** |

Ceiling 9.5+ requiere meta-Kirkardo + regression auto + audits→FTS5 todos en producción.
