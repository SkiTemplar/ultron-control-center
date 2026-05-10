---
type: deferred-session
created: 2026-05-04T22:00Z
topic: "ULTRON v14 Master Plan — Sesión de diseño completa"
priority: high
status: pending
version_at_pause: v13.3.0
---

# Resumen de la sesión

Sesión de diseño arquitectónico completa. Se construyó el plan maestro definitivo para la reescritura de ULTRON (v14.0.0 → futura v1.0.0). No se ejecutó código — solo diseño, diagnóstico y fixes de configuración.

# Fixes aplicados (ya en settings.json)

- `superpowers-mcp` eliminado — directorio `mcp-servers/superpowers-mcp/` nunca existió
- Gemini MCP añadido: `@rlabs-inc/gemini-mcp` con `gemini-3.1-pro-preview` + `gemini-3.1-flash-lite`
- Hooks PS: añadido `-WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass`
- superpowers-mcp causaba crash en startup — ya resuelto

# Hallazgo crítico descubierto

El cockpit ya tiene implementadas muchas cosas que el plan anterior asumía construir desde cero:

- `alerts.py` → S1 Pilar B ya hecho — solo integración
- `brain_index.py` → FTS5/BM25, 970 notas, es el ZTMSI al 80%
- `skill_manifest.py` → 373 skills trackeadas con schema completo
- `routing_decide.py` → Thompson Sampling ya existe
- `health.py` + `mcp_broker.py` → base para S5

Esto reduce la estimación de ejecución total en ~40%.

# El plan maestro

**Archivo:** `C:\Users\USER\.ultron\plans\ULTRON-v14-MASTER-DEFINITIVO.md`

Incluye 14 secciones:
- §0: Tres pilares (Scripts Invisibles, Token Efficiency, Inteligencia en Scripts)
- §1-§10: Plan completo S0-S6 con specs binarias
- §11: MCP diagnostic + fixes
- §12: Nuevos requisitos (terminal, hookify, cockpit, keys, agentes, defer, v1.0.0)
- §13: Auditoría de lo existente — qué extender vs qué construir
- §14: Plan cerrado + checklist

# Decisiones pendientes (USER decide)

1. **Nombre del sistema para v1.0.0** — opciones: NEXUS, HERALD, APEX, KRONOS, o ULTRON v1.0.0
2. **Gemini Flash model** — verificar si `gemini-3.1-flash-lite` aparece en tool list
3. **ultron.ps1 `alerts` CLI** — verificar si ya existe antes de S1

# Próximos pasos en orden

1. [ ] Verificar Gemini tools disponibles en tool list (buscar `ask_gemini`)
2. [ ] Leer `ultron.ps1` — buscar subcommand `alerts` — ¿existe?
3. [ ] Decidir nombre del sistema
4. [ ] Despachar S1 Pilar B (integración alerts.py, ~45 min)
5. [ ] Despachar S1 Pilar A (silent execution audit, ~115 min)
6. [ ] Bump v13.3.0 → v13.4.0 "SILENT + ALERTS"

# Estado de MCPs

| MCP | Estado |
|-----|--------|
| gemini | Configurado, verificar en esta sesión |
| gemini-flash | Configurado, verificar en esta sesión |
| codex | OK (gpt-5.5 sandbox read-only) |
| github@plugin | OK |
| context7 | OK (MCP independiente del plugin) |
| n8n-mcp | OK |
| playwright | OK |
| firebase | OK |
| unity | Solo funciona con Unity abierto |
| superpowers-mcp | ELIMINADO |
