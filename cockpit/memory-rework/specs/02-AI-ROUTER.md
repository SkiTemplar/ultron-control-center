# SPEC FULL — AI ROUTER (ULTRON)
### Autocontenido para revisión por IA externa · 2026-06-04

> **[RECONCILIADO 2026-06-04 — ver `../STATE-RECONCILIATION-2026-06-04.md`]**
> La fila "Quota-guard antes de cada provider | OK | ai_router.rs:1526 is_critical()" esta STALE:
> Quota fue **QUITADO** en `cbb2d5c`, `is_critical()` ya no existe (0 matches). El gap "quota ciega" no aplica.

## 1. Propósito
No solo proxy para Claude Code, sino ORQUESTADOR MULTI-IA: elegir el mejor modelo por tarea/coste/capacidad, despachar subagentes a Claude/Codex/Gemini/free-tier(NIM), gobernar las tareas baratas del kernel de memoria, y resiliencia por cuota.

## 2. Arquitectura (archivos)
- `ai_router.rs` (~88KB) — `route(zone_id, prompt) -> Result<String,String>`: carga zona, prueba primary, cascada por fallbacks, skip-sin-key, métricas (`bump_metrics`). **[Verificado f936a66 + Codex/Gemini: NO hay quota-guard; `route()` = load_zones + cascada + skip-sin-key + bump_metrics, `ai_router.rs:1365-1424`].** Zonas en seed_zones (utility/light/summarize/routing-decision/...). Wrappers `call_anthropic`/`call_openai_compat`/`call_gemini`/`call_cli`.
- `proxy.rs` + Node `~/.ultron/proxy/ultron-proxy.mjs` — proxy free-tier (NIM/OpenRouter/Groq) con streaming + tool-calls + failover.
- `codex_fallback.rs` — lanzar sesión Codex (manual hoy).
- ~~`quota_watchdog.rs`~~ — **BORRADO en `cbb2d5c`** (Quota % quitado, -465 líneas; ya no existe en `src`). Ver 04-QUOTA.
- `pty.rs::build_command` — YA soporta `claude|codex|gemini`.
- Front: `components/AIRouter/*` (Dashboard/Modelos/Providers/Keys/Proxy).

## 3. STATUS FULL
| Aspecto | Estado | Evidencia |
|---|---|---|
| route() gobierna tareas internas | ✅ | ~10 callers reales: cost_watchdog.rs:279, hooks_admin.rs:1490, workdays.rs:1595/1698, plugins_info.rs:1031, library.rs:1107, project_agents.rs:471/734, sessions_tags.rs:298 |
| Comentario stale "solo botón Test" | ✅ corregido | `1a14a27`-adjacent; era falso |
| Proxy free-tier real | ✅ | ultron-proxy.mjs (NIM qwen3-coder verificado) |
| ~~Quota-guard antes de cada provider~~ | ⚫ QUITADO (`cbb2d5c`) | `is_critical()` ya no existe (0 matches en src); `route()` sin guard de cuota. Ver 04-QUOTA |
| Métricas por modelo/día/free-tier gauge | ✅ | bump_metrics |
| **Orquestador despacha multi-IA** | 🔴 | delegate_task_inner (agent_orchestration.rs:291) hardcodea "claude"; resolve_cheap_model:155 literal "claude-haiku-4-5" |
| **Kernel de memoria consume route()** | 🟡 scaffolded | ai_tasks.rs listo (route("utility"/"summarize")), NO enganchado |
| temperature / response_schema en ZoneAssignment+wrappers | 🔴 | bloqueante para JSON determinista del kernel |
| Cache por input-hash | 🔴 | cada route() pega al proveedor |
| Quality-gate (FrugalGPT) | 🔴 | cascada solo por error técnico, no por calidad |
| Selector dinámico (cost/latency/success) | 🔴 | orden estático del JSON aunque métricas existen |
| Unificar proxy con zones.json | 🔴 | tier-mapping duplicado (Rust + Node) |

## 4. QUÉ FALTA (priorizado, del workflow `wqpf1uiwm`)
1. **temperature + response_schema** en ZoneAssignment + 3 wrappers (OpenAI response_format / Gemini responseSchema / Anthropic tool-forcing). Backward-compatible. → habilita kernel JSON + cache seguro.
2. **delegate_task_inner** acepta provider/zone → `pty::spawn_inner` con claude|codex|gemini; enseñar el sentinel `[AGENT TASK COMPLETE]` a codex/gemini. → captura el 80% del valor multi-IA (reviews a Codex coste 0 OAuth, research a Gemini).
3. **Cache** sha256(zone+model+system+prompt+project) + TTL por zona.
4. **Selector dinámico**: ordenar candidatos vivos por capacidad/key/free-tier-no-agotado/coste/success/latencia (añadir NIM/Cerebras/DeepSeek al gauge).
5. **Quality-gate** + eval-harness 5% (quality_delta).
6. **Zona external-review** (codex-cli/gemini-cli); migrar skills second-opinion/codex:* a delegar ahí.
7. **Unify**: ultron-proxy.mjs lee zones.json; sub-tab "Orquestar tarea" en la UI.

## 5. ModelPolicy objetivo (tarea -> primary -> fallback)
- intent ambiguo → routing-decision: groq llama-3.3-70b → gemini-flash → claude-haiku (temp0, JSON).
- memory-extract/contradict/query-rewrite → groq/gemini-flash free → claude-haiku.
- code review read-only → codex-cli gpt-5 (OAuth 0) → gemini-cli.
- heavy reasoning → claude sonnet → codex-cli.

## 6. Preguntas para la IA
- ¿RouteLLM/LiteLLM-style classifier router vale la pena local, o basta zonas + selector dinámico?
- ¿Cómo medir "ahorro real" sin falsear (free-tier gauge + tokens_saved)?
- ¿Quality-gate con judge al 5% es suficiente para no degradar?
