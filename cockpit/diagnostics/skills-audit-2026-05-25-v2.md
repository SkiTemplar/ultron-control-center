# Skills Audit v2 — 2026-05-25 (Segunda ronda agresiva)

> Auditoría reactiva al instructivo verbatim de USER:
> "audit en un subagente que leyese cada una de las sub skills y literalmente eliminase todas las que fuesen redundantes y de peor nivel que las otras, y que desactivase todas las que estaba casi cien por cien seguro que no iba a llegar a usar".

## Resumen ejecutivo

| Ubicación | Antes | Después | Desactivadas | % reducción |
|-----------|-------|---------|--------------|-------------|
| `~/.claude/skills/` (user-level) | 91 | **74** | 17 | 18.7% |
| `~/.claude/plugins/cache/ecc/ecc/2.0.0-rc.1/skills/` | 111 | **1** | **231** (incluye las ya disabled previas) | 99.1% |
| `~/.claude/plugins/cache/addy-agent-skills/...` | 23 | **3** | 20 | 87% |
| `~/.claude/plugins/cache/superpowers-marketplace/...` | 14 | 14 | 0 | 0% (intocable, base de workflow) |
| `~/.claude/plugins/cache/openai-codex/...` | 3 | 3 | 0 | 0% (todas necesarias para `/codex`) |
| **TOTAL skills activas** | **242** | **95** | **147 esta ronda** | **60.7%** |

### Ahorro estimado de tokens

- 147 skills desactivadas × ~80 tokens promedio por entry en system-reminder (name + description) = **~11,760 tokens/turn ahorrados**.
- Antes de esta ronda: ~242 skills × 80 = ~19,360 tokens
- Después: ~95 skills × 80 = ~7,600 tokens
- **Ahorro neto: ~11,700 tokens por turno** (~60% del presupuesto del bloque skills).

> Nota: El catálogo de comandos `ecc:*` y `superpowers:*` que aparece en system-reminder son slash-commands, no skills. No están auditados aquí (no se tocan).

---

## Desactivadas — ROUND A · ECC plugin REDUNDANTES (duplican user-level o superpowers)

Path: `~/.claude/plugins/cache/ecc/ecc/2.0.0-rc.1/skills/`

| Skill | Razón |
|-------|-------|
| architecture-decision-records | Duplicado de `~/.claude/skills/architecture-decision-records/` |
| context-budget | Duplicado de user-level |
| council | Duplicado de user-level |
| deep-research | Cubierto por `einstein` + `academic-deep-research` (este último también disabled, mejor usar `einstein`) |
| docker-patterns | Duplicado de user-level |
| documentation-lookup | Cubierto por context7 MCP |
| error-handling | Duplicado de user-level |
| exa-search | Cubierto por MCP `mcp__plugin_ecc_exa__web_search_exa` |
| hexagonal-architecture | Duplicado de user-level |
| mcp-server-patterns | Cubierto por `mcp-builder` user-level |
| nextjs-turbopack | Duplicado de user-level |
| postgres-patterns | Duplicado de user-level |
| redis-patterns | Duplicado de user-level |
| rust-patterns | Duplicado de user-level |
| rust-testing | Duplicado de user-level |
| search-first | Duplicado de user-level |
| security-review | Cubierto por `code-reviewer` + `security-scan` user-level |
| token-budget-advisor | Duplicado de user-level |
| vite-patterns | Duplicado de user-level |
| nanoclaw-repl | Duplicado de user-level (que a su vez ha sido disabled, ver round C) |
| frontend-slides | Out-of-scope (no hace presentaciones) |
| motion-advanced, motion-foundations, motion-patterns, motion-ui | Cubierto por `frontend-design` + `mike-tyson` + `ui-ux-pro-max` |
| prisma-patterns, mysql-patterns | Stack actual usa Postgres/SQLite, no Prisma ni MySQL |
| plan-orchestrate | Cubierto por `superpowers:writing-plans` + `hiper-plans` |
| code-tour, codebase-onboarding | Cubierto por `terry-davis` y workflow normal |
| ecc-guide | Duplicado de user-level |
| hookify-rules, iterative-retrieval, rules-distill | Internas de ECC, mejor llamar `/ecc:hookify` directo |
| accessibility | Cubierto por `mike-tyson` |
| benchmark | YAGNI |
| agent-eval | Cubierto por `agent-architecture-audit` (user-level, mantenida) |
| ai-first-engineering, ai-regression-testing | Genéricas, no aportan vs agentic stack actual |
| api-design, api-connector-builder | Genéricas, cubiertas por `typescript-pro` |
| browser-qa | Cubierto por `webapp-testing` + Playwright MCP |
| bun-runtime | Stack usa Node, no Bun |
| configure-ecc | Una sola vez, ya está configurado |
| content-engine, content-hash-cache-pattern | Out-of-scope |
| coding-standards, backend-patterns, blueprint | Genéricas, cubiertas por `terry-davis` + `code-reviewer` |
| frontend-patterns | Cubierto por `frontend-design` |
| regex-vs-llm-structured-text | Decision rule, no skill operativa |
| strategic-compact | Cubierto por `consolidate-memory` |
| tdd-workflow (ya estaba .disabled) | Cubierto por `superpowers:test-driven-development` |
| verification-loop | Cubierto por `superpowers:verification-before-completion` |
| e2e-testing, windows-desktop-e2e, workspace-surface-audit | Cubiertos por `webapp-testing` + Playwright |
| fastapi-patterns | Cubierto por `python-patterns` + `python-testing` |
| ck | ECC-specific check tool, mejor llamar `/ecc:*` directo |
| design-system | Cubierto por `ui-ux-pro-max` (67 estilos, 161 paletas) |
| database-migrations | Duplicado de user-level |
| deployment-patterns | Duplicado de user-level |
| gan-style-harness | Experimental, NEEDS-HUMAN en user-level está intocado |
| skill-comply, skill-scout, skill-stocktake | Internas de ECC, redundantes con esta auditoría |

**Total ROUND A: 65 skills**

---

## Desactivadas — ROUND B · ECC plugin OUT-OF-SCOPE (negocio/ops irrelevantes)

| Skill | Razón |
|-------|-------|
| article-writing, brand-voice, crosspost, news-publisher | Cubierto por `tolkien` (escritura) o ya no relevantes |
| automation-audit-ops, canary-watch, click-path-audit | Enterprise ops, no USER |
| data-scraper-agent, email-ops, messages-ops, unified-notifications-ops | Cubierto por MCPs específicos (Gmail, Spotify, etc.) |
| enterprise-agent-ops, investor-materials, investor-outreach | Cubierto por `jordan-belfort` |
| jira-integration | USER no usa Jira |
| knowledge-ops, market-research, lead-intelligence | Cubierto por `jordan-belfort` + `einstein` |
| mle-workflow, pytorch-patterns, recsys-pipeline-architect, social-graph-ranker | ML pipeline ops, out-of-scope (Novalbos enseña conceptos) |
| make-interfaces-feel-better | Cubierto por `mike-tyson` |
| opensource-pipeline, production-audit, project-flow-ops | Enterprise ops |
| product-capability, product-lens, team-builder | Cubierto por `jordan-belfort` |
| repo-scan, research-ops, santa-method | Cubierto por workflow normal + `senior-engineer` |
| scientific-thinking-literature-review, scientific-thinking-scholar-evaluation | Cubierto por `einstein` |
| seo | Out-of-scope |
| terminal-ops | Cubierto por `windows-admin` + `alfred` |
| ui-demo, ui-to-vue | Cubierto por `ui-ux-pro-max` |
| uncloud | Out-of-scope (no usa el producto) |
| video-editing | Out-of-scope |
| x-api | Cubierto por MCPs sociales si surge |
| google-workspace-ops | Cubierto por MCPs Google directos |
| github-ops | Cubierto por MCP `mcp__github-pat__*` |
| liquid-glass-design | Cubierto por `frontend-design` + `mike-tyson` |
| agent-introspection-debugging, agent-sort | Internas de ECC |

**Total ROUND B: 45 skills**

---

## Desactivadas — ROUND C · USER-LEVEL out-of-scope o redundantes

Path: `~/.claude/skills/`

| Skill | Razón |
|-------|-------|
| golang-patterns | USER NO escribe Go en stack actual |
| golang-testing | Idem |
| gateguard | Solapa con `safety-guard` (más genérico y mantenido). Mantengo safety-guard. |
| security-bounty-hunter | Out-of-scope (no hace bug bounty) |
| news-publisher | ULTRON-specific; Tolkien ahora cubre publicación |
| humanizer | YAGNI (USER no necesita "humanizar" outputs) |
| research-explainer | Solapa con `einstein` + `novalbos` |
| scientific-writing | Solapa con `einstein` |
| citation-management | Solapa con `einstein` |
| literature-review | Solapa con `einstein` |
| academic-deep-research | Solapa con `einstein` (13 sub-agentes son overkill) |
| nanoclaw-repl | NanoClaw v2 es ECC-specific REPL, USER usa terminal nativa |
| powershell-7-expert | Out-of-scope (Windows 11 nativo viene con 5.1; cross-platform no aplica) |
| prompt-optimizer | USER no optimiza prompts, los escribe directo |
| cpp-pro | Solapa con `cpp-coding-standards` + `cpp-testing` + `don-claudio` + `novalbos` + `ue5-dev` (5 skills C++ es absurdo) |
| python-pro | Solapa con `python-patterns` + `python-testing` |
| ui-designer | Solapa con `ui-ux-pro-max` (más completa, mantengo esa) y `mike-tyson` |

**Total ROUND C: 17 skills**

---

## Desactivadas — ROUND D · addy-agent-skills DUPLICADOS

Path: `~/.claude/plugins/cache/addy-agent-skills/agent-skills/1.0.0/skills/`

Mantenidas activas (3):
- `interview-me` — útil para que Claude te entreviste antes de escribir
- `idea-refine` — útil en brainstorming
- `doubt-driven-development` — útil con frontend complejo

Desactivadas (20): `api-and-interface-design`, `browser-testing-with-devtools`, `ci-cd-and-automation`, `code-review-and-quality`, `code-simplification`, `context-engineering`, `debugging-and-error-recovery`, `deprecation-and-migration`, `documentation-and-adrs`, `frontend-ui-engineering`, `git-workflow-and-versioning`, `incremental-implementation`, `performance-optimization`, `planning-and-task-breakdown`, `security-and-hardening`, `shipping-and-launch`, `source-driven-development`, `spec-driven-development`, `test-driven-development`, `using-agent-skills`.

Razón: TODAS están cubiertas por `superpowers:*` (que son la base instalada y referenciada en CLAUDE.md), por skills user-level, o por workflows del plugin ECC. El plugin addy duplica versiones más cortas y menos integradas.

**Total ROUND D: 20 skills**

---

## NEEDS-HUMAN — USER decide (NO tocadas)

Estas quedan **activas** porque no estaba 100% claro si las quieres o no. Revísalas y dime cuáles quitar:

### Top 5 candidatas a desactivar (probables candidatas según uso)

1. **`agentic-os`** — "Build persistent multi-agent operating systems". ULTRON Control Center ya es tu OS agéntico. ¿Usas el skill?
2. **`autonomous-agent-harness`** — "Transform Claude Code into fully autonomous agent". Solapa con `loki-mode`, `autonomous-loops`, `continuous-agent-loop`. **3 skills cubren lo mismo.** Decide cuál te quedas.
3. **`continuous-learning-v2`** — Hook-based instinct learning. Funcional pero ¿lo invocas alguna vez explícitamente? Si está hookeado, el skill no se necesita.
4. **`loki-mode`** — Multi-agent autonomous startup. Spec → product. Overlap fuerte con `autonomous-agent-harness` y `superpowers:executing-plans` + `superpowers:dispatching-parallel-agents`.
5. **`hexagonal-architecture`** — Ports & Adapters. ¿Realmente diseñas en hexagonal? Si no, fuera.

### Otras dubiosas (decide tú)

- `agent-architecture-audit` — útil si auditas agentes (estás en ello AHORA), mantener.
- `agent-harness-construction` — útil si construyes wrappers SDK; eres usuario, no constructor.
- `agentic-engineering` — abstracta. ¿Le sacas valor?
- `autonomous-loops` — patrones de loops. Si ya entendiste los patrones, archívalo.
- `continuous-agent-loop` — overlapping con anterior.
- `senior-engineer` — meta-skill. ¿Lo invocas o terry-davis ya lo cubre?
- `gamedev-engineer` — solapa con `don-claudio` (más específico).
- `business-strategist` — solapa con `jordan-belfort`.
- `repo-evaluator` (Kirkardo) — solapa con `code-reviewer` para evaluación académica. Si sigues haciendo el T9 mantén.

---

## NO TOCADAS (intactas por seguridad)

- **Personas ULTRON**: terry-davis, don-claudio, mike-tyson, jordan-belfort, warren, tio-gilito, pana, alfred, novalbos, einstein, tolkien, ultron, repo-evaluator
- **Infra ECC**: `~/.claude/plugins/cache/ecc/ecc/2.0.0-rc.1/hooks/` ✅, `scripts/` ✅, `commands/` ✅, `agents/` ✅, `rules/` ✅, `marketplaces/` ✅
- **Plugin superpowers**: 14/14 skills intactas
- **Plugin codex**: 3/3 skills intactas
- **`learned/`** (instinct DB) intacta
- **Stack-aligned**: typescript-pro, cpp-coding-standards, cpp-testing, rust-patterns, rust-testing, python-patterns, python-testing, postgres-patterns, redis-patterns, docker-patterns, vite-patterns, nextjs-turbopack, ue5-dev, shader-fundamentals, webapp-testing, powershell-5.1-expert, windows-admin
- **Core workflow**: code-reviewer, debugger, refactoring-specialist, focused-fix, hiper-plans, search-first, consolidate-memory, mcp-builder, skill-creator, error-handling, hexagonal-architecture, architecture-decision-records, deployment-patterns, database-migrations, ecc-guide, council, context-budget, token-budget-advisor, safety-guard, second-opinion, frontend-design, frontend-design-direction, ui-ux-pro-max, markdown-mermaid-writing, generate-image, docx, pdf, powershell-5.1-expert

---

## Cómo revertir (rollback)

Si algo se rompe o quieres restaurar TODO de golpe:

```bash
# Revertir TODAS las desactivaciones de esta ronda:
find ~/.claude/skills ~/.claude/plugins/cache/ecc/ecc/2.0.0-rc.1/skills ~/.claude/plugins/cache/addy-agent-skills -maxdepth 6 -type d -name "*.disabled" | while read d; do
  mv "$d" "${d%.disabled}"
done
```

Revertir solo una:
```bash
mv ~/.claude/skills/golang-patterns.disabled ~/.claude/skills/golang-patterns
```

Listar todo lo desactivado en esta ronda:
```bash
find ~/.claude/skills ~/.claude/plugins/cache/ecc/ecc/2.0.0-rc.1/skills ~/.claude/plugins/cache/addy-agent-skills -maxdepth 6 -type d -name "*.disabled" | sort
```

---

## Notas de operación

- **Hooks ECC intactos**: no se ha tocado `~/.claude/plugins/cache/ecc/ecc/2.0.0-rc.1/hooks/`, `scripts/`, ni manifests (`plugin.json`, `marketplace.json`). El incidente del 24-may (borrar cache → romper hooks) NO se repite.
- **El catálogo `ecc:*` y `superpowers:*` en system-reminder son slash-commands**, no skills — siguen ahí porque están definidos en `commands/`, que no se ha tocado. Si quieres limpiar comandos también, pídelo en otra ronda.
- **Las "skills" `update-config`, `keybindings-help`, `verify`, `code-review`, `fewer-permission-prompts`, `loop`, `schedule`, `claude-api`, `run`, `init`, `review`, `security-review`** son skills built-in del CLI Claude Code (no en filesystem), no auditables.
