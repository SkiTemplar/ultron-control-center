# SPEC FULL — MCPs (ULTRON / Claude Code)
### Autocontenido para revisión por IA externa · 2026-06-04 · ESTADO: ⚪ INVENTARIO PARCIAL (no auditado a fondo)

> **[RECONCILIADO 2026-06-04 — ver `../STATE-RECONCILIATION-2026-06-04.md` e `../INFORME-CIERRE-100-2026-06-04.md:95`]**
> Este inventario **solo lee `settings.json`** = mitad del inventario real. Omite `~/.claude.json`, donde
> vive el hallazgo **H1 (token OAuth hardcodeado en plaintext)** — ver §3-bis. Contrato formal de MCPs
> (clasificación core/optional/dangerous/duplicate, política de tokens): `../CONTRACTS-2026-06-04.md` §8.

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

## 3-bis. HALLAZGO P1-SEGURIDAD (INFORME-CIERRE H1) — token OAuth hardcodeado
**Distinto de la rotación histórica** (fuga en docs redactada en `2d64aa3`, cerrada 2026-05-29). Este es un
hallazgo **nuevo y abierto**, fuera de `settings.json`:

| Hallazgo | Ubicación | Estado | Acción |
|---|---|---|---|
| **H1** — token OAuth GitHub `gho_…` (40 chars) **hardcodeado en plaintext** | `~/.claude.json` → MCP `github-pat` | 🔴 ABIERTO (no es la rotación histórica ya cerrada) | auditar `~/.claude.json` completo + **rotar** el token + migrar a `${GITHUB_TOKEN}` por env (como ya hace `settings.json`) |

> Por qué se escapó: este spec inventaría **solo `settings.json`**, y el `github` http de ahí usa la var
> `${GITHUB_TOKEN}` (correcto). El literal `gho_…` vive en el **otro** archivo de config (`~/.claude.json`,
> servidor `github-pat`), que esta auditoría no leyó. Cerrar H1 exige auditar `~/.claude.json`.

## 4. QUÉ FALTA
1. **Auditar `~/.claude.json`** (la otra mitad del inventario) + cerrar **H1**: rotar el token `gho_…` hardcodeado del MCP `github-pat` y migrarlo a env `${GITHUB_TOKEN}`.
2. **Auditar** salud + seguridad del resto de MCPs (workflow de auditoría como con los demás subsistemas).
3. **Rotar** el GITHUB_TOKEN (deuda de seguridad abierta; engloba H1 + la fuga histórica de `2d64aa3`).
4. Evaluar si el **MCP memory de ECC** duplica/compite con el kernel canónico (riesgo de doble store).
5. Decidir qué MCPs son necesarios para el caso de uso (research/memoria) y desactivar el resto.
6. **Formalizar** el contrato MCP (`../CONTRACTS-2026-06-04.md` §8): schema de política MCP — clasificación `core/optional/dangerous/duplicate`, política de tokens (nunca literal en config), y regla anti-doble-store frente al kernel canónico.

## 5. Preguntas para la IA
- ¿Qué MCPs son imprescindibles para un runtime de memoria/research y cuáles son ruido?
- ¿Cómo evitar que el MCP memory de ECC contamine el kernel canónico (SQLite SoT)?
