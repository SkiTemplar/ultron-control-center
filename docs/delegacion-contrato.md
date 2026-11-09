# Contrato del delegador multi-motor

Contrato compartido entre `scripts/delegate.mjs` (Node), el backend del AI Router (Rust,
`control-center/src-tauri/src/ai_router/delegation*.rs`) y la pestaña AI Router → Delegación
(React). Cualquier cambio de este contrato se refleja aquí antes de tocar código. Uso diario:
[`docs/delegacion-y-clis.md`](delegacion-y-clis.md).

## Semántica

- Opus (la sesión principal) redacta un encargo cerrado; un motor de la cadena lo ejecuta en
  un worktree git aislado y deja el resultado en la rama `delegate/<id>`.
- **Nivel + relevo**: los tres niveles (`--tier complex|standard|trivial`) entran hoy por el
  mismo motor (`tiers[tier].start` = `claude-p`, decisión del 2026-10-28), así que el nivel **ya
  no elige motor, solo el modelo** de cada uno (`tierModels`): en `claude-p`, Opus 5.5, Sonnet
  5.5 y Haiku 5.5. Si el motor no está disponible, falla, agota el plazo, no cambia nada, el check
  sale rojo (con `relayOnCheckFail`) o el intento lanza una excepción de git, se pasa al siguiente
  de `chain` y, al llegar al final, **se da la vuelta** hasta probar todos.
- **Coste real**: `claude-p` gasta **la misma cuota del plan que la sesión principal**
  (`claude -p --safe-mode` conserva el login OAuth), con el tope por intento de `maxBudgetUsd`, y
  `status` no da dato de su cuota. `anthropic-api`, el segundo, gasta **créditos de pago**
  (`ULTRON_KEY_ANTHROPIC_CREDITS`) sin tope ni coste en el ledger. Codex y agy gastan su
  suscripción; `deepseek`, su saldo; `openrouter-free`, `nvidia`, `gemini-api` y `opencode-free`,
  niveles gratuitos de terceros.
- `--engine <id>` fuerza un único motor; `--no-relay` hace un único intento real.
- **Base**: el worktree parte de un commit (`HEAD` o `--base`), así que lo no commiteado del
  checkout se queda fuera y el check prueba el código sin ello. `run` lo avisa (`base: … · AVISO:
  N entrada(s) sin commitear…`) y lo guarda en `meta.json` (`baseSha`, `dirtyAtStart`).
- **Aislamiento**: el worktree solo es una frontera real con Codex (`-s workspace-write`); agy
  (`--dangerously-skip-permissions`) y OpenCode (`--auto`) corren sin sandbox y pueden escribir
  con rutas absolutas fuera del worktree. El delegador toma una huella de `git status --porcelain
  --untracked-files=all` del checkout principal (estado, tamaño y mtime de cada entrada) antes
  del motor, después del motor y después del check. Que cambie no prueba nada, porque la sesión
  sigue trabajando mientras el motor corre, y por eso se distingue:
  - **Ruptura** (`engine-fail`, `reason: "isolation"`, `AISLAMIENTO ROTO: …`, relevo cortado,
    exit 2, lista en `attempts[].isolation`): una entrada cambiada tiene en el checkout el mismo
    contenido que en el diff del worktree, o un motor sin sandbox termina bien sin cambios en el
    worktree mientras el checkout cambia. También, siempre, si cambia la config de git
    (`.git/config`, `config.worktree`, `.git/hooks/**`, `info/attributes` o el fichero `.git` del
    worktree): entonces no se lanza ningún `git add` más, no hay commit y el worktree se conserva.
  - **Sospecha** (`reason: "isolation-suspect"` si no hay otro motivo, `isolationSuspect: N` en el
    ledger, `AISLAMIENTO SOSPECHOSO: …`, lista en `attempts[].suspect`): cualquier otro cambio. No
    se puede atribuir al motor: el check cuenta, el relevo sigue y `merge` lo recuerda.

  **No se revierte nada.** Límites: lo ignorado por git (`node_modules`, `target`) no sale en la
  huella, y un motor sin sandbox que escriba en un fichero ajeno al diff queda solo como sospecha.
- **Validación**: lo que se commitea es lo que se validó. El árbol sale del índice (`write-tree`)
  antes del check; si el check cambia el worktree (salvo lo ignorado) o el índice, el verde no
  vale: `check-fail` con `reason: "tree-changed"`, sin relevo porque el defecto suele ser del
  check. El commit se hace con `commit-tree` de ese árbol sobre la base, sin hooks. Su SHA va a
  `meta.json` (`attempts[].sha` y `validatedSha` del ganador) y `merge` exige que la rama siga ahí.
  Quien escriba `meta.json` puede falsear ese dato: un motor sin sandbox ya no corre cuando se
  lee, pero el fichero no es una firma.
- **`--link` es de solo lectura por contrato**: la junction apunta al directorio real del repo
  y un motor que escriba a través de ella cambia el repo principal. Si la ruta enlazada está
  versionada, la huella lo detecta; si está ignorada (`node_modules`, `target`), no. Solo se
  enlazan dependencias o artefactos que el encargo lee; nunca algo que deba modificar.
- **Procesos**: el plazo y el vigilante matan el árbol del motor (`taskkill /T /F` en Windows,
  grupo de procesos en POSIX). Además, en Windows, cuando el motor o el check salen, sus
  descendientes que sigan vivos (servidores de agy u OpenCode que retendrían el worktree) se
  matan con `taskkill /T /F /PID`: se localizan por PPID en la tabla de procesos (`Win32_Process`)
  y por hora de creación, para no tocar un PID reutilizado. La tabla tiene un plazo de 15 s, cada
  `taskkill` de 10 s y la recogida entera de 30 s; agotarlos se avisa y no retiene la delegación.
- Salida: `0` = un intento con cambios y check verde; `1` = check rojo sin relevo posterior;
  `2` = ningún motor completó la tarea (vuelve a Opus); `3` = error de uso, cuota de un motor
  forzado (`--force` la salta), configuración inválida o git antes de empezar.

## 1. Configuración

Dos ficheros, misma forma:

- `cockpit/ai-router/delegation.default.json`: valor por defecto **versionado**. Lo incrusta
  el backend de Rust (`include_str!`) y lo lee `delegate.mjs`; no hay otra copia en código.
- `cockpit/ai-router/delegation.json`: configuración del usuario (la guarda la pestaña AI
  Router; **ignorada por git**). Si falta, no parsea o no tiene la forma mínima, se usa la
  default y la salida lo dice (`configSource: "default"` y la nota). Una default rota es un
  error de uso (exit 3).

```json
{
  "version": 1,
  "chain": ["claude-p", "anthropic-api", "codex", "agy", "deepseek", "openrouter-free", "nvidia",
            "gemini-api", "groq", "cerebras", "opencode-free"],
  "tiers": {
    "complex":  { "start": "claude-p" },
    "standard": { "start": "claude-p" },
    "trivial":  { "start": "claude-p" }
  },
  "relayOnCheckFail": true,
  "engines": {
    "claude-p": { "runner": "claude", "model": "claude-sonnet-5-5",
                  "tierModels": { "complex": "claude-opus-5-5", "trivial": "claude-haiku-5-5" },
                  "maxBudgetUsd": 6, "enabled": true },
    "anthropic-api": { "runner": "opencode", "model": "anthropic/claude-sonnet-5-5",
                  "tierModels": { "trivial": "anthropic/claude-haiku-5-5" },
                  "keyEnv": "ULTRON_KEY_ANTHROPIC_CREDITS",
                  "envMap": { "ANTHROPIC_API_KEY": "ULTRON_KEY_ANTHROPIC_CREDITS" }, "enabled": true },
    "codex":    { "runner": "codex", "model": "gpt-6.1-terra",
                  "tierModels": { "complex": "gpt-6.1-sol" }, "enabled": true },
    "agy":      { "runner": "agy", "model": "gemini-3.8-flash-high", "enabled": true },
    "deepseek": { "runner": "opencode", "model": "deepseek/deepseek-flash",
                  "tierModels": { "complex": "deepseek/deepseek-v4-pro" },
                  "keyEnv": "DEEPSEEK_API_KEY", "enabled": true },
    "nvidia":   { "runner": "opencode", "model": "nvidia/minimaxai/minimax-m3.1-flash",
                  "keyEnv": "NVIDIA_NIM_API_KEY",
                  "envMap": { "NVIDIA_API_KEY": "NVIDIA_NIM_API_KEY" }, "enabled": true },
    "opencode-free": { "runner": "opencode", "model": "opencode/deepseek-v4.1-flash-free", "enabled": true }
  }
}
```

(Extracto: la lista completa de motores está en `delegation.default.json`.)

- `chain`: orden del relevo. Un id de `chain` que no está en `engines`, tiene
  `enabled: false` o un runner desconocido se salta con motivo `disabled`.
- `tiers.<tier>.start`: motor de entrada del nivel; **tiene que estar en `chain`** (si no,
  exit 3 con el motivo; antes arrancaba en `chain[0]` sin avisar). Sin `tiers.<tier>`, la
  cadena empieza en `chain[0]`.
- `runner` ∈ `codex | agy | opencode | claude`.
- `model` (obligatorio) y `tierModels` (opcional, por nivel): en el formato que espera el
  runner (OpenCode: `proveedor/modelo`). Lista blanca `^[A-Za-z0-9._:/@+-]{1,200}$`: un
  modelo que no la cumpla deja el motor `disabled` y `--model` lo rechaza con exit 3.
  Modelo efectivo: `--model` > `tierModels[tier]` > `model`.
- `keyEnv` (opcional): variable con la key; si está vacía (ni en el entorno ni en
  `HKCU\Environment`), el motor se salta con `missing-key`. `envMap` (opcional):
  `{ "VARIABLE_QUE_ESPERA_EL_CLI": "VARIABLE_DE_USUARIO" }`.
- `maxBudgetUsd` (opcional, solo runner `claude`).
- Keys personalizadas: variables de usuario `ULTRON_KEY_<SLUG>` con
  `^ULTRON_KEY_[A-Z0-9_]{2,40}$`.

### Lanzamiento de los motores

Sin shell: `spawn(fichero, [argumentos])`. En Windows, un `.exe` se lanza tal cual y un shim
`.cmd` de npm se resuelve a su destino (`.js` con el node actual o `.exe`); un `.cmd` que no
se reconoce cuenta como `not-installed`. El check (`--check`, lo escribe Opus) sí va con shell.

| Runner | Argumentos | Prompt |
|---|---|---|
| `codex` | `exec [-c windows.sandbox='unelevated'] -C <wt> -s workspace-write -m <modelo> --color never -o <last.md> -` | stdin |
| `agy` | `--model <modelo> --mode accept-edits --dangerously-skip-permissions --print-timeout 0s -p <instrucción de leer .delegate-brief.md>` | fichero en el worktree |
| `opencode` | `run --pure --auto --print-logs --log-level ERROR --title <id> -m <modelo> --dir <wt> <instrucción>` | fichero en el worktree |
| `claude` | `-p --safe-mode --model <modelo> --permission-mode acceptEdits --output-format json --no-session-persistence --max-turns 80 [--max-budget-usd N]` | stdin |

- `claude -p --safe-mode` conserva el login OAuth y desactiva hooks, CLAUDE.md, MCP y plugins;
  su JSON trae `result`, `total_cost_usd` (va al ledger como `costUsd`), `is_error`,
  `subtype` y `api_error_status`.
- OpenCode se queda colgado cuando el proveedor falla: el vigilante lo mata al ver en
  **stderr** una línea de log `level=ERROR` del modelo principal (`small=false`) con
  `message="stream error"` o `AI_RetryError`. Nunca por `small=true` (título o resumen con el
  modelo pequeño) ni por texto de stdout. Cada tubería tiene su propio buffer de línea.

### Entorno

Cada motor recibe el entorno del proceso **sin ninguna variable secreta** (todo `keyEnv` y
todo nombre de `envMap` de la configuración, más `*_API_KEY`, `*_TOKEN`, `*_PAT`, `*_SECRET*`,
`*_PASSWORD*`, `AWS_*`, `ULTRON_KEY_*` y las keys de la app) y, encima, solo su `keyEnv` y su
`envMap`, más `DELEGATE_ENGINE`, `DELEGATE_RUNNER` y `DELEGATE_MODEL`. El check recibe el entorno
sin ninguna key. El `git` del delegador recibe una lista blanca de variables (ni keys ni `GIT_DIR`,
`GIT_CONFIG_*` y similares) y `-c core.fsmonitor=`.

**Esto protege el entorno, no el disco.** Un motor sin sandbox (agy, OpenCode, y `claude -p` con
lo que le permita `acceptEdits`) corre con los permisos del usuario y **puede leer** `~/.ultron/.env`,
`HKCU\Environment`, `~/.codex/auth.json`, `mascot-bridge.json` y cualquier otro fichero, y puede
enviarlo a la red. La huella no ve lecturas ni lo que cae fuera del repo. Quien delegue en un
repo con contenido no confiable (inyección de prompt) debe forzar `--engine codex` o no delegar.

## 2. Ledger `cockpit/delegations.jsonl` (ignorado por git, append-only)

Una línea por intento (incluidos los saltados) y una por desenlace:

```json
{"ts":"ISO","id":"<id>","attempt":1,"engine":"agy","runner":"agy","model":"…",
 "tier":"standard","outcome":"ok|check-fail|engine-fail|no-changes|timeout|skipped",
 "skipReason":"quota|missing-key|disabled|not-installed|null","durationS":42,
 "checkOk":true,"filesChanged":3,"costUsd":0.0015,"branch":"delegate/<id>",
 "title":"…","repo":"<nombre>",
 "reason":"scope|check|tree-changed|exit N|quota|auth|stream-error|timeout|isolation|isolation-suspect|git: …|null",
 "isolationSuspect":0}
{"ts":"ISO","id":"<id>","stage":"squash-prepared","branch":"delegate/<id>","head":"<sha>","sha":"<commit validado>"}
{"ts":"ISO","id":"<id>","final":"merged|discarded"}
```

- `repo` es el nombre de la carpeta, nunca la ruta absoluta (repo público).
- `stage` es un paso sin desenlace: no lleva `engine` ni `final`, así que los lectores del
  ledger (pestaña Delegación y uso por motor) la ignoran. `merge` escribe `squash-prepared`
  (rama y `HEAD` de ese momento); `final: "merged"` solo se escribe cuando el contenido de la
  rama ya está en un commit posterior a ese `HEAD`. Lo comprueban `merge`, `list`, `clean` y `gc`;
  hasta que alguno corra tras el commit, la delegación sale como pendiente.
- `reason`: motivo del desenlace del intento. Una excepción dentro del intento (git) es
  `engine-fail` con `reason` `git: …` (rutas del repo sustituidas por `<repo>`) y el relevo sigue.

## 3. `node scripts/delegate.mjs status --json`

Fuente única de la disponibilidad de los motores (la consumen Opus y la app):

```json
{"chain":["codex",…],"engines":[{"id":"codex","runner":"codex","model":"…","enabled":true,
 "installed":true,"keyPresent":null,"quota":{"usedPct":12,"window":"weekly"},
 "balance":{"currency":"USD","total":"0.00","available":false},
 "available":true,"reason":null}],"configSource":"file|default"}
```

`quota` y `balance` pueden ser `null` (sin dato). Motivos (`reason`), por orden: `disabled`,
`not-installed`, `missing-key`, `quota` (ventana ≥ 95 % o saldo de DeepSeek no disponible).

## 4. Delegaciones en disco y limpieza

- Directorio: `.tmp/delegations/<id>/` con `meta.json`, `result.json`, `aN/wt` (worktree de
  cada intento), `aN/engine.log` y `aN/check.log`. `meta.json` se reescribe tras cada intento.
- Id: `<nivel o motor>-AAAAMMDD-HHMM-<4 hex>`; `clean` y `merge` solo aceptan ids con
  `^[A-Za-z0-9_-]+-\d{8}-\d{4}-[0-9a-f]{4}$`.
- Ramas: `delegate/<id>` (primer intento real) y `delegate/<id>-aN`.
- `clean <id>` valida `meta.json` (worktrees bajo el directorio de la delegación, ramas
  `delegate/<id>[-aN]`, `links` relativos sin `..`) y aborta sin tocar nada si no cumple.
  Borra también los `aN/wt` y las ramas `delegate/<id>*` que no estén en `meta.json` (ejecución
  cortada) y termina con `git worktree prune`. Con un squash preparado y sin commit se niega
  (exit 3); con el commit ya hecho registra `merged` en vez de `discarded`.
- `merge <id> [--branch <rama>]` exige que la rama siga en el SHA registrado (`validatedSha`, o
  `attempts[].sha` con `--branch`; una delegación sin él no se fusiona), el checkout principal sin
  cambios en ficheros versionados (se mezclarían con el squash en el mismo commit) y que la base
  (`<sha>~1`: cada intento es un único commit sobre la base) sea ancestro de `HEAD`; si no, exit 3
  sin tocar nada. Deja el `git merge --squash` sin commit (los hooks corren al hacerlo) y registra el paso
  `squash-prepared` (§2). Estados del squash: `committed` (pasa a `merged`), `pending` (en el
  índice; `merge` y `clean` se niegan) y `undone` (reset o checkout; se puede repetir `merge`).
- `gc [--days N] [--dry-run]` aplica `clean` a las delegaciones terminadas hace más de N días
  (2 por defecto) que ya no guardan trabajo: fusionadas, descartadas o sin ninguna rama. Las que
  conservan una rama (verde o para revisar) sin desenlace no se tocan y se listan. Las ramas se
  comprueban en el repo: `list` marca `rama desaparecida (…)` si `meta.json` nombra una que ya no
  existe. `run` lo lanza al empezar, en silencio salvo que borre algo; un fallo del `gc` previo
  avisa y no impide la delegación.

## 5. Comandos Tauri

| Comando | Entrada | Salida |
|---|---|---|
| `ai_router_get_delegation` | — | `DelegationConfig` (§1; la del usuario o la default) |
| `ai_router_set_delegation` | `config: DelegationConfig` | `()`; valida ids, runners y tiers; escritura atómica en `delegation.json` |
| `ai_router_delegation_status` | — | el JSON de §3 (lanza `node scripts/delegate.mjs status --json`) |
| `ai_router_delegation_ledger` | `limit: u32` | `Vec<LedgerEntry>`, más recientes primero |
| `ai_router_discover_models` | `provider_id: String` | `Vec<String>` (GET `{base_url}/models` con la key) |
| `ai_router_upsert_custom_provider` | `provider: CustomProviderInput {id,name,base_url,api_format,key_env_var,default_model?}` | `Provider` |
| `ai_router_remove_custom_provider` | `provider_id: String` | `()`; solo proveedores con `custom: true` |
