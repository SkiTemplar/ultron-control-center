# DEEP CLEANUP — `~/.ultron` — 2026-06-04

> Auditoría profunda carpeta por carpeta del repo `C:\Users\USER\.ultron`.
> Objetivo: limpiar lo que no se usa **sin romper nada y sin suponer**.
> NO git worktree, NO git commit (commitea el orquestador).
>
> **Regla de oro aplicada:** ante la duda, NO borrar — archivar o reportar.
> Todo lo borrado es regenerable y/o estaba gitignored. Todo lo movido fue a
> `_legacy_archive/` (NO `archive/`, que está en `.gitignore`).
>
> **Resultado:** disco `~/.ultron` **43 GB → 38 GB** (~**5 GB liberados**),
> sin tocar runtime, control-center, hooks ni datos canónicos. `git status`
> NO muestra ninguna borrado de fichero trackeado por esta limpieza (solo el
> `git mv` del template quiz-generator y el dir nuevo `_legacy_archive/`).

---

## Metodología

Para cada carpeta top-level se verificó:
1. ¿Está trackeada por git o ignorada? (`git ls-files` / `git check-ignore`)
2. ¿La lee `control-center/` en runtime? (`grep` de `join("<dir>")` / `.ultron/<dir>` en `src-tauri/src`)
3. ¿La escribe algún hook vivo? (`grep` en `hooks/`, `scripts/hooks/`, `~/.claude/scripts/`)
4. ¿La usa el instalador publicado? (`install.ps1`/`install.sh`/`README`)
5. Antigüedad (último commit + mtime).

Clasificación: **CONSERVAR** (usada) · **ARCHIVAR** (histórica, no usada) · **BORRAR** (basura regenerable).

---

## Hallazgo dominante: 6 copias de `.fastembed_cache` (~4.4 GB de basura)

El modelo ONNX E5 (`multilingual-e5-large-onnx`, ~2.1 GB) se descarga al **CWD del
proceso** que lo invoca, porque no hay `FASTEMBED_CACHE_PATH` fijado y la ruta canónica
documentada (`~/.cache/fastembed_cache/`) **no existe**. Resultado: el cache se duplicó
en 6 sitios al correr embeds/evals desde distintos directorios. Eran la causa real de
los "128 MB / 791 MB" que inflaban dirs inocentes (`instructions/mcps`, `cockpit/memory-rework`).

| Ruta | Tamaño | Acción |
|---|---:|---|
| `~/.ultron/.fastembed_cache` | 2.3 GB | **CONSERVAR** (canónica: es el CWD más común, runtime depende de cwd-relative) |
| `control-center/src-tauri/.fastembed_cache` | 2.3 GB | **BORRADO** (dup completo) |
| `control-center/.fastembed_cache` | 931 MB | **BORRADO** (dup parcial) |
| `cockpit/memory-rework/.fastembed_cache` | 791 MB | **BORRADO** (dup eval) |
| `control-center/src-tauri/src/.fastembed_cache` | 128 MB | **BORRADO** (dup parcial, dentro de `src/`) |
| `instructions/mcps/.fastembed_cache` | 128 MB | **BORRADO** (dup parcial) |
| `control-center/src-tauri/target/release/.fastembed_cache` | 128 MB | **BORRADO** (dup parcial) |

Liberado: **~4.4 GB**. Todos gitignored (`**/.fastembed_cache/`), todos auto-regenerables.
Se conservó la copia raíz para no ralentizar el primer arranque (re-descarga 2.1 GB).
**Recomendación de fondo:** fijar `FASTEMBED_CACHE_PATH=~/.ultron/.fastembed_cache` (o
`~/.cache/fastembed_cache`) en el arranque del producto para que no vuelva a duplicarse.

---

## Auditoría carpeta por carpeta

### PRODUCTO ACTIVO — CONSERVADO intacto

| Carpeta | Trackeada | ¿Se usa? Evidencia | Acción |
|---|---|---|---|
| `control-center/` | sí | El producto Tauri. Núcleo. | **CONSERVAR** (solo se borraron caches `.fastembed_cache` parásitas dentro) |
| `hooks/` | sí | Hooks vivos (manifest.json, install-hooks.ps1, scripts/) | **CONSERVAR** |
| `scripts/` (4.3 MB) | sí | `agents.rs:178` ejecuta `scripts/cockpit/skill_sync_security.py`; `scripts/hooks/*` son hooks vivos (auto-recall, intent-dispatcher, pre/post_compact, track-knowledge-reads, session-init) | **CONSERVAR** |
| `bin/` (55 MB) | no (ignored) | Sidecars activos `ultron-memory.exe` + `ultron-embed.exe` (referenciados por `ai_router.rs`, `bin/ultron_*.rs`) | **CONSERVAR exes**; se borraron los 8 `.bak-pre-*` (ver abajo) |
| `config/` | sí | Config del producto | **CONSERVAR** |
| `docs/` | sí | Web nueva (`docs/web/index.html`) + docs de producto | **CONSERVAR** |
| `.github/` | sí | CI | **CONSERVAR** |
| `qdrant-native/` (85 MB) | parcial | Binario Qdrant activo (memoria semántica) | **CONSERVAR** (NO TOCAR) |
| `qdrant_storage/` (393 MB) | no (ignored) | Índice vectorial vivo (mtime hoy vía brain.db) | **CONSERVAR** (NO TOCAR) |
| `brain.db` (4 MB) | no (ignored) | DB canónica de memoria (SoT). mtime = ahora. | **CONSERVAR** (NO TOCAR) |
| `instructions/` (20 KB) | no (ignored) | `instructions.rs` lee `~/.ultron/instructions/<kind>/GUIDE.md` en runtime | **CONSERVAR** (los 128 MB eran el cache parásito ya borrado) |
| `plans/` (1.4 MB) | no (ignored) | `plans.rs` lo lee en runtime | **CONSERVAR** |
| `cockpit/` (3.5 MB) | parcial | Estado operativo del producto (projects, workdays, etc.) | **CONSERVAR** (los 791 MB eran cache parásito ya borrado) |
| `git-hooks/` | sí | Git hooks del repo | **CONSERVAR** |
| `proxy/` (36 KB) | no (ignored) | Sidecar proxy vendor (fullize) | **CONSERVAR** |

### Hooks vivos escriben aquí — CONSERVADO (gitignored, NO runtime de control-center pero SÍ hooks)

| Carpeta | Tamaño | Escritor vivo | Acción |
|---|---:|---|---|
| `sessions/` | 2.4 MB | `scripts/hooks/post_compact.py`, `pre_compact.py` | **CONSERVAR** |
| `telemetry/` | 3.2 MB | `auto-recall.py`, `intent-dispatcher.py` | **CONSERVAR** |
| `audits/` | 174 KB | `session-init.ps1` | **CONSERVAR** |
| `knowledge/` | 16 KB | `track-knowledge-reads.py` | **CONSERVAR** |
| `.venv/` | 957 MB | `session-init.ps1` usa `.venv\Scripts` | **CONSERVAR** (regenerable pero LIVE) |

### BORRADO — basura regenerable inequívoca

| Ítem | Tamaño | Trackeado | Por qué es seguro |
|---|---:|---|---|
| 6× `.fastembed_cache` duplicados (tabla arriba) | ~4.4 GB | no (ignored) | Auto-descargable; se conservó la copia raíz |
| `bin/ultron-memory.exe.bak-pre-*` (×8) | 229 MB | no (ignored) | Backups del sidecar; regenerables (`cargo build`/`install-sidecars.ps1`). El `.exe` activo se conserva |
| `.uv-cache-rescue/` | 854 MB | no (ignored) | Cache de rescate uv antiguo (archive-v0, builds-v0…), regenerable |
| `.tmp.driveupload/` | 11 MB | no (ignored) | Restos de subida parcial a Google Drive (ficheros con nombre numérico). Basura pura |
| `.playwright-mcp/` | 201 KB | no (ignored) | Cache de Playwright MCP, regenerable |
| `target/release/.fastembed_cache` | (incluido arriba) | no (ignored) | Cache parásito en build output |

**Total BORRADO: ~5.5 GB** (algunos se solapan en el delta neto de 5 GB porque la medición `du` ya descontaba enlaces/locks).

> `.pytest_cache/` (0 ficheros) quedó **bloqueado** (Permission denied, fichero en uso).
> Es 0 bytes y gitignored; inocuo. No se reintentó con fuerza para no arriesgar.

### ARCHIVADO → `_legacy_archive/` (histórico, no usado, recuperable)

| Ítem | Origen | Tamaño | Por qué |
|---|---|---:|---|
| `web-old-landing/` | `~/.ultron/web/` | 72 KB | Landing vieja. Superada por `docs/web/index.html`. `web/` estaba gitignored desde v15.2.12 (sacada del repo). No referenciada por el producto |
| `quiz-generator-template/` | `~/.ultron/templates/quiz-generator/` | 476 KB | **Trackeada** (v2.13.5). El usuario confirma que **nunca se implementó**. No referenciada por control-center ni hooks. Movida con `git mv` (conserva historia) |

Hay un `_legacy_archive/INDEX.md` que documenta el contenido.

---

## DUDOSOS — para decisión humana (NO TOCADOS)

Estos NO se tocaron por estar referenciados por el **instalador publicado** o por ser
**datos personales/históricos** cuyo borrado aporta poco y arriesga perder contexto.
El repo se sigue publicando, así que el instalador v15.x todavía depende de varios.

### 1. Carpetas legacy ULTRON 15.x **trackeadas** y referenciadas por el instalador

`control-center` (el producto que el usuario corre) **NO** las lee en runtime — lee
`~/.claude/agents`, `~/.claude/skills` y el plugin ECC. Pero `install.ps1`/`install.sh`/`README`
sí las copian a `~/.claude/` durante la instalación. Borrarlas rompería el instalador del repo.

| Carpeta | Tamaño | Trackeada | Lee control-center | Referencia viva | Veredicto sugerido |
|---|---:|---|---|---|---|
| `skills-catalog/` (617 archivos) | 14 MB | sí | NO | `install.ps1` (paso 8a), `install.sh`, README | **Decisión humana**: si se deja de publicar el instalador v15.x → ARCHIVAR; si no → CONSERVAR |
| `skills/` | 380 KB | sí | NO (lee `~/.claude/skills`) | installer stubs | idem |
| `agents/` (19) | 116 KB | sí | NO (lee `~/.claude/agents`) | `install.ps1` Install-Agents | idem |
| `assets/screenshots/` | 460 KB | sí | NO | README/install | **CONSERVAR** probable (assets de README) |
| `templates/` (resto) | ~40 KB | sí | parcial | installer seeds (apps.default.json, *.example) | **CONSERVAR** (plantillas de instalación; ya quité solo quiz-generator) |
| `tests/` (Python 15.x, 125 archivos) | 2.3 MB | sí | NO | CI / pytest del 15.x | **Decisión humana**: si el 15.x ya no se mantiene → ARCHIVAR; si CI los corre → CONSERVAR |
| `batches/` | 70 KB | parcial | **SÍ** (`batches.rs` → whitelist `~/.ultron/batches/`) | Run Batch del producto | **CONSERVAR** (sí se usa) |

### 2. Carpetas gitignored sin escritor vivo (datos personales/históricos)

No las lee control-center ni las escribe ningún hook vivo. Son pequeñas. Borrarlas
libera poco y podría perder historia personal. **No tocadas** por la regla de oro.

| Carpeta | Tamaño | Último mtime | Veredicto sugerido |
|---|---:|---|---|
| `multimodel/` | 500 KB | 2026-05-05 | ARCHIVAR/BORRAR (sin escritor vivo). Verificar con humano |
| `metrics/` | 4 KB | 2026-05-08 | idem |
| `roadmap/` | 24 KB | 2026-05-09 | idem |
| `archive/` | 219 KB | 2026-05-22 | CONSERVAR (es ya el dir de historia; gitignored) |
| `integrity/` | 8 KB | 2026-05-06 | CONSERVAR (puede ser SoT de settings snapshots) |
| `personal/` | 16 KB | 2026-05-17 | **NO TOCAR** (datos personales, gitignored explícito) |

### 3. `.tmp/` (14 MB) — papelera de scratch con estado vivo mezclado

Gitignored (`.tmp/`). Contiene **200+ ficheros one-shot** (`_ack.py`, `_count2.py`,
`codex-s5-*.txt`, `ultra-test-*.png`, backups JSON de PLANS) — exactamente los
"temporales" que el usuario ve. PERO también tiene estado que parece vivo
(`current-session.json`, `ai-router.json`, `token-usage.jsonl`, `.tmp/evals/*.md` reales).
**No vaciado** para no romper nada. Recomendación: el humano puede borrar a mano los
`_*.py`, `*-r2/*-r3`, `commit-msg-*.txt`, `ultra-test-*.png`, `peer-*` — son scratch puro.

### 4. `backups/` (928 MB) — gitignored, datos del usuario

El grande: `pre-v14.9-2026-05-10-134132-fb47` = **900 MB** (snapshot pre-v14.9).
**No tocado**: son backups del usuario, posible valor de auditoría, y la regla de oro
prohíbe borrar datos dudosos. Candidato a **rotación generacional** por decisión humana
(conservar N recientes + el `protected` de 900 MB o moverlo fuera del repo).

### 5. Lock files de 0 bytes en raíz

`alerts.jsonl.lock`, `skill-provenance.lock` (0 bytes, gitignored). **No borrados**:
podrían ser locks que la app recrea; borrar un lock activo puede causar carreras.
Inocuos en disco. `alerts.jsonl.archive` (2 KB) tampoco tocado.

---

## Resumen ejecutivo

- **Disco liberado: ~5 GB** (43 GB → 38 GB), 100% regenerable, 0 datos canónicos tocados.
- **Causa raíz del bloat: `.fastembed_cache` x6** (~4.4 GB) por falta de `FASTEMBED_CACHE_PATH`.
  Se conservó 1 copia. **Acción de fondo recomendada:** fijar la ruta de cache en el arranque.
- **Borrado seguro:** 6 caches fastembed dup + 8 backups de sidecar (229 MB) + `.uv-cache-rescue`
  (854 MB) + `.tmp.driveupload` (11 MB) + `.playwright-mcp`.
- **Archivado:** `web/` viejo + `templates/quiz-generator/` (confirmado legacy por el usuario) → `_legacy_archive/`.
- **NO se rompió nada:** control-center, hooks, sidecars, brain.db, qdrant_storage/-native intactos.
  `git status` no muestra deletions trackeadas salvo el `git mv` del quiz-generator (renombrado).
- **Dudosos para el humano:** dirs legacy 15.x trackeadas (`skills-catalog`, `tests`, `skills`,
  `agents`) que el instalador publicado aún usa; `backups/` 900 MB; `.tmp/` scratch mezclado;
  carpetas gitignored sin escritor (`multimodel`, `metrics`, `roadmap`).

## Lo que el orquestador debe commitear

- `R templates/quiz-generator/* -> _legacy_archive/quiz-generator-template/*` (git mv, 6 ficheros)
- `?? _legacy_archive/INDEX.md` y `?? _legacy_archive/web-old-landing/` (untracked; decidir si versionar o gitignorar)
- (El resto de borrados eran gitignored: no aparecen en git.)
