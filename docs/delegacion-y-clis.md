# Delegación en Codex/Antigravity y CLIs instaladas

Movido del CLAUDE.md global el 2026-09-28 para no cargarlo en cada sesión y subagente.

## Delegar en Codex (GPT) y Antigravity (Gemini)

Segunda IA disponible en cualquier proyecto vía el CLI `codex` (suscripción ChatGPT Plus, sin API key). No hay script propio: se invoca el CLI directamente.

- **Astra** (`gpt-6-astra`, nivel Fable; default de `~/.codex/config.toml`): segunda opinión o diagnóstico en lo más complejo. Cuota Plus limitada: delegar, no usar en cada paso.
- **Sol** (`gpt-5.6-sol`, nivel Opus): revisiones serias. **Terra** (`gpt-5.6-terra`): lo básico.
- Desde Claude Code: `/codex:rescue` (delegar investigación o arreglo) y `/codex:review` / `/codex:adversarial-review`, con `--model <id>`; o el agente `codex:codex-rescue`.
- Por shell: `codex exec -m gpt-6-astra -` con el prompt por **stdin** (los prompts largos por argumento revientan en Windows).
- **Antigravity** (`agy`, suscripción Google AI Pro hasta el 2026-12-08; con agy 1.3.5, `agy models` lista 6: `gemini-3.8-flash-high|medium|low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking` y `gpt-oss-120b-medium`; Gemini 3.1 Pro ya no existe y pedirlo falla con «invalid model selection»). Tercera opinión o trabajo en paralelo sin gastar cuota de Claude ni de Codex. Receta verificada 2026-10-14 (desde la raíz del proyecto; binario en `%LOCALAPPDATA%\Microsoft\WinGet\Links\agy.exe` si no está en PATH):
  `agy --model gemini-3.8-flash-high --mode plan --dangerously-skip-permissions --print-timeout 300s -p "<encargo>"`
  - `-p` exige el prompt como argumento (no lee stdin): encargos largos → escribirlos en un fichero del scratchpad y pasar `-p "Lee <ruta> y cumple sus instrucciones"`.
  - En headless, hasta leer un fichero pide el permiso `command`: sin `--dangerously-skip-permissions` devuelve «no output produced». Por eso siempre `--mode plan` (solo lectura/análisis); para que edite, trabajar en una copia o worktree, nunca en el árbol con cambios sin commitear.
  - `--sandbox` se cuelga en Windows (timeout sin salida): no usarlo. Un `503 UNAVAILABLE` es caída transitoria de Google: reintentar una vez.
- **Delegar ejecución, no solo opiniones** (decidido 2026-10-26, cadena del 2026-10-28): las tareas cerradas y mecánicas (renombrados, migraciones, tests, barridos con cambios) las redacta Opus y las ejecuta un motor de la cadena con `scripts/delegate.mjs`, que crea un worktree aislado, lanza el motor en modo escritura, pasa el check y deja el resultado en una rama `delegate/<id>`:
  `node ~/.ultron/scripts/delegate.mjs run --brief <encargo.md> --check "<comando>" [--tier complex|standard|trivial] [--engine auto|<id>] [--scope "<glob>,<glob>"] [--link control-center/node_modules]`
  - Cadena vigente (`delegate.mjs status`): `claude-p → anthropic-api → codex → agy → deepseek → openrouter-free → nvidia → gemini-api → groq → cerebras → opencode-free` (`groq` y `cerebras`, desactivados). **Los tres niveles entran por `claude-p`**: el nivel solo elige el modelo (`complex` Opus 5.5, `standard` Sonnet 5.5, `trivial` Haiku 5.5). **Delegar ahorra contexto, no cuota**: `claude-p` gasta el mismo plan que la sesión, hasta 6 $ por intento, y si falla `anthropic-api` gasta créditos de pago sin tope ni registro de coste.
  - Motores por adaptador (runners `codex`, `agy`, `opencode`, `claude`) en `cockpit/ai-router/delegation.json`, la configuración del usuario (la edita la pestaña AI Router, ignorada por git); si falta o no parsea se usa `cockpit/ai-router/delegation.default.json` (versionado, el mismo que incrusta Rust) y la salida lo dice. Contrato: [`docs/delegacion-contrato.md`](delegacion-contrato.md). `--engine auto` (por defecto) entra por `tiers[tier].start` y hace relevo por la cadena **dando la vuelta**: salta el motor deshabilitado, sin CLI, sin key o sin cuota (≥ 95 % o saldo de DeepSeek agotado) y pasa al siguiente si falla, agota el plazo, no cambia nada, el check sale rojo o un intento lanza una excepción de git. Un `start` que no está en `chain` es error de uso. `--engine <id>` fuerza uno solo (y admite `--model`, validado con `^[A-Za-z0-9._:/@+-]{1,200}$`); `--no-relay` hace un único intento.
  - Seguridad: los motores se lanzan sin shell (array de argumentos; un shim `.cmd` de npm se resuelve a su `.js` o `.exe`) y con el entorno sin ninguna key salvo la suya; el check (`--check`, que escribe Opus) sí va con shell, sin ninguna key. **El disco queda abierto**: un motor sin sandbox (todos salvo Codex) puede leer `.env`, `HKCU\Environment` y las credenciales de otros CLI. En un repo con contenido no confiable, `--engine codex` o no delegar.
  - Encargo exacto (ficheros, qué cambiar, qué no tocar) y check medible: `--check` es obligatorio salvo `--no-check` explícito; `--scope` convierte en check rojo un diff que toque ficheros fuera del alcance.
  - Lanzarlo en segundo plano (`run_in_background`): un motor puede pasar de 10 min. El plazo mata el árbol de procesos entero. Salida: 0 = cambios y check verde; 1 = check rojo sin relevo; 2 = ningún motor completó la tarea (vuelve a Opus); 3 = uso, cuota de un motor forzado (`--force` la salta) o git.
  - `delegate.mjs status [--json]` da la disponibilidad de cada motor. Opus revisa el resumen y, si hace falta, `git diff main...delegate/<id>`; `delegate.mjs merge <id>` exige la rama en el SHA validado, el árbol principal limpio y la base como ancestro de HEAD (en un repo con cambios sin commitear no se puede fusionar: `run` avisa de cuántas entradas deja fuera) y deja preparado el `git merge --squash` sin commit (los hooks corren al hacer el commit); el ledger registra `squash-prepared` y solo pasa a `merged` cuando el commit existe y `delegate.mjs clean <id>` lo descarta (también los worktrees `aN/wt` y las ramas `delegate/<id>*` de una ejecución cortada; con un `meta.json` cuyas rutas o ramas no sean de la delegación aborta sin tocar nada). Cada intento y desenlace va a `cockpit/delegations.jsonl`. `delegate.mjs list` enseña las abiertas.
  - Un worktree nuevo no trae `node_modules` ni `target/`: `--link` crea una junction al del repo (sin instalar dependencias desde el delegado), de solo lectura por contrato.
  - Aislamiento: si el checkout cambia durante el intento (lo normal si la sesión sigue trabajando), queda como `isolation-suspect` y el check cuenta; solo se aborta con `isolation` si hay evidencia de que fue el motor (mismo contenido que su diff, o terminar sin cambios en el worktree) o si cambia la config de git. Un check que modifica lo que valida da `tree-changed`: sus artefactos tienen que estar en `.gitignore`.
- **Delegar sin esperar a que el usuario lo pida** (decidido 2026-09-22): bug que resiste dos intentos → `/codex:rescue --model gpt-6-astra`; cambio grande o sensible antes de cerrarlo → `/codex:adversarial-review`; lectura o análisis amplio (barrer un módulo, contrastar un diseño, resumir docs o papers) → `agy` con `gemini-3.8-flash-high`. Avisar en una línea de que se delega.

---

## Herramientas CLI instaladas (usar sin que el usuario lo pida)

- `markitdown "<fichero>"` — PDF/DOCX/PPTX/XLSX/HTML/EPUB → markdown por stdout. Para leer documentos, apuntes y papers del TFG en vez de pelearse con el binario.
- `mmdc -i diagrama.mmd -o diagrama.png` — Mermaid → PNG/SVG. Cuando un diagrama ayude a explicar algo, generarlo y abrir el PNG (o publicarlo como Artifact) en vez de describirlo en texto.
- `rumdl check <f.md>` / `rumdl fmt <f.md>` — lint y formato de markdown (docs, README, notas del vault de Obsidian).
- `glow <f.md>` — ver markdown formateado en la terminal (para el usuario; en el chat no hace falta).
- El usuario no puede ver imágenes dentro del chat: lo visual (diagramas, gráficas, informes) se le enseña abriéndolo (`start <png>`) o publicándolo como Artifact privado de claude.ai con su enlace.

---

