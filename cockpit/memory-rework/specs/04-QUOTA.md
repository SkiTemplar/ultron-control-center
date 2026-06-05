# SPEC FULL — QUOTA-AWARE ROUTING (ULTRON)
### Autocontenido para revisión por IA externa · 2026-06-04

> **ACTUALIZACION 2026-06-04: el sistema de Quota % se QUITO (commit `cbb2d5c`).**
> La señal era binaria hardcoded (99.0/98.0, NO el rate-limit real de Max); el gauge
> en Usage mostraba un % inventado y ponia la app en "Degraded". Hacerlo bien exige un
> proxy Claude-first que intercepte toda la sesion (invasivo, tumba la sesion si falla).
> Decision del dueno: quitarlo (quota_watchdog.rs borrado, UI fuera, ai_router limpio).
> Lo de abajo queda como REFERENCIA DE DISEÑO por si algun dia se retoma con señal real;
> HOY NO existe en el codigo.

## 1. Propósito
Cuando el uso de Claude Max se acerca al límite de la ventana (rate-limit de la suscripción, NO coste en $), hacer FALLBACK AUTOMÁTICO a otras IAs (Codex gpt-5.5, Gemini, NIM free-tier) para no bloquear el trabajo; preservar cuota premium para tareas críticas; recuperar Claude al resetear la ventana. NOTA: el dueño paga Claude Max; el cost hook ($) es notional/informativo, NO billing real — no invertir en `cost_watchdog.rs`.

## 2. ~~Arquitectura (archivos)~~ — RETIRADA en `cbb2d5c` (descripción en PASADO)
> Las rutas y símbolos de esta sección describían el sistema **mientras existía**. Tras
> `cbb2d5c` el grueso fue **borrado**; lo que sobrevive son huérfanos residuales (ver §7).
> Verbos en pasado/tachado para que no se lea como código vivo.

- ~~`quota_watchdog.rs`~~ — **BORRADO** (`cbb2d5c`, -465 líneas). Era el SSOT del flag; persistía `~/.ultron/cockpit/quota-state.json`, watcher 60s, emitía eventos Tauri `quota:critical`/`quota:reset`/`quota:updated`; tipo `QuotaStatus{claude_pct_used, claude_critical, reset_at, last_check}`. Ya **no existe** ningún archivo `quota_watchdog.rs` en `src-tauri/src/`.
- ~~`ai_router.rs:1526` `try_assignment_call` → `quota_watchdog::is_critical()`~~ — **ELIMINADO** (`cbb2d5c`, ai_router -82 líneas). Consultaba el flag antes de cada provider para forzar cascadeo; hoy `route()` ya **no** llama a ninguna función `is_critical()` (0 referencias `quota` en `ai_router.rs`).
- ~~`ai_router.rs:956` `react_to_rate_limit`~~ — el parseo de `retry-after` / `anthropic-ratelimit-*-reset` que alimentaba la cuota fue retirado junto con el watchdog. (El manejo genérico de 429 que no dependía de quota queda fuera de este spec.)
- ~~`~/.claude/hooks/quota-capture.js` (PostToolUse)~~ — el hook **sigue en disco** pero quedó **huérfano** (su lector Rust ya no existe) y **YA fue desregistrado** de `settings.json` (P0 config viva, `d3a16ff`; `PostToolUse=[]`). Detalle en §7 (DR-07).
- ~~`ultron-proxy.mjs`~~ — el failover declarativo `nim→openrouter→groq` del proxy free-tier **no formaba parte del retiro**: sigue vivo como proxy free-tier, pero **nunca** participó del path de cuota Max (nunca llama a Claude). Fuera del alcance de este spec a partir de ahora.
- ~~`codex_fallback.rs` `launch_codex_fallback_inner`~~ — el relevo manual a Codex **nunca llegó a cablearse** al evento `quota:critical` (que ya no se emite). El lanzamiento manual de Codex, si subsiste, es independiente de la cuota.

## 3. ~~STATUS FULL: 🟡 plomería existe, señal ciega~~ — OBSOLETO tras `cbb2d5c`
> Esta tabla describía el estado **antes** del retiro. Se conserva en pasado como registro
> histórico de por qué se decidió quitar (señal ciega + path equivocado). **HOY** la columna
> "Estado actual" manda: el subsistema **no existe**.

| Aspecto (cómo estaba ANTES de `cbb2d5c`, verbos en PASADO) | Estado entonces | Estado actual (HEAD) |
|---|---|---|
| Watchdog + persistencia + eventos | ✅ existía | ❌ `quota_watchdog.rs` BORRADO; sin eventos `quota:*` |
| `is_critical()` se consultaba antes de cada provider | ✅ no era placeholder | ❌ 0 referencias `quota` en `ai_router.rs` |
| Parseo retry-after / reset (para cuota) | ✅ lo hacía `react_to_rate_limit` | ❌ retirado con el watchdog |
| Proxy failover free-tier | ✅ existía `ultron-proxy.mjs` | 🟢 sigue vivo, pero fuera del path de cuota (nunca llamó a Claude) |
| **Señal de cuota** | 🔴 era binaria (0 o ~99 hardcoded) — `update_from_headers(99.0)`, `quota-capture.js` fallback 98.0 | ❌ N/A (motivo principal del retiro: señal inventada) |
| **Detector en el path correcto** | 🔴 `react_to_rate_limit` vivía solo en call_anthropic (API x-api-key); la cuota Max se agotaba en la sesión Claude Code CLI (OAuth), que NO pasaba por ahí | ❌ N/A |
| route() gobernaba el tráfico de la sesión | 🔴 Claude Code hablaba directo con Anthropic salvo proxy ON; proxy free-tier-only | ❌ N/A |
| **quota:critical -> auto-relevo Codex** | 🔴 el evento NO estaba conectado a acción; fallback Codex era manual | ❌ evento ya no se emite |
| Routing preventivo (cheap->free para preservar cuota) | 🔴 era imposible sin % gradual | ❌ N/A |

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

## 7. Huérfanos residuales tras `cbb2d5c`
El núcleo (`quota_watchdog.rs`, ramas `quota` de `ai_router.rs`) se borró en `cbb2d5c`, pero el retiro
**no fue total**: quedan productores, datos y UI que apuntan a un backend inexistente. Cada uno está
registrado en `DEPRECATION-REGISTRY-2026-06-04.md` (sección B). Estado **verificado a 2026-06-04** (HEAD no se hardcodea — obtener con `git rev-parse --short HEAD`; línea posterior a `cbb2d5c`: `823ed67` → `f936a66` → `cda7a99` → `79a962c` → `4558554`):

| DR | artefacto | ruta | estado verificado | acción de limpieza |
|---|---|---|---|---|
| **DR-07** | `quota-capture.js` (PostToolUse) | `~/.claude/hooks/quota-capture.js` | **EN DISCO** pero productor huérfano (su lector Rust ya no existe); **YA desregistrado** de `settings.json` en `d3a16ff` (`PostToolUse=[]`). Inerte: el hook no se dispara. | borrar el archivo del disco (opcional; ya no se ejecuta) |
| **DR-08** | `quota-state.json` (98%, `critical:true`) | `cockpit/quota-state.json` | **YA BORRADO** (P0 config viva, `d3a16ff`). Nadie lo leía. | hecho |
| **DR-09** | comentarios "quota watchdog" | `lib.rs:556-557`, `644-646` | **VIVOS** en Rust: comentarios sin código detrás (el watchdog ya no existe). Inofensivos pero engañosos. | borrar comentarios (requiere rebuild) |
| **DR-10** | `QuotaDot` + `useQuotaDot` | `Sidebar.tsx:213-285,497-500` | **VIVOS** en React: el componente **invoca `quota_get_status`, comando Tauri INEXISTENTE** (se quitó en `cbb2d5c`). Render con señal falsa (0% verde) y `invoke` que falla en silencio. | eliminar componente + hook |
| **DR-11** | listeners `quota:critical` / `quota:reset` | `ProxyControl.tsx:13,133-168` | **VIVOS** en React: `useEffect` que escucha eventos Tauri que **ya nadie emite** (watchdog borrado). Listeners muertos. | eliminar `useEffect` |
| **DR-12** | descriptor `quota-capture` activo | `hooks_admin.rs:1641-1643` | **VIVO** en Rust: descriptor stale que sigue anunciando el hook como activo aunque esté desregistrado. | actualizar descriptor (rebuild) |
| **DR-13** | comentario "usage stats + quota" | `Usage.tsx:530` | **VIVO** en React: comentario stale; la tarjeta de Usage que mostraba el % ya fue retirada. | editar comentario |

> Mientras DR-09..DR-13 sigan en el árbol, **el código contradice este propio banner** (describe en
> presente algo borrado). DR-07/DR-08 ya están neutralizados a nivel de ejecución (desregistrado /
> borrado); el resto es deuda cosmética (comentarios + UI que invoca comandos inexistentes), `risk` bajo.

## 8. Criterio de "retiro completo" y rollback
**Retiro completo (definición de hecho, comprobable):** las TRES condiciones a la vez —
1. **0 referencias `quota`** en `ai_router.rs` (núcleo de routing limpio). *(YA cumplido tras `cbb2d5c`.)*
2. **0 comandos `quota_*`** registrados en `lib.rs` (ningún `#[tauri::command]` ni entrada en `generate_handler!` con nombre `quota_*`).
3. **0 `invoke("quota_*")` / `invoke('quota_*')`** en `control-center/src/` (frontend sin llamadas a comandos de cuota inexistentes — cubre DR-10 `quota_get_status`).

Hasta que las tres den cero, el retiro está **parcial**: los huérfanos de §7 (DR-09..DR-13) son el delta
pendiente. Comprobación sugerida (no destructiva), siempre con rutas reales del repo:

```bash
# 1) núcleo de routing
rg -n "quota" control-center/src-tauri/src/ai_router.rs        # esperado: 0
# 2) comandos Tauri
rg -n "quota_" control-center/src-tauri/src/lib.rs              # esperado: 0
# 3) invocaciones desde el frontend
rg -n "invoke\\(['\"]quota_" control-center/src/                # esperado: 0
```

**Rollback:** el retiro es un único commit atómico, así que revertirlo completo es
`git revert cbb2d5c` (restaura `quota_watchdog.rs`, las ramas `quota` de `ai_router.rs` y el wiring
asociado). Para una reintroducción "bien hecha" (señal real vía proxy Claude-first) **no** revertir:
partir de §4 de este spec, que ya describe el diseño con señal determinista por headers
`anthropic-ratelimit-unified-*`.
