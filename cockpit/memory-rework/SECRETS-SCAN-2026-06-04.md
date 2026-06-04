# SECRETS & PERSONAL-DATA SCAN — ULTRON repo (`~/.ultron`) — 2026-06-04

> Pre-publish security gate. Alcance: **solo archivos rastreados por git**
> (`git ls-files`, **1418 ficheros**). El historial `.git` NO se reescribe aquí
> (ver nota al final). Los valores de cualquier hallazgo aparecen **enmascarados**.

Rama: `fullize-2026-05-30` · HEAD al escanear: ver `git rev-parse HEAD`.

## Veredicto

**No se encontró ningún secreto vivo en archivos versionados.** Todos los
patrones de secreto que matchean son: (a) **fixtures/tests** con valores
explícitamente falsos, o (b) **documentación de fugas pasadas ya redactadas**
(`...REDACTED_ROTATE_2026-05-29`). El único riesgo residual es **exposición del
nombre de usuario** vía rutas `C:\Users\USER\...` (severidad BAJA: no es
secreto, pero filtra el handle del SO en un repo que se publicará).

No se redactó nada in-place porque **no hay valores reales que redactar**: los
hits ya estaban enmascarados o son sintéticos. Se generalizaron rutas de ejemplo
en un doc (ver Tarea 2 / `EXTERNALIZAR`).

---

## Tabla de hallazgos

| archivo:línea | tipo | severidad | acción |
|---|---|---|---|
| `cockpit/memory-rework/evals/negative_fixtures.json:15` | `sk-FAKE…` + `ghp_FAKE…` (fixture negativo del eval de redacción) | NINGUNA | mantener (valor falso, prueba que la redacción los caza) |
| `cockpit/memory-rework/evals/negative_fixtures.json:32` | `BEGIN RSA PRIVATE KEY` (`FAKEBASE64…`) | NINGUNA | mantener (fixture) |
| `control-center/src-tauri/src/memory/redaction.rs:345,353,361,375,417,453` | `sk-ant-…`, `ghp_ABCDEF…`, `Bearer eyJ…`, RSA key (tests unit del redactor) | NINGUNA | mantener (test vectors; valores no reales) |
| `skills-catalog/security/ffuf-skill/SKILL.md:210` | `Bearer eyJ…JWT…` (ejemplo de payload en skill de terceros) | NINGUNA | mantener (ejemplo de doc) |
| `cockpit/diagnostics/memory-hooks-2026-05-25.md:38` | `Bearer m0-REDACTED_ROTATE_2026-05-29` | BAJA | ya redactado; rotación pendiente fuera del repo (ver H1) |
| `control-center/docs/mcps-audit-2026-05-27.md:101` | `Bearer ghp_REDACTED_ROTATE_2026-05-29` | BAJA | ya redactado; rotación pendiente fuera del repo (ver H1) |
| `skills-catalog/misc/*/SKILL.md` (varios) | `export *_API_KEY='your_api_key_here'` | NINGUNA | placeholders de docs de terceros |
| `scripts/cockpit/audit_personal_data.py:93-94` | regex literal `anonuser` / `user@example.com` | BAJA | es el **detector** (no un dato filtrado); mantener |
| `control-center/docs/qdrant-setup.md:37,43,60,110` | ruta `C:\Users\USER\.ultron\bin\qdrant.exe` en ejemplos | BAJA | **EXTERNALIZAR/generalizar** → hecho (Tarea 2) |
| `cockpit/memory-rework/evals/golden_set.json:7259,7446,8084,8370` | rutas `C:/Users/USER/...` dentro de queries sintéticas del golden set | BAJA | dato de eval; no se toca (rompería el golden 942). Documentado aquí. |
| `cockpit/memory-rework/specs/SPEC-MAINTENANCE-CLI.md:226` | `FASTEMBED_CACHE_PATH = C:\Users\USER\.ultron\.fastembed_cache` | BAJA | spec interna; nota de externalización (var de entorno ya existe) |
| `cockpit/memory-rework/DISK-FOOTPRINT-2026-06-04.md`, `STATUS-…`, diagnostics `*.md` | rutas `C:\Users\USER\...` en inventarios/docs internos | BAJA | docs internos; aceptable (no se publican como tutorial) |
| `control-center/src-tauri/src/{recall,claude_sessions}.rs`, `commands/batches_sub/opengl_project.rs` | rutas `C:\Users\USER\...` en **comentarios** y 1 test fixture (`recall.rs:834 slug_for(...)`) | BAJA | no funcional; el runtime resuelve home con `dirs::home_dir()`. Aceptable |
| `hooks/manifest.json:7` | `"source_of_truth": "C:/Users/USER/.ultron/hooks/scripts"` | BAJA | ruta funcional per-máquina; ver nota Tarea 2 |
| `batches/staging-workdays-2026-05-25/patch-lib.ps1:2` | `param($LibPath = "C:\Users\USER\.ultron\...")` | BAJA | one-shot histórico; default override-able por param |

### Patrones buscados sin ningún hit (limpio)

- `AIza…` (Google API key) — 0
- `nvapi-` / `nvap…` (NVIDIA NIM) — 0
- `AKIA…` (AWS) — 0
- `glpat-` / `xox[baprs]-` (GitLab/Slack) — 0
- `sk-` genérico ≥32 chars (no-ant, no-test) — 0
- IBAN / cuentas bancarias (`[A-Z]{2}\d{2}…`) — 0
- `_API_KEY=` / `_TOKEN=` con valor literal (no `${ENV}` / placeholder) — 0
- Ficheros `.env` / `settings.json` / `.claude.json` / `*credentials*` **rastreados** — 0
  (solo `.env.example`, que contiene placeholders vacíos y está bien documentado)

---

## Hallazgos heredados (de MEMORY, fuera del working-tree rastreado)

- **H1 — token `gho_`/`m0-` reales en `~/.claude.json` y docs de diagnóstico.**
  Los docs (`mcps-audit`, `memory-hooks`) **ya están redactados** en el repo
  (`...REDACTED_ROTATE_2026-05-29`). El token vivo reside en `~/.claude.json`,
  que **NO está en este repo** (es config global de Claude Code). **Acción
  pendiente NO bloqueante para este repo**: rotar el token en GitHub/Mem0
  (card `sec-rotate-leaked-tokens-2026-05-29`). No hay nada que redactar aquí.

## Nota sobre el historial `.git`

Este escaneo cubre el **working tree rastreado**, no el historial. El
`CLEANUP-PLAN` ya advierte que `.git` pesa ~160 MB por el sidecar binario
histórico y recomienda evaluar `git filter-repo` **antes de publicar el
historial**. Antes del primer push público conviene además:

```
git log --all -- '*.env' '*.key' '*.pem' '**/.credentials.json'
```

para confirmar que ningún secreto entró en commits antiguos. (No ejecutado aquí:
fuera del alcance "no reescribir historial / no commitear" de esta sesión.)
</content>
</invoke>
