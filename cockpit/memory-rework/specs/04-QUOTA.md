# SPEC FULL — QUOTA-AWARE ROUTING (ULTRON)
### Autocontenido para revisión por IA externa · 2026-06-04

## 1. Propósito
Cuando el uso de Claude Max se acerca al límite de la ventana (rate-limit de la suscripción, NO coste en $), hacer FALLBACK AUTOMÁTICO a otras IAs (Codex gpt-5.5, Gemini, NIM free-tier) para no bloquear el trabajo; preservar cuota premium para tareas críticas; recuperar Claude al resetear la ventana. NOTA: el dueño paga Claude Max; el cost hook ($) es notional/informativo, NO billing real — no invertir en `cost_watchdog.rs`.

## 2. Arquitectura (archivos)
- `quota_watchdog.rs` — SSOT del flag, persiste `~/.ultron/cockpit/quota-state.json`, watcher 60s, emite eventos Tauri `quota:critical`/`quota:reset`/`quota:updated`. `QuotaStatus{claude_pct_used, claude_critical, reset_at, last_check}`.
- `ai_router.rs:1526` `try_assignment_call` consulta `quota_watchdog::is_critical()` ANTES de cada provider → fuerza cascadeo.
- `ai_router.rs:956` `react_to_rate_limit` parsea retry-after / anthropic-ratelimit-*-reset.
- `~/.claude/hooks/quota-capture.js` (PostToolUse) — scraping de texto de warnings.
- `ultron-proxy.mjs` — failover declarativo nim→openrouter→groq.
- `codex_fallback.rs` — `launch_codex_fallback_inner` (manual, requiere clic).

## 3. STATUS FULL: 🟡 plomería existe, señal ciega
| Aspecto | Estado | Evidencia |
|---|---|---|
| Watchdog + persistencia + eventos | ✅ | quota_watchdog.rs |
| is_critical() consultado antes de cada provider | ✅ | ai_router.rs:1526 (NO placeholder) |
| Parseo retry-after / reset | ✅ | react_to_rate_limit:956 |
| Proxy failover free-tier | ✅ | ultron-proxy.mjs |
| **Señal de cuota** | 🔴 binaria (0 o ~99 hardcoded) | ai_router.rs:1005 update_from_headers(99.0); quota-capture.js:199 fallback 98.0 |
| **Detector en el path correcto** | 🔴 | react_to_rate_limit solo en call_anthropic (API x-api-key); la cuota Max se agota en la sesión Claude Code CLI (OAuth), que NO pasa por ahí |
| route() gobierna el tráfico de la sesión | 🔴 | Claude Code habla directo con Anthropic salvo proxy ON; proxy es free-tier-only (nunca llama a Claude) |
| **quota:critical -> auto-relevo Codex** | 🔴 | evento NO conectado a acción; fallback Codex manual |
| Routing preventivo (cheap->free para preservar cuota) | 🔴 | imposible sin % gradual |

## 4. QUÉ FALTA (priorizado, del workflow `waqq5qec7`)
1. **Señal real**: el proxy lee headers `anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization` / `-representative-claim` / `-reset` tras cada respuesta de Anthropic y escribe quota-state.json. Convierte la señal de adivinada-por-texto a medida-determinista.
2. **Proxy "Claude-first con degradación"**: añadir Anthropic real como backend[0] condicional, para que el lazo toque el tráfico real (hoy el proxy nunca llama a Claude).
3. **QuotaStatus gradual**: campos five_h_pct/seven_d_pct/representative_claim/soft_constrained; API `is_soft_constrained()` (5h>=80% / 7d>=70%) + `quota_score()`. Degradar zonas no-críticas a free-tier ANTES del corte duro.
4. **Clasificación cheap-vs-critical**: tareas triviales/light SIEMPRE free-tier (preservar ventana Claude); medium/heavy → Claude mientras haya cuota.
5. **quota:critical -> launch_codex_fallback** (cablear el evento al relevo automático).
6. (Fase 2) OTel `CLAUDE_CODE_ENABLE_TELEMETRY=1` para burn-rate medido.

## 5. Política objetivo (condición -> acción -> destino -> recuperación)
| Cuota (ventana representativa) | Tarea | Acción | Destino | Recuperación |
|---|---|---|---|---|
| cualquiera | trivial/light | preventivo: nunca gastar Claude | Groq→NIM→Ollama | n/a |
| 5h<80% y 7d<70% | medium/heavy | Claude normal | Claude → [fallback solo 429] | n/a |
| 5h 80-95% o 7d 70-85% (soft) | medium | degradar suave | free-pool primero | al bajar % |
| 5h>=95% / 7d>=85% (critical) | todo | fallback duro | Codex/Gemini/NIM | al reset de ventana |

## 6. Preguntas para la IA
- ¿Los headers `anthropic-ratelimit-unified-*` son la mejor señal, o hay telemetría OTel superior para Claude Code CLI (OAuth)?
- ¿Cómo detectar el rate-limit de la SESIÓN CLI (no la API key) de forma fiable?
