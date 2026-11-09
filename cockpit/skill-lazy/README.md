# skill-lazy — carga diferida de skills

Claude Code carga los metadatos (SKILL.md) de todas las skills activas en cada
sesión. Para no pagar ese coste, las skills se desactivan y solo se cargan
cuando hacen falta.

> **Estado (2026-10-08):** el dispatcher de esta carpeta **no está registrado
> como hook** desde el 2026-09-29 (commit 7ff38577): no aparece en
> `~/.claude/settings.json` ni en `hooks/manifest.json`. Hoy solo lo ejecutan
> los arneses de esta carpeta, el job `routing-dispatcher` del CI y los
> benchmarks; ninguna skill desactivada se inyecta sola en un prompt. Volver a
> cablearlo es una decisión de producto, no un arreglo.

---

## Nivel 1 (físico): skills fuera de la carga

Una skill desactivada vive en `~/.claude/skills/_disabled/<nombre>/`. Claude
Code no desciende a subdirectorios, así que no la carga. El interruptor de la
pestaña Skills del Control Center hace ese movimiento (`skills/origin.rs`).

El sufijo antiguo `<nombre>.disabled` **sí carga** en Claude Code: es legacy y
no sirve para desactivar. El script que lo aplicaba (`apply-lazy-skills.ps1`)
se borró el 2026-10-08.

## Nivel 2 (dinámico): `routing-dispatcher.v2.js` + `v3.js`

Diseño, hoy sin cablear: en `UserPromptSubmit`, el v2 puntúa de forma
determinista (dominios y frases en español e inglés) cada skill
`lazy_loadable`; si duda, el v3 añade un fallback semántico. Si una skill
supera el umbral, el hook lee su SKILL.md (de `_disabled/`, del sufijo legacy
`.disabled` o de la carpeta activa) y lo inyecta en `additionalContext`:

    --- [skill-inyectada: NOMBRE] ---
    <contenido de SKILL.md>
    --- [fin skill-inyectada: NOMBRE] ---

El coste por prompt es el tamaño del SKILL.md inyectado (500-6000 tokens) y
solo se paga cuando la skill puntúa alto. Un marcador por `session_id` evita
reinyectar la misma skill en la misma sesión. Ante cualquier error el hook no
inyecta nada y nunca bloquea el prompt.

Para volver a cablearlo habría que añadir a `~/.claude/settings.json` un hook
`UserPromptSubmit` con `node ~/.ultron/cockpit/skill-lazy/routing-dispatcher.v2.js`
y regenerar el manifest (`node hooks/regen-manifest.js`).

---

## Verificación

Tras tocar el routing deben quedar verdes:

    node cockpit/skill-lazy/_verify_final.js
    node cockpit/skill-lazy/_accuracy_at3.js

---

## Archivos de esta carpeta

| Archivo | Descripción |
|---------|-------------|
| `routing-dispatcher.v2.js` | Dispatcher determinista con inyección lazy (sin cablear) |
| `routing-dispatcher.v3.js` | Fallback semántico del v2 (sin cablear) |
| `id-resolver.js` | Resolución de ids de skills, plugins y agentes |
| `sync-registry.js` | Genera `skills-registry.json` desde el dispatcher y el disco |
| `compute-metrics.py` | Métricas del routing a partir del log |
| `_verify_final.js`, `_accuracy_at3.js` | Arneses de verificación |
| `*.selftest.mjs` | Selftests (clasificados en `scripts/selftests.manifest.json`) |
