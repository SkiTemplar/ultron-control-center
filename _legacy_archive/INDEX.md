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

## Notas

- El contenido de `web-old-landing/` ya NO estaba en git (gitignored), así que moverlo
  no cambia el historial. Si no se necesita como referencia visual, es **BORRAR** seguro.
- Para el resto de candidatos legacy que **NO** se tocaron (por estar referenciados por
  el instalador o por hooks vivos, o por ser datos personales pequeños), ver la sección
  "Dudosos para decisión humana" en `cockpit/memory-rework/DEEP-CLEANUP-2026-06-04.md`.
