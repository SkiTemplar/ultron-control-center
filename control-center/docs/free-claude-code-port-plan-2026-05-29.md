# Plan de port/adaptación de free-claude-code a ULTRON (2026-05-29)

Investigación del repo `Alishahryar1/free-claude-code` (MIT) para cubrir las dos
peticiones de USER:
1. **Lanzar subagentes con otras IAs** (no-Claude).
2. **Que la sesión principal cambie de ruta** cuando se acabe la quota de Claude.

## Qué es free-claude-code (verificado leyendo el código)

Un **proxy HTTP local que implementa la Anthropic Messages API** y reenvía a 17
providers. Mecanismo: Claude Code lee `ANTHROPIC_BASE_URL` al arrancar → si apunta
a `http://localhost:8082`, TODO su tráfico va al proxy, que traduce
Anthropic ↔ provider y devuelve en formato Anthropic. Claude Code no se modifica.

- **Stack:** Python 3.14 + `uv` + FastAPI/Uvicorn (`server.py` → `uvicorn server:app --port 8082`).
- **Wrapper (`cli/session.py`):** setea `ANTHROPIC_BASE_URL` (deriva de API_URL, quita `/v1`),
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=190000`, y hace `asyncio.create_subprocess_exec(claude ...)`.
  **No tiene manejo específico de Windows** (ULTRON ya resuelve eso, ver gotcha wt.exe/.cmd).
- **Routing (`api/model_router.py`):** mapea los tiers de Claude (opus/sonnet/haiku) a
  `provider/model` vía env `MODEL_OPUS` / `MODEL_SONNET` / `MODEL_HAIKU`, o sintaxis directa
  `provider/model`. Sencillo y limpio.
- **Traducción (lo difícil y valioso):**
  - `providers/anthropic_messages.py` (17 KB) — parseo Anthropic Messages.
  - `providers/openai_compat.py` (22 KB) — streaming SSE + tool_use + thinking blocks para
    Groq/DeepSeek/Cerebras/Fireworks/etc.
  - `providers/gemini/`, `providers/registry.py` (19 KB), `providers/rate_limit.py`,
    `providers/error_mapping.py`.
- **Config:** `config/settings.py` (pydantic, 22 KB), `config/provider_catalog.py`.
- **Extras que NO necesitamos:** `messaging/` (Discord/Telegram), voz/Whisper, `api/admin_*`
  (UI web propia — ULTRON ya tiene su Settings).

## Cómo cubre las dos peticiones

| Petición | Cómo |
|---|---|
| **Subagente con otra IA** | Lanzar una sesión Claude Code (con el `spawn-claude-session.ps1` que ya existe) con `ANTHROPIC_BASE_URL=http://localhost:8082` → esa sesión corre 100% sobre Groq/Gemini. Un "subagente Gemini" = una sesión apuntada al proxy. |
| **Principal cae a free tier sin tokens** | El proxy lee `~/.ultron/cockpit/quota-state.json`. Modo passthrough→Anthropic normal; cuando `claude_critical=true` (98%, ya lo calcula el quota-watchdog) reenvía a Groq/Gemini. Wiring nuevo de ~30 líneas en el proxy. |

## Approach recomendado: **A — vendoring del proxy como sidecar ULTRON**

Portar el proxy a `~/.ultron/proxy/` y gestionarlo como un sidecar más (igual que
`ultron-embed.exe`), arrancado por el backend Tauri. **Reutilizar la capa de traducción
tal cual** (es battle-tested y es justo lo que cuesta semanas hacer bien: streaming SSE,
tool_use, thinking). MIT lo permite.

- **Reutilizar:** `api/` (menos admin), `providers/` (menos los providers que no usemos),
  `config/settings.py`, `config/provider_catalog.py`, `server.py`.
- **Tirar:** `messaging/`, voz, `api/admin_*`, providers que no quieras (kimi/wafer/zai/opencode…).
  Quedarnos con groq, gemini, deepseek, cerebras, openrouter, ollama.
- **Añadir (wiring ULTRON):**
  1. Lifecycle del sidecar en `src-tauri` (spawn/stop del `uvicorn`, healthcheck en :8082).
  2. Lectura de `quota-state.json` en el proxy → decide passthrough vs reroute.
  3. Pasar las keys (ya en env de usuario) al proceso del proxy.
  4. Flag en `spawn-claude-session.ps1`: `-FreeTier` → setea `ANTHROPIC_BASE_URL`.
  5. Toggle en Settings/Usage: "Rutar por free tier" (manual ON/OFF + auto-on-quota).

### Approach B (descartado): reescribir el proxy en Rust dentro del backend
Reutilizaría `call_openai_compat`/`call_gemini` que ya existen, pero habría que
reimplementar la traducción de streaming/tool_use de la Anthropic Messages API (los ~40 KB
difíciles). Alto riesgo, semanas. **No recomendado.**

## Riesgos (ordenados por impacto)

1. **Calidad agentic (ALTO, inherente — no es bug del proxy):** Claude Code depende muchísimo
   de `tool_use`. Llama/Gemini son peores llamando herramientas → el coding agentic se degrada
   al rutar, por bueno que sea el proxy. Free tier ≠ calidad Claude. Gestionar expectativas:
   esto sirve para tareas baratas / cuando NO te queda quota, no como reemplazo permanente.
2. **Rate limits free tier (ALTO):** Groq/Gemini free tienen RPM/RPD bajos; una sesión Claude Code
   con muchas tool calls los revienta rápido → 429. `rate_limit.py` + cadena de fallback ayudan.
3. **Fidelidad streaming SSE (MEDIO):** si un edge case rompe el stream, la UI cuelga. Su
   `openai_compat.py` lo maneja; hay que validar en vivo.
4. **Python 3.14 (MEDIO):** es bleeding-edge; fijar versión y comprobar que el `uv` de ULTRON
   la soporta, o bajar a 3.12/3.13 (probable que funcione, hay que testear).
5. **Mantenimiento (MEDIO):** vendorizar ~200 KB de Python = deuda de sync. Mitigar: fijar commit
   upstream + documentar origen, no perseguir cada release.
6. **Windows (BAJO):** su wrapper no maneja Windows pero usaremos el launcher de ULTRON, que ya
   resuelve wt.exe/.cmd. El server FastAPI corre bien en Windows con uv.
7. **Auth/seguridad (BAJO-MEDIO):** el proxy escucha en loopback; mantener 127.0.0.1, no exponer.

## Esfuerzo estimado

Mini-proyecto multi-sesión (NO una tarea rápida):
- Port + strip + arrancar el server standalone en Windows: ~1-2 sesiones.
- Wiring ULTRON (sidecar lifecycle + quota passthrough + keys + flag launcher + toggle UI): ~1-2 sesiones.
- Validación end-to-end (streaming, tool_use, 429s) con review visual: ~1 sesión.

## Orden de build sugerido

1. Vendrizar a `~/.ultron/proxy/` (commit fijado), quitar messaging/voz/admin, `uv sync`.
2. Arrancar standalone, probar `MODEL=groq/llama-3.3-70b-versatile` con un Claude Code de prueba
   apuntado a `ANTHROPIC_BASE_URL=localhost:8082` (validar streaming + tool_use en vivo).
3. Wiring del passthrough: leer `quota-state.json`; default = passthrough a Anthropic.
4. Sidecar lifecycle en Tauri + healthcheck.
5. Flag `-FreeTier` en el launcher (subagentes no-Claude) + toggle en Usage (auto-on-quota).
6. Doc de operación + decidir defaults (¿auto-on al 98%? ¿manual?).

## Decisión pendiente para USER

¿Approach A (vendoring sidecar, recomendado)? ¿El auto-switch al 98% automático (best-effort,
depende de la detección heurística de quota) o manual con aviso?

---

## Resultado investigación APIs gratis no-locales (workflow 2026-05-30, 14 providers)

Decisiones de USER aplicadas: switch SOLO al agotar Claude, yendo al modelo MÁS POTENTE;
providers no-locales (sin Ollama/LMStudio/llamacpp).

**Stack recomendado para el proxy (ordenado por la cadena de fallback "ir al más potente"):**
1. **NVIDIA NIM** (build.nvidia.com) — PRIMARIO. Único free no-local con modelo frontier-scale
   REALMENTE usable en loop agentic: DeepSeek V3.2/R1 671B, Nemotron-Super-120B, Kimi K2.5,
   contexto 1M, **sin cap diario de requests** (40 RPM, ampliable a 200), OpenAI-compatible,
   sin tarjeta. → el "más potente" que pediste.
2. **OpenRouter** — SECUNDARIO. Una sola key agrega muchos modelos `:free` (DeepSeek V4 Flash,
   Qwen3 Coder). 20 RPM; 1000 RPD si compras 10 USD una vez. Diversidad de modelos.
3. **Groq** — RÁFAGA. gpt-oss-120b (coding) / kimi-k2 (agentic), latencia LPU altísima, pero
   ~1000 RPD por modelo → se agota rápido en sesiones largas.
4. **Google Gemini 2.5 Flash** — FALLBACK bajo volumen, SOLO tareas NO sensibles (su free tier
   **entrena con tus datos** y Gemini 3.x Pro salió del free en abril 2026).

**Descartados:** GitHub Models (cap 8K input/50 RPD pese a listar GPT-5/Claude4), SambaNova
(~20 req/día), Cerebras (cap contexto 8K — inservible para agentes), Mistral (2 RPM), Fireworks
/ Hyperbolic / Chutes (ya no tienen free real, solo promo one-shot). DeepSeek directo: sin saldo.

**Veredicto:** vale la pena como **red de seguridad gratis cuando se agota Claude, NO como
reemplazo**. Todos OpenAI-compatible → proxy LiteLLM/claude-code-router traduce Anthropic↔OpenAI
sin tocar Claude Code (Z.ai es Anthropic-nativo pero solo en su tier de pago). Calidad agentic
esperable: "buena, no frontier" — esperar fallos de formato JSON en tool-calling de cadenas
largas (sobre todo NVIDIA y modelos open); validar el loop antes de confiar.
