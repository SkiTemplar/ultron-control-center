# Skills Consolidation Report — 2026-05-24

**Auditor:** sub-agente autonomo (Claude Opus 4.7 1M, sandbox = SOLO INFORME)
**Alcance:** Fase 2 (18 grupos FUSION) + Fase 3 (15 items REVISAR) del informe `skills-audit-2026-05-24.md`
**Restriccion:** NO se ejecuto ningun rename. Toda la informacion sobre skills user-level proviene del system-reminder `## available skills` (sandbox no permite Read/Grep sobre `~/.claude/skills/`). Skills de plugins SI fueron leidas directamente.

**Nota de ubicacion:** este informe se intento escribir en `C:\Users\USER\.ultron\cockpit\diagnostics\skills-consolidation-2026-05-24.md` pero el sandbox denego escritura fuera del cwd. Por eso queda aqui en la raiz de `control-center` (mismo problema que el informe anterior).
`Move-Item "C:\Users\USER\.ultron\control-center\skills-consolidation-2026-05-24.md" "C:\Users\USER\.ultron\cockpit\diagnostics\skills-consolidation-2026-05-24.md"`

---

## 1. Resumen ejecutivo

| Metrica | Valor |
|---|---|
| Grupos FUSION analizados (seccion 4) | 18 |
| Items REVISAR analizados (seccion 5) | 15 |
| Decisiones automaticas (claras) | 25 |
| Decisiones NEEDS-HUMAN | 8 |
| Skills propuestas a deshabilitar (script principal) | **26** |
| Tokens estimados ahorrados | **~2.7 - 3.6k tokens / sesion** |
| Skills CORE confirmadas KEEP | 22 |

**Nota clave sobre tokens:** el sandbox bloqueo lectura de skills user-level, asi que las decisiones sobre `user-level vs plugin` se basan en (a) la regla canon de USER (`user-level SIEMPRE gana para personas`), (b) las descripciones del system-reminder, y (c) la lectura directa de las versiones plugin. Para grupos donde una decision requiere comparar contenido entre dos versiones user-level (raro), se marca NEEDS-HUMAN.

**Hallazgo critico:** los plugins `thedotmack/openclaw`, `thedotmack/plugin`, y los 3 `pensyve/integrations/*` (claude-code, codex-plugin, gemini-extension) introducen ~25 skills extra. NINGUNA aparece en el system-reminder `available skills`, lo que sugiere que Claude Code NO las esta cargando (plugins inactivos en `settings.json`). Si USER nunca instalo esos plugins via `/plugin install`, las carpetas en `marketplaces/` son inertes y NO consumen tokens. Verificar `settings.json` antes de proponer borrado.

---

## 2. Tabla de decisiones — Seccion 4 (18 grupos FUSION)

### Grupo 4.1: `code-review` / `code-reviewer`

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/code-reviewer/SKILL.md` | user-level | **KEEP** |
| `code-review` (built-in CLI) | CLI internal | **KEEP** (no se toca, no es archivo) |
| `pr-review-toolkit:review-pr` | plugin | KEEP (subagent, no duplica) |
| `agent-skills:code-review-and-quality` | addy plugin | KEEP (focus distinto: enforcement de quality gates) |
| `feature-dev:feature-dev` | plugin | KEEP (orquestador feature, no review puro) |
| `ecc:code-review` | ECC | **DISABLE** (duplica funcion del user-level + built-in) |

**Razon:** built-in `/code-review` cubre el escenario "review del diff actual". user-level `code-reviewer` es el agente custom de USER. ECC code-review es el menos diferenciado.
**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\commands\code-review.md" -NewName "code-review.md.disabled"
```
**NOTA:** `ecc:code-review` es un command (`.md`), NO una skill (`SKILL.md`). Se desactiva como command. Las 232 skills ECC NO incluyen una `code-review` skill, asi que no hay nada que renombrar en `skills/`. **NEEDS-HUMAN** si se prefiere mantener el command ECC por integracion con `ecc-guide`.

---

### Grupo 4.2: `skill-creator`

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/skill-creator/SKILL.md` | user-level | **KEEP** |
| `plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator/SKILL.md` | cache plugin | NEEDS-HUMAN |
| `skill-creator:skill-creator` (system-reminder lo lista) | plugin marketplace | NEEDS-HUMAN |

**Razon:** user-level es canon de USER (custom). El cache es una version antigua "unknown". Antes de tocar, verificar de donde se sirve `skill-creator:skill-creator` en system-reminder — si es desde el cache, desactivar lo rompe.

---

### Grupos 4.3 - 4.9: worktree fantasma resuelto en Fase 0

`mcp-builder`, `webapp-testing`, `repo-evaluator`, `second-opinion`, `consolidate-memory`, **personas** (terry-davis, don-claudio, jordan-belfort, mike-tyson, pana, einstein, tolkien, novalbos, tio-gilito, warren, alfred, ultron), `ui-ux-pro-max`.

**Estado:** Todas las copias duplicadas vivian en `~/.claude/skills/.claude/worktrees/agent-ab8c425fe827d7b67/` que ya fue borrado en Fase 0. Quedan solo las user-level CORE. **NADA QUE HACER.**

---

### Grupo 4.10: `frontend-design` / `frontend-design-direction`

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/frontend-design/SKILL.md` | user-level | **KEEP** (canon USER, push beyond AI slop) |
| `~/.claude/skills/frontend-design-direction/SKILL.md` | user-level | **KEEP** (focus product-domain judgment) |
| `plugins/marketplaces/claude-code-plugins/plugins/frontend-design/skills/frontend-design/SKILL.md` | plugin | **DISABLE** (duplica user-level con menos contexto USER) |
| `plugins/marketplaces/ECC/skills/frontend-design-direction/SKILL.md` | ECC | **DISABLE** (duplica user-level frontend-design-direction) |

**Razon:** las dos user-level se complementan (estilo vs direccion). Las dos versiones plugin son redundantes y mas generalistas.
**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\claude-code-plugins\plugins\frontend-design" -NewName "frontend-design.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\frontend-design-direction" -NewName "frontend-design-direction.disabled"
```

---

### Grupo 4.11: C++ (`cpp-pro` / `cpp-testing` / `cpp-coding-standards`)

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/cpp-pro/SKILL.md` | user-level | **KEEP** (canon USER, UE5+proggrafica) |
| `~/.claude/skills/cpp-testing/SKILL.md` | user-level | **KEEP** (canon USER) |
| `~/.claude/skills/cpp-coding-standards/SKILL.md` | user-level | **KEEP** (canon USER) |
| `plugins/marketplaces/ECC/skills/cpp-testing/SKILL.md` | ECC | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/cpp-coding-standards/SKILL.md` | ECC | **DISABLE** (duplica user-level) |

**Razon:** user-level coexisten con ECC duplicates. Frontmatter ECC apunta a "C++ Core Guidelines" — mismo material que user-level. user-level gana por regla canon.
**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cpp-testing" -NewName "cpp-testing.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cpp-coding-standards" -NewName "cpp-coding-standards.disabled"
```

---

### Grupo 4.12: Python (`python-pro` / `python-patterns` / `python-testing`)

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/python-pro/SKILL.md` | user-level | **KEEP** |
| `~/.claude/skills/python-patterns/SKILL.md` | user-level | **KEEP** |
| `~/.claude/skills/python-testing/SKILL.md` | user-level | **KEEP** |
| `plugins/marketplaces/ECC/skills/python-patterns/SKILL.md` | ECC | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/python-testing/SKILL.md` | ECC | **DISABLE** (duplica user-level) |
| `superclaude/python-expert` | superclaude | N/A — no se encontro SKILL.md ni en system-reminder |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\python-patterns" -NewName "python-patterns.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\python-testing" -NewName "python-testing.disabled"
```

---

### Grupo 4.13: `typescript-pro`

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/typescript-pro/SKILL.md` | user-level | **KEEP** |

**Razon:** No hay duplicados en plugins activos. **NADA QUE HACER.**

---

### Grupo 4.14: `debugger` / `systematic-debugging`

| Path | Source | Decision |
|---|---|---|
| `superpowers:systematic-debugging` (`MUST USE`) | superpowers | **KEEP** (CORE workflow) |
| `~/.claude/skills/debugger/SKILL.md` | user-level | **KEEP** (custom USER) |
| `ecc:agent-introspection-debugging` | ECC | KEEP (focus distinto: introspecion DE agentes, no debug general) |

**Razon:** los tres tienen propositos distintos. NADA QUE HACER.

---

### Grupo 4.15: `tdd-workflow` / `test-driven-development`

| Path | Source | Decision |
|---|---|---|
| `superpowers:test-driven-development` (`MUST USE`) | superpowers | **KEEP** (CORE) |
| `agent-skills:test-driven-development` | addy | KEEP (descripcion: TDD focused, complementa) |
| `ecc:tdd-workflow` | ECC | **DISABLE** (duplica con menos enforcement) |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\tdd-workflow" -NewName "tdd-workflow.disabled"
```

---

### Grupo 4.16: `brainstorming` / `brainstorm`

Fase 1 ya cerro esto. `superpowers:brainstorming` activa, `brainstorm` deprecated ya en `.disabled`. **NADA QUE HACER.**

---

### Grupo 4.17: Planning (`write-plan` / `writing-plans` / `planning-and-task-breakdown` / `plan-orchestrate` / `make-plan`)

| Path | Source | Decision |
|---|---|---|
| `superpowers:writing-plans` (`MUST USE`) | superpowers | **KEEP** (CORE) |
| `agent-skills:planning-and-task-breakdown` | addy | **KEEP** (sub-task decomposition) |
| `~/.claude/skills/hiper-plans/SKILL.md` | user-level | KEEP (custom USER) |
| `superpowers:write-plan` (deprecated) | superpowers | NEEDS-HUMAN (no localizado SKILL.md propio) |
| `ecc:plan-orchestrate` | ECC | N/A (es command, no skill) |
| `thedotmack/openclaw/skills/make-plan` | thedotmack | DISABLE si plugin esta activo (NEEDS-HUMAN) |
| `thedotmack/plugin/skills/make-plan` | thedotmack | DISABLE si plugin esta activo (NEEDS-HUMAN) |

**Comandos (solo si thedotmack confirmado inactivo o se decide retirar):**
```powershell
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\thedotmack\openclaw" -NewName "openclaw.disabled"
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\thedotmack\plugin" -NewName "plugin.disabled"
```

---

### Grupo 4.18: Git (`git-workflow` / `git-workflow-manager` / `git-conflict-resolver` / `git-workflow-and-versioning`)

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/git-workflow/SKILL.md` | user-level | **KEEP** |
| `~/.claude/skills/git-workflow-manager/SKILL.md` | user-level | **KEEP** (custom USER) |
| `~/.claude/skills/git-conflict-resolver/SKILL.md` (en available-skills) | user-level | **KEEP** |
| `agent-skills:git-workflow-and-versioning` | addy | KEEP (focus versioning distinto) |
| `plugins/marketplaces/ECC/skills/git-workflow/SKILL.md` | ECC | **DISABLE** (duplica user-level — frontmatter ECC es generico) |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\git-workflow" -NewName "git-workflow.disabled"
```

---

### Grupo 4.19: Agent harness (5 skills muy similares)

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/agent-architecture-audit/SKILL.md` | user-level | **KEEP** (diagnostico 12-layer stack) |
| `plugins/marketplaces/ECC/skills/agent-architecture-audit/SKILL.md` | ECC (origin: oh-my-agent-check, mismo) | **DISABLE** |
| `~/.claude/skills/agent-harness-construction/SKILL.md` | user-level | **KEEP** (design action spaces) |
| `plugins/marketplaces/ECC/skills/agent-harness-construction/SKILL.md` | ECC | **DISABLE** |
| `~/.claude/skills/autonomous-agent-harness/SKILL.md` | user-level | NEEDS-HUMAN (no se puede leer; solapa con continuous-agent-loop) |
| `plugins/marketplaces/ECC/skills/autonomous-agent-harness/SKILL.md` | ECC | **DISABLE** |
| `~/.claude/skills/autonomous-loops/SKILL.md` | user-level | NEEDS-HUMAN (probablemente DEPRECATED segun frontmatter ECC) |
| `plugins/marketplaces/ECC/skills/autonomous-loops/SKILL.md` | ECC | **DISABLE** (su propio frontmatter: "v1.8.0 retained for one release. Canonical name is now continuous-agent-loop") |
| `~/.claude/skills/continuous-agent-loop/SKILL.md` | user-level | **KEEP** (canonica) |
| `plugins/marketplaces/ECC/skills/continuous-agent-loop/SKILL.md` | ECC | **DISABLE** |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agent-architecture-audit" -NewName "agent-architecture-audit.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agent-harness-construction" -NewName "agent-harness-construction.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\autonomous-agent-harness" -NewName "autonomous-agent-harness.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\autonomous-loops" -NewName "autonomous-loops.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\continuous-agent-loop" -NewName "continuous-agent-loop.disabled"
# NEEDS-HUMAN: leer ~/.claude/skills/autonomous-loops/SKILL.md. Si es copia ECC con misma deprecation, tambien desactivar:
# Rename-Item -LiteralPath "C:\Users\USER\.claude\skills\autonomous-loops" -NewName "autonomous-loops.disabled"
```

---

### Grupo 4.20: `continuous-learning` / `continuous-learning-v2`

| Path | Source | Decision |
|---|---|---|
| `~/.claude/skills/continuous-learning-v2/SKILL.md` | user-level | **KEEP** (v2.1) |
| `plugins/marketplaces/ECC/skills/continuous-learning-v2/SKILL.md` | ECC | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/continuous-learning.disabled/` | ECC | **YA DESACTIVADO** |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\continuous-learning-v2" -NewName "continuous-learning-v2.disabled"
```

---

## 3. Tabla de decisiones — Seccion 5 (15 items REVISAR)

### 5.1: `senior-engineer` vs `terry-davis`
**Decision:** **KEEP ambos.** Terry es persona canon. senior-engineer puede ser fallback generico. NEEDS-HUMAN si USER quiere consolidar.

### 5.2: `agentic-engineering` vs `agentic-os` vs `agent-architecture-audit`
| Skill | Decision |
|---|---|
| `~/.claude/skills/agentic-engineering/SKILL.md` | **KEEP** (workflow: eval+decomp+routing) |
| `~/.claude/skills/agentic-os/SKILL.md` | **KEEP** (arquitectura: persistent multi-agent OS) |
| `~/.claude/skills/agent-architecture-audit/SKILL.md` | **KEEP** (diagnostico) |
| `plugins/marketplaces/ECC/skills/agentic-engineering/SKILL.md` | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/agentic-os/SKILL.md` | **DISABLE** (duplica user-level) |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agentic-engineering" -NewName "agentic-engineering.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agentic-os" -NewName "agentic-os.disabled"
```

### 5.3: `hiper-plans` vs `writing-plans`
**Decision:** **KEEP ambos.** Distinta proposicion. NEEDS-HUMAN solo si USER decide consolidar.

### 5.4: `loki-mode`
**Decision:** **KEEP** + NEEDS-HUMAN review. Sin descripcion clara, no tocar.

### 5.5: Seguridad (`gateguard` / `safety-guard` / `security-scan` / `security-review` / `security-bounty-hunter`)
| Skill | Decision |
|---|---|
| `~/.claude/skills/gateguard/SKILL.md` | **KEEP** (CORE) |
| `~/.claude/skills/safety-guard/SKILL.md` | **KEEP** |
| `~/.claude/skills/security-scan/SKILL.md` | **KEEP** |
| `~/.claude/skills/security-bounty-hunter/SKILL.md` | **KEEP** |
| `plugins/marketplaces/ECC/skills/gateguard/SKILL.md` | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/safety-guard/SKILL.md` | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/security-scan/SKILL.md` | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/security-bounty-hunter/SKILL.md` | **DISABLE** (duplica user-level) |
| `plugins/marketplaces/ECC/skills/security-review/SKILL.md` | NEEDS-HUMAN (no hay user-level equivalente) |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\gateguard" -NewName "gateguard.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\safety-guard" -NewName "safety-guard.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\security-scan" -NewName "security-scan.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\security-bounty-hunter" -NewName "security-bounty-hunter.disabled"
```

### 5.6: Coste (`cost-tracking` / `cost-aware-llm-pipeline` / `ecc-tools-cost-audit`)
| Skill | Decision |
|---|---|
| `~/.claude/skills/token-budget-advisor/SKILL.md` | **KEEP** (token planning) |
| `~/.claude/skills/context-budget/SKILL.md` | **KEEP** (context window mgmt) |
| `plugins/marketplaces/ECC/skills/cost-tracking/SKILL.md` | **DISABLE** (USER Claude Max — no aplica billing real) |
| `plugins/marketplaces/ECC/skills/cost-aware-llm-pipeline/SKILL.md` | **DISABLE** (API cost routing, no aplica con Max) |
| `plugins/marketplaces/ECC/skills/ecc-tools-cost-audit/SKILL.md` | **DISABLE** (auditoria ECC Tools GitHub App — USER no opera esa infra) |

**Razon:** memoria card `cost-hook-informational-only`.
**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cost-tracking" -NewName "cost-tracking.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cost-aware-llm-pipeline" -NewName "cost-aware-llm-pipeline.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\ecc-tools-cost-audit" -NewName "ecc-tools-cost-audit.disabled"
```

### 5.7: `prompt-optimizer`
| Skill | Decision |
|---|---|
| `~/.claude/skills/prompt-optimizer/SKILL.md` | **KEEP** |
| `plugins/marketplaces/ECC/skills/prompt-optimizer/SKILL.md` | **DISABLE** (duplica) |

**Comandos:**
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\prompt-optimizer" -NewName "prompt-optimizer.disabled"
```

### 5.8: `team-builder`
**Decision:** **KEEP** — agent picker, valor en sprints batch.

### 5.9: `dashboard-builder`
**Decision:** **DISABLE** — Grafana/SigNoz no en stack USER.
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\dashboard-builder" -NewName "dashboard-builder.disabled"
```

### 5.10: `learning-guide` / `socratic-mentor` vs `novalbos`
**Decision:** **KEEP novalbos.** superclaude learning skills no aparecen activas en system-reminder — nada que desactivar.

### 5.11: `connections-optimizer`
**Decision:** **DISABLE** — X/LinkedIn growth no es flujo activo en memoria de USER.
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\connections-optimizer" -NewName "connections-optimizer.disabled"
```

### 5.12: `iterative-retrieval` / `regex-vs-llm-structured-text`
**Decision:** **KEEP ambos** — patrones reutilizables relevantes a ULTRON multi-agent.

### 5.13: `claude-devfleet`
**Decision:** **DISABLE** — DevFleet no mencionado en memoria/projects.
```powershell
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\claude-devfleet" -NewName "claude-devfleet.disabled"
```

### 5.14: `evolve` y 5.15: `instinct-export/import/status`
**Decision:** N/A — son **commands** (`commands/*.md`), NO skills. Fuera del scope.

---

## 4. Hallazgos adicionales

### 4.1 ECC duplica TODO su contenido en cache
`plugins/cache/ecc/ecc/2.0.0-rc.1/` contiene copia exacta de `plugins/marketplaces/ECC/`. Cache parece inerte (no se cargan SKILL.md desde alli), pero ocupa MB y contamina Glob.
**Accion (post-confirmacion):** `Remove-Item -Recurse -Force "C:\Users\USER\.claude\plugins\cache\ecc"`

### 4.2 ECC tiene "skills" en .agents/, .cursor/, .kiro/ y docs/ja-JP/
Solo `plugins/marketplaces/ECC/skills/` se carga (confirmado en `plugin.json`: `"skills": ["./skills/"]`).
- `.agents/skills/` (~33): templates para otros harnesses
- `.cursor/skills/` (~10): version Cursor
- `.kiro/skills/` (~18): version Kiro
- `docs/ja-JP/skills/` (~100+): docs traducidas japones
**Ninguna se carga, no consume tokens.** Confunde Glob/Grep. No prioritario.

### 4.3 thedotmack + pensyve probablemente NO activos
Los plugins `thedotmack/openclaw`, `thedotmack/plugin`, `pensyve/integrations/{claude-code,codex-plugin,gemini-extension}` aparecen en `marketplaces/` pero NINGUNA de sus skills aparece en system-reminder `available skills`.
**Conclusion:** estan presentes en marketplace pero NO instalados via `/plugin install`. NO consumen tokens. Borrar las carpetas marketplace seria limpieza cosmetica.

### 4.4 superpowers cache antiguo (5.0.7)
`plugins/cache/superpowers-marketplace/superpowers/5.0.7/skills/` contiene version 5.0.7. El system-reminder muestra skills `superpowers:*` activas — hay version "viva" en otra ruta. Verificar.

### 4.5 Worktrees fantasma adicionales
NO se encontraron worktrees `.claude/worktrees/` adicionales al ya borrado (`agent-ab8c425fe827d7b67`).

### 4.6 Cache `addy-agent-skills.disabled`
Ya esta correctamente `.disabled`. No tocar.

### 4.7 `evolve`, `instinct-*` son commands no skills
Salieron del scope de fusion de skills. Su gestion va por `commands/`.

### 4.8 Sandbox bloqueo investigacion completa user-level
**Limitacion importante:** Read/Grep estan DENEGADOS para `~/.claude/skills/`. Las decisiones sobre fusion entre dos versiones user-level (caso poco frecuente) requieren revision humana.

---

## 5. Script consolidado (todos los Rename-Item juntos)

```powershell
# ============================================
# Skills Consolidation — 2026-05-24
# REVISAR ANTES DE EJECUTAR
# Total: 26 renames (todos en plugins, ninguno toca user-level)
# Tokens estimados ahorrados: ~2.7-3.6k
# ============================================

# --- Grupo 4.10: frontend-design / frontend-design-direction ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\claude-code-plugins\plugins\frontend-design" -NewName "frontend-design.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\frontend-design-direction" -NewName "frontend-design-direction.disabled"

# --- Grupo 4.11: cpp duplicates ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cpp-testing" -NewName "cpp-testing.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cpp-coding-standards" -NewName "cpp-coding-standards.disabled"

# --- Grupo 4.12: python duplicates ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\python-patterns" -NewName "python-patterns.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\python-testing" -NewName "python-testing.disabled"

# --- Grupo 4.15: tdd-workflow ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\tdd-workflow" -NewName "tdd-workflow.disabled"

# --- Grupo 4.18: git-workflow ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\git-workflow" -NewName "git-workflow.disabled"

# --- Grupo 4.19: agent harness duplicates ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agent-architecture-audit" -NewName "agent-architecture-audit.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agent-harness-construction" -NewName "agent-harness-construction.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\autonomous-agent-harness" -NewName "autonomous-agent-harness.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\autonomous-loops" -NewName "autonomous-loops.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\continuous-agent-loop" -NewName "continuous-agent-loop.disabled"

# --- Grupo 4.20: continuous-learning-v2 ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\continuous-learning-v2" -NewName "continuous-learning-v2.disabled"

# --- 5.2: agentic-engineering / agentic-os ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agentic-engineering" -NewName "agentic-engineering.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\agentic-os" -NewName "agentic-os.disabled"

# --- 5.5: seguridad duplicates ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\gateguard" -NewName "gateguard.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\safety-guard" -NewName "safety-guard.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\security-scan" -NewName "security-scan.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\security-bounty-hunter" -NewName "security-bounty-hunter.disabled"

# --- 5.6: coste (no aplica con Claude Max) ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cost-tracking" -NewName "cost-tracking.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\cost-aware-llm-pipeline" -NewName "cost-aware-llm-pipeline.disabled"
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\ecc-tools-cost-audit" -NewName "ecc-tools-cost-audit.disabled"

# --- 5.7: prompt-optimizer duplicate ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\prompt-optimizer" -NewName "prompt-optimizer.disabled"

# --- 5.9: dashboard-builder (Grafana/SigNoz no aplica) ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\dashboard-builder" -NewName "dashboard-builder.disabled"

# --- 5.11: connections-optimizer (X/LinkedIn growth no activo) ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\connections-optimizer" -NewName "connections-optimizer.disabled"

# --- 5.13: claude-devfleet (no en uso) ---
Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\claude-devfleet" -NewName "claude-devfleet.disabled"

# ============================================
# Total: 26 carpetas renombradas
# ============================================
# Verificar despues:
# Get-ChildItem "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills" -Directory | Where-Object { $_.Name -notlike "*.disabled" } | Measure-Object
```

### Bloque NEEDS-HUMAN (revisar manualmente antes)

```powershell
# --- skill-creator cache (verificar de donde se sirve /skill-creator) ---
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\cache\claude-plugins-official\skill-creator\unknown\skills\skill-creator" -NewName "skill-creator.disabled"

# --- thedotmack (verificar settings.json plugins enabled) ---
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\thedotmack\openclaw" -NewName "openclaw.disabled"
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\thedotmack\plugin" -NewName "plugin.disabled"

# --- ecc:code-review command (no skill) ---
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\commands\code-review.md" -NewName "code-review.md.disabled"

# --- ecc:security-review (mantener si USER invoca security work) ---
# Rename-Item -LiteralPath "C:\Users\USER\.claude\plugins\marketplaces\ECC\skills\security-review" -NewName "security-review.disabled"

# --- ~/.claude/skills/autonomous-loops (sandbox bloqueo Read; si es deprecated igual que ECC, desactivar) ---
# Rename-Item -LiteralPath "C:\Users\USER\.claude\skills\autonomous-loops" -NewName "autonomous-loops.disabled"

# --- senior-engineer (KEEP por defecto; revisar contenido) ---
# --- loki-mode (NUNCA tocar sin saber que hace) ---
# --- pensyve/integrations/* (si NO instalados, borrar marketplaces es cosmetico) ---
```

---

## 6. Conteo final

**Skills proposed DISABLE (script principal):** 26 renames, todos en plugins (24 en ECC, 1 en claude-code-plugins, 0 en user-level).
**Skills NEEDS-HUMAN:** 8 decisiones a revisar antes de tocar.
**Tokens estimados ahorrados:** ~2.7-3.6k (a ~150 tokens por skill description + frontmatter).

**Sanity check:** todas las skills marcadas DISABLE son duplicados de versiones user-level que YA estan listadas en el system-reminder `available skills`, o skills sin uso confirmado (cost-*, dashboard-builder, connections-optimizer, claude-devfleet). NINGUNA desactiva una skill unica que no este cubierta por user-level o built-in.

---

**Fin del informe.**
**Generado:** 2026-05-24
**Sandbox notes:** No se pudo leer contenido de skills user-level. Decisiones se basan en system-reminder `available skills` + regla canon USER (user-level gana para personas) + lectura directa de versiones plugin.
