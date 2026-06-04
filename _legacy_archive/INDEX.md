# _legacy_archive — INDEX

Carpeta de archivo de la limpieza profunda **2026-06-04** (`DEEP-CLEANUP-2026-06-04`).
Aquí se mueve material **histórico / superado pero potencialmente útil**, fuera del
flujo activo pero recuperable. Se usa este nombre (`_legacy_archive/`) en lugar de
`archive/` **a propósito**: `archive/` está en `.gitignore` y, además, ya existe como
dir de historia operativa. `_legacy_archive/` no está versionado todavía (decide el
orquestador si se versiona o se ignora).

> Regla aplicada: ante la duda, NO borrar — archivar o reportar. Nada de lo movido aquí
> es leído por `control-center/` en runtime ni por hooks vivos.

## Contenido

| Subcarpeta | Origen | Qué es | Por qué se archivó |
|---|---|---|---|
| `web-old-landing/` | `~/.ultron/web/` | Landing page antigua (index.html + index.html.bak + style.css + script.js) | Superada por `docs/web/index.html` (la web nueva, versionada). El dir raíz `web/` estaba **gitignored desde v15.2.12** (se sacó del repo en el "full sanitize"). Contenido de mayo. No referenciado por el producto. |
| `quiz-generator-template/` | `~/.ultron/templates/quiz-generator/` | Plantilla "Quiz Generator" (app.js, index.html, styles.css, README, questions.example.json, schema) | **Trackeada** (v2.13.5, 27-may). El usuario confirma que **nunca se implementó**. No referenciada por `control-center/` ni hooks. Movida con `git mv` (renombrado, conserva historia). 476 KB. |
| `skills-catalog/` | `~/.ultron/skills-catalog/` | Catálogo de ~332 skills 15.x organizadas por categoría (`<category>/<name>/SKILL.md`), 598 ficheros trackeados | **Legacy ULTRON 15.x**. `control-center/` NO lo lee en runtime (lee `~/.claude/skills` y el plugin ECC). Solo lo usaba el **instalador 15.x** (`install.ps1` step 8a''', `install.sh` step 10c) para copiar categorías a `~/.claude/skills/`. Verificado con grep en `control-center/` y `hooks/` = 0 referencias runtime. Movido con `git mv` (conserva historia). **14 MB.** |
| `agents-15x/` | `~/.ultron/agents/` | 19 agentes markdown del repo 15.x (`<name>.md` flat) | **Legacy ULTRON 15.x**. `control-center/` NO lo lee en runtime (lee `~/.claude/agents`: `agents.rs:434`, `catalog.rs:67`). Solo lo usaba el **instalador 15.x** (`install.ps1` step 8a', `install.sh`) para copiar a `~/.claude/agents/`. El `skill_sync_security.py` (ejecutado por `agents.rs:178`) opera sobre `~/.claude/agents/`, NO sobre este dir. Movido con `git mv`. **116 KB.** |
| `tests-python-15x/` | `~/.ultron/tests/` | Suite pytest/Pester del 15.x (67 ficheros trackeados: `test_*.py`, `*.Tests.ps1`) | **Legacy ULTRON 15.x**. `control-center/` NO lo usa en runtime (sus fixtures viven en `src-tauri/src/tests/fixtures/`, ver `test_support.rs`). Movido con `git mv`. **2.3 MB.** ⚠️ **ROMPE CI**: `.github/workflows/ci.yml:156` ejecuta `uv run pytest tests/`. Tras este archivado ese job fallará — el orquestador debe actualizar `ci.yml` (apuntar a `_legacy_archive/tests-python-15x/` o eliminar el job Python si el 15.x ya no se mantiene). |

## Notas

- El contenido de `web-old-landing/` ya NO estaba en git (gitignored), así que moverlo
  no cambia el historial. Si no se necesita como referencia visual, es **BORRAR** seguro.
- Para el resto de candidatos legacy que **NO** se tocaron (por estar referenciados por
  el instalador o por hooks vivos, o por ser datos personales pequeños), ver la sección
  "Dudosos para decisión humana" en `cockpit/memory-rework/DEEP-CLEANUP-2026-06-04.md`.

## PARTE A (2026-06-04) — archivado de legacy 15.x runtime-irrelevante para control-center

Se evaluaron 8 carpetas candidatas. Regla aplicada: archivar solo lo que `control-center/`
**NO** lee en runtime (verificado con grep en `control-center/` y `hooks/`).

### ARCHIVADAS (3) → ver tabla arriba
- `skills-catalog/` (14 MB), `agents/` → `agents-15x/` (116 KB), `tests/` → `tests-python-15x/` (2.3 MB).
- Las tres son legacy 15.x sin lectura runtime de control-center.

### CONSERVADAS (5) — control-center SÍ las usa en runtime (NO archivar)
| Carpeta | Evidencia runtime | Tamaño |
|---|---|---:|
| `skills/` | `skills.rs:90` lee `~/.ultron/skills/registry.json` (SoT del registro de skills, 334 KB) | 380 KB |
| `plans/` | `plans.rs:60` lee `~/.ultron/plans/PLANS.json` | 1.4 MB |
| `instructions/` | `instructions.rs:31` lee `~/.ultron/instructions/<kind>/GUIDE.md` | 20 KB |
| `batches/` | `batches.rs:36` / `batches_queue.rs` — whitelist runner `~/.ultron/batches/` | 70 KB |
| `templates/` | El instalador siembra `templates/*.example` → `~/.ultron` + `~/.claude` (CLAUDE.md, settings-hooks.json, skills-manifest…). Parte aún viva. | 37 KB |

### Impacto en el instalador publicado (queda LEGACY tras este archivado)
El instalador 15.x referencia 2 de las carpetas archivadas. Tras el move, esos pasos
buscan rutas que ya no están en su sitio original:
- `install.ps1` step **8a'** (`agents` → `~/.claude/agents`) y step **8a'''** (`skills-catalog` → `~/.claude/skills`).
- `install.sh` pasos equivalentes (copy `repo/agents/*.md`; `skills-catalog` per-category picker).
- Ambos hacen `Test-Path`/guard antes de copiar, así que **NO crashean**: imprimen
  "directory missing - skip" y continúan. El instalador sigue funcional pero esos dos
  pasos quedan **no-op** (skills/agents 15.x ya no se siembran).
- **Acción sugerida orquestador**: si se sigue publicando el instalador 15.x, repuntar
  esos pasos a `_legacy_archive/...` o eliminarlos. Si el 15.x ya no se mantiene, dejarlos
  como legacy es aceptable (degradan a skip).

### Impacto en CI
- `.github/workflows/ci.yml:156` corre `uv run pytest tests/`. Con `tests/` archivado ese
  job **fallará** (path inexistente). Requiere update del orquestador (repuntar a
  `_legacy_archive/tests-python-15x/` o retirar el job Python).
