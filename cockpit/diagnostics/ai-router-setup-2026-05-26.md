# AI Router setup — 2026-05-26

Backend Rust del AI Router implementado. La UI (`src/components/AIRouter/`) ya
deja de caer a `DEFAULT_ZONES`: ahora los siete commands Tauri devuelven
datos reales desde `~/.ultron/cockpit/ai-router/`.

---

## Archivos involucrados

- `src-tauri/src/ai_router.rs` — modulo unico con tipos, storage, wrappers
  por proveedor y los siete `#[tauri::command]`. ~720 lineas.
- `src-tauri/src/lib.rs` — wire de `mod ai_router;` y siete entradas mas
  en `generate_handler!`.
- `src-tauri/Cargo.toml` — `reqwest` ahora con feature `blocking`
  (los wrappers HTTP usan `reqwest::blocking::Client`).
- `~/.ultron/cockpit/ai-router/providers.json` — seed con 6 providers.
- `~/.ultron/cockpit/ai-router/zones.json` — seed con 7 zones.
- `~/.ultron/cockpit/ai-router/metrics.json` — se crea solo en primer uso
  (`ai_router_metrics` lo siembra a `default()`).

`cargo check` limpio (un warning preexistente de `CmdResult` no relacionado
con este sprint).

---

## Providers gratuitos / baratos — como obtener cada API key

Cada provider de la nube usa una variable de entorno. Si la variable no
existe el badge "API Key" aparece como "Missing" y los tests devuelven
`missing <ENV_VAR> env var — configure the API key in your environment`.

### 1. Anthropic (`ANTHROPIC_API_KEY`)
- Cuenta: https://console.anthropic.com
- Crear API key en Settings > API keys > Create Key.
- Free tier: 50 req/min en modelos Haiku con cuenta nueva.
- Set en PowerShell:
  ```
  [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
  ```

### 2. OpenAI / Codex (`OPENAI_API_KEY`)
- Cuenta: https://platform.openai.com
- Crear key en https://platform.openai.com/api-keys
- No hay free tier real desde 2024; minimo $5 prepago.
- Alternativa gratuita para code-edit: dejar este provider en "missing"
  y la zone `code-edit` cae al fallback `deepseek` (coste casi nulo).

### 3. Google Gemini (`GEMINI_API_KEY`) — RECOMENDADO
- Cuenta: https://aistudio.google.com
- Crear key en https://aistudio.google.com/app/apikey
- Free tier: 1000 requests/dia en `gemini-2.5-flash`, mas que suficiente
  para web-research + summarize.
- Set en PowerShell:
  ```
  [Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "AIza...", "User")
  ```

### 4. Groq (`GROQ_API_KEY`) — RECOMENDADO
- Cuenta: https://console.groq.com
- Crear key en API Keys.
- Free tier generoso: 30 req/min en `llama-3.3-70b-versatile`, latencia
  brutalmente baja (200-400 ms p50).
- Set:
  ```
  [Environment]::SetEnvironmentVariable("GROQ_API_KEY", "gsk_...", "User")
  ```

### 5. Ollama (sin API key) — RECOMENDADO offline
- Instalar: https://ollama.com/download/OllamaSetup.exe
- Lanzar `ollama serve` (o el icono de la bandeja). Por defecto escucha
  en `http://localhost:11434`.
- Modelos sugeridos:
  ```
  ollama pull qwen2.5-coder:7b      # 4 GB, rapido
  ollama pull qwen2.5-coder:32b     # 19 GB, mejor calidad
  ollama pull deepseek-coder-v2:16b # 9 GB, balance
  ```
- El probe del Router pega a `/api/tags`. Si Ollama no esta corriendo el
  test devuelve "Ollama is not running. Start it with `ollama serve` or
  install it from https://ollama.com/."

### 6. DeepSeek (`DEEPSEEK_API_KEY`)
- Cuenta: https://platform.deepseek.com
- Coste casi nulo ($0.14 / Mtok output). Util como fallback de Codex
  cuando OpenAI no esta configurado o falla.
- Set:
  ```
  [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")
  ```

> Tras `setx` o `SetEnvironmentVariable` con scope `User`, cierra y vuelve
> a abrir cualquier proceso que necesite ver la variable (incluido el
> Control Center).

---

## Verificar cada provider

Hay tres niveles de validacion:

### A. Status de la API key (pasivo, sin red)
- Abre el Control Center > AI Router > Providers.
- El badge "API Key" debe ser:
  - `Configured` si la env var existe y no parece placeholder.
  - `Placeholder` si contiene `your-key`, `replace`, empieza por `xxx`,
    o vale exactamente `sk-...`.
  - `Missing` en cualquier otro caso (incluyendo cadena vacia).
- Ollama siempre aparece como `Configured` (no requiere key).

### B. Health check (probe HTTP, sin tokens)
- En la tabla de Providers, columna "Health". Verde = el endpoint
  contesto algo < 500 en < 10s. Rojo = timeout o 5xx.
- El probe se re-evalua cada 30 s y los resultados se cachean.
- Endpoint usado por provider:
  - claude-haiku -> `GET https://api.anthropic.com/v1/models`
  - codex -> `GET https://api.openai.com/v1/models`
  - gemini -> `GET https://generativelanguage.googleapis.com/v1beta/models?key=...`
  - groq -> `GET https://api.groq.com/openai/v1/models`
  - ollama -> `GET http://localhost:11434/api/tags`
  - deepseek -> `GET https://api.deepseek.com/models`

### C. End-to-end test (gasta tokens reales)
- Abre AI Router > Zones, click en cualquier zone, click "Test".
- El prompt por defecto es `Respond with a single word: OK`.
- El backend hace la llamada real al provider primary de esa zone y
  devuelve `{ ok, latency_ms, response_excerpt, error? }`.
- Si la key falta -> `missing <ENV_VAR> env var`.
- Si el modelo no existe en el provider -> texto de error tal cual lo
  manda el upstream (truncado a 200 chars).

---

## Cambiar zones desde la UI

1. AI Router > Zones.
2. Filtrar por categoria (`chat`, `code`, `research`, `system`).
3. Click "Edit" en la card de una zone.
4. Cambiar provider primary, modelo y `max_tokens` (0 = default del provider).
5. Anadir hasta 3 fallbacks con + Add fallback. Reordenar con las flechas.
6. "Test" para validar antes de guardar.
7. "Save zone" persiste en `~/.ultron/cockpit/ai-router/zones.json`.

El backend hace escritura atomica (tmp + rename). Si pierdes el archivo,
basta con borrarlo: `ai_router_list_zones` reseed con los 7 zones
default la proxima vez.

---

## Defaults sembrados (zones + provider mapping)

| Zone               | Task class | Primary           | Fallback              |
|--------------------|------------|-------------------|-----------------------|
| chat               | light      | claude-haiku      | groq llama-3.3        |
| code-edit          | medium     | codex gpt-5       | deepseek-coder        |
| code-review        | light      | claude-haiku      | -                     |
| research-web       | medium     | gemini-2.5-flash  | claude-haiku          |
| summarize          | trivial    | groq llama-3.3    | gemini-2.5-flash      |
| routing-decision   | trivial    | claude-haiku      | groq llama-3.3        |
| code-fast-local    | light      | ollama qwen2.5    | -                     |

Filosofia: las zonas "calientes" (chat, code-review, routing-decision)
caen en Haiku que es barato y rapido. Las "investigativas" (research-web)
caen en Gemini Flash (gratis hasta 1000/dia). El offline (code-fast-local)
no toca la red. Codex queda reservado para edits multi-fichero donde su
context window grande es decisiva.

---

## TODO conocidos (fuera del scope del sprint)

- Metrics solo persiste el shape vacio. Falta cablear cada llamada de
  `test_zone` (y futuras llamadas reales del router) para incrementar
  `count`, `tokens` y refrescar `latency_p95_ms` por clase. La UI ya
  consume el shape y los placeholders se renderizan.
- Fallback automatico (si primary falla, probar el siguiente). Hoy
  `test_zone` solo prueba primary; la cadena `fallbacks` es solo UI/datos.
- LiteLLM sidecar: NO se uso. Wrappers directos en Rust + `reqwest` son
  suficientes para los 6 providers y evitan dependencia Python.
