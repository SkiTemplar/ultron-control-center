# Plugin Audit — v14.4 P1 lazy loader prep (2026-05-08)

> Cross-reference de installed_plugins.json × routing.jsonl 14d para identificar
> plugins sin uso reciente y proponer uninstall antes de aplicar skillOverrides.

## Telemetría base

- 12 routing.jsonl files (2026-04-27 → 2026-05-08)
- 267 eventos en ventana 14d (97 Skill + 170 Agent)
- 28 targets únicos invocados

## Plugins instalados — 16 total

| Plugin | Skills | Invoc 14d | Status |
|---|---:|---:|---|
| **agent-skills@addy-agent-skills** | 21 | 10 | KEEP |
| **superpowers@superpowers-marketplace** | 14 | 8 | KEEP |
| **feature-dev@claude-plugins-official** | 0 | 8 (subagents) | KEEP |
| claude-mem@thedotmack | 8 | 0 | **UNINSTALL** |
| skill-creator@claude-plugins-official | 1 | 0 | **UNINSTALL** |
| hookify@claude-plugins-official | 1 | 0 | **UNINSTALL** |
| claude-code-setup@claude-plugins-official | 1 | 0 | **UNINSTALL** |
| frontend-design@claude-plugins-official | 1 | 0 | **UNINSTALL** |
| code-review@claude-plugins-official | 0 | — | KEEP (empty, slash-only) |
| code-simplifier@claude-plugins-official | 0 | — | KEEP (empty) |
| commit-commands@claude-plugins-official | 0 | — | KEEP (empty) |
| context7@claude-plugins-official | 0 | — | KEEP (empty) |
| github@claude-plugins-official | 0 | — | KEEP (empty) |
| playwright@claude-plugins-official | 0 | — | KEEP (empty) |
| pr-review-toolkit@claude-plugins-official | 0 | — | KEEP (empty) |
| security-guidance@claude-plugins-official | 0 | — | KEEP (empty) |

## Acción propuesta

```powershell
claude plugins remove claude-mem@thedotmack
claude plugins remove skill-creator@claude-plugins-official
claude plugins remove hookify@claude-plugins-official
claude plugins remove claude-code-setup@claude-plugins-official
claude plugins remove frontend-design@claude-plugins-official
```

**Skills a remover:** 12 plugin skills (no afectan a `skillOverrides` lazy loader pero sí reducen inventario).

**Estimación de ahorro:** ~12 skills × ~50 tok/desc avg ≈ ~600 tok directo + reducción de noise en dispatcher.

## Riesgos

- `skill-creator` y `claude-code-setup` están instalados aunque no usados — USER puede querer mantener `skill-creator` para futuros workflows de creación de skills (alternativa: la skill personal `skill-creator` en ~/.claude/skills/ ya existe y es preferida).
- `claude-mem` (8 skills) — plugin de memoria; USER tiene su propio sistema (brain_index, ULTRON memory). No usado en 14d → uninstall safe.
- `frontend-design` y `hookify` y `claude-code-setup` — 1 skill cada uno, 0 uso, uninstall low-risk.

## Resultado (ejecutado 2026-05-08)

`skill-creator@claude-plugins-official` **KEPT** — contiene 8 scripts + 3 agents + eval-viewer (analyzer.md, comparator.md, grader.md, aggregate_benchmark.py, generate_report.py, improve_description.py, package_skill.py, quick_validate.py, run_eval.py, run_loop.py, utils.py). Skill personal `~/.claude/skills/skill-creator/` es sync-only y no replica este toolset.

**Uninstalled (4 plugins, 11 skills):**

```
✔ claude-mem@thedotmack             (8 skills)
✔ hookify@claude-plugins-official    (1 skill)
✔ claude-code-setup@claude-plugins-official (1 skill)
✔ frontend-design@claude-plugins-official    (1 skill)
```

**Reversible** via `claude plugins install <name>@<marketplace>`.

— Audit cerrado. Proceeding to v14.4 P1 implementation.
