# SPEC FULL — MCPs (ULTRON / Claude Code)
### Autocontenido para revisión por IA externa · 2026-06-04 · ESTADO: ⚪ SIN AUDITAR

## 1. Propósito
Servidores Model Context Protocol que dan herramientas externas a Claude Code (docs, browser, otra IA, GitHub). NO auditados a fondo en este batch — este spec es un inventario + plan de auditoría, no un status verificado.

## 2. Inventario (settings.json `mcpServers`)
| MCP | Tipo | Config | Uso |
|---|---|---|---|
| context7 | stdio | @upstash/context7-mcp | docs de librerías up-to-date |
| playwright | stdio | @playwright/mcp | browser/E2E |
| codex | stdio | @openai/codex mcp-server, sandbox read-only, model gpt-5.5 | segunda IA (reviews, rescue) |
| github | http | api.githubcopilot.com/mcp, `Authorization: Bearer ${GITHUB_TOKEN}` | repos/PRs/issues |

Plugins ECC añaden más (memory, sequential-thinking, exa, etc.) vía `plugin_ecc_*`.

## 3. STATUS: ⚪ sin verificar
| Aspecto | Estado |
|---|---|
| Inventario | ✅ (este doc) |
| Salud/conectividad en runtime | ⚪ sin medir |
| Seguridad del token github | 🔴 riesgo conocido | fuga histórica de tokens en docs (redactada commit 2d64aa3); **rotación pendiente** ([[security-keys-exposed-2026-05-27]]) |
| ${GITHUB_TOKEN} vía env (no hardcoded) | ✅ | settings.json usa la var, no el literal |
| Utilidad para el caso de uso (memoria/research) | ⚪ sin evaluar (¿faltan? ¿sobran?) |
| Interacción con el kernel de memoria | ⚪ | ¿el MCP memory de ECC compite con el kernel canónico? revisar |

## 4. QUÉ FALTA
1. **Auditar** salud + seguridad de los 4 MCPs (workflow de auditoría como con los demás subsistemas).
2. **Rotar** el GITHUB_TOKEN (deuda de seguridad abierta).
3. Evaluar si el **MCP memory de ECC** duplica/compite con el kernel canónico (riesgo de doble store).
4. Decidir qué MCPs son necesarios para el caso de uso (research/memoria) y desactivar el resto.

## 5. Preguntas para la IA
- ¿Qué MCPs son imprescindibles para un runtime de memoria/research y cuáles son ruido?
- ¿Cómo evitar que el MCP memory de ECC contamine el kernel canónico (SQLite SoT)?
