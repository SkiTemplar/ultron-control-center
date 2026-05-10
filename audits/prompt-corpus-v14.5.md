# Prompt corpus inventory — v14.5 META-PROMPTER (2026-05-08)

> Phase 0: inventario y clasificación de los prompts ULTRON candidatos para
> auto-mejora. Traffic classification basado en routing.jsonl (~17k turns/14d
> agregados desde sessions/).

## Inventario

### Kirkardo audits (9 prompts) · TUI views

| File | Propósito | Traffic |
|---|---|---|
| `tui/prompts/01-memoria.md` | Audit memoria (MEMORY.md, context.md, vault) | medium |
| `tui/prompts/02-skill-network.md` | Audit skill graph + persona conexiones | low |
| `tui/prompts/03-vault.md` | Audit vault L2 (~/.ultron-vault/) | low |
| `tui/prompts/04-hooks.md` | Audit hooks (12 + their stdout) | medium |
| `tui/prompts/05-cockpit.md` | Audit cockpit scripts | medium |
| `tui/prompts/06-self-improve.md` | Audit auto-mejora trail | low |
| `tui/prompts/07-skills.md` | Audit skill manifest + drift | medium |
| `tui/prompts/08-todo-sistema.md` | Audit holístico end-to-end | high (frequent re-run) |
| `tui/prompts/09-prompt-clipboard.md` | Generic prompt clipboard | low |

### Skills management prompts (6) · TUI skills view

| File | Propósito | Traffic |
|---|---|---|
| `tui/prompts/skills-create.md` | Crear nueva skill | low |
| `tui/prompts/skills-update-all.md` | Refresh batch | low |
| `tui/prompts/skills-registry-sync.md` | Manifest sync | low |
| `tui/prompts/skills-search-github.md` | Buscar skill GitHub | medium |
| `tui/prompts/skills-search-codex.md` | Buscar skill via Codex | low |
| `tui/prompts/skills-search-gemini.md` | Buscar skill via Gemini | low |

### Templates / scripts (1)

| File | Propósito | Traffic |
|---|---|---|
| `scripts/cockpit/templates/newsletter.md.tmpl` | News bundle prompt | medium (daily) |

## Traffic classification — base routing.jsonl

| Tier | Volumen 14d | Prompts pertenecientes |
|---|---:|---|
| **HIGH** | >20 invocations | `ultron` SKILL.md (44), `repo-evaluator` (27) — Kirkardo `08-todo-sistema.md` re-run frecuente |
| **MEDIUM** | 5-20 | `feature-dev:code-reviewer` (8), `ultron-{security,arch,perf,metadata,context}` (4-5 c/u), `alfred` (4), `tio-gilito` (3), `terry-davis` / `novalbos` (2 c/u), audits `01-memoria`, `04-hooks`, `05-cockpit`, `07-skills` |
| **LOW** | <5 | personas raras (mike-tyson, focused-fix, warren — 1 c/u), audits `02-skill-network`, `03-vault`, `06-self-improve`, `09-prompt-clipboard`, todos los skills-* search/create/update |

## Targets de mejora (priorizados)

Prompts a mejorar primero (HIGH/MEDIUM por traffic + indicio de drift):

1. **SKILL.md de personas top-3** — ultron / repo-evaluator / alfred (ya trimmed en v14.4 P4 pero descripciones de personas pueden revisarse)
2. **Audit `08-todo-sistema.md`** — re-run frecuente sugiere prompt está sobre-pidiendo o devolviendo demasiado
3. **`feature-dev:code-reviewer`** — uso recurrente, oportunidad de optimizar
4. **`alfred` SKILL.md** — domain de Windows admin, potencial drift
5. **Newsletters (`newsletter.md.tmpl`)** — usado diario, alto leverage
6. **`tio-gilito` SKILL.md** — domain finanzas, alto valor por sesión

## Métricas baseline (pre-improvement)

Cada prompt seleccionado tendrá:
- `iteration: 1` en frontmatter (después del Phase 3)
- Snapshot de tokens current
- Tres `sample_outputs` capturados (Phase 2 hook)
- Si USER edita el output → `user_edit` capturado

## Corpus excluido

- Prompts inline en `tui.py` Python source (riesgo alto de regresión, baja recompensa)
- Prompts inline en `auto_updater.py` (gen automatizada, no candidato a improve)
- Prompts del macro plan (`MACRO-execution-prompts.md`) — son one-shot, no recurrentes

## Total: 16 prompts indexables · 6 candidatos prioritarios para Phase 1+
