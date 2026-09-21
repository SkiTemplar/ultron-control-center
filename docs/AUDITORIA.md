# Auditoría funcional de mar.ia — 2026-09-21

Rama: `maria-core` (parte de `maria`, el fork de ULTRON Control Center).

Criterio único con el que se ha juzgado cada pieza:

> mar.ia es un asistente para quien trabaja con varias IA a la vez. Algo se
> queda si sirve para **hablar con los modelos**, para **darles memoria y
> contexto**, para **gobernar el ecosistema de Claude Code** (skills, agentes,
> MCPs, hooks, sesiones) o para **ver coste, consumo y salud**. Si no sirve a
> nada de eso, o nadie lo usa, o no está cableado, se va.

Todo lo que se afirma aquí está medido sobre el código o sobre la instalación
real (`~/.maria`), no estimado. Nada se ha perdido: la rama `maria` conserva el
estado anterior completo.

## Resultado en números

| | Antes (`maria`) | Después (`maria-core`) |
|---|---|---|
| Ficheros versionados | 1.241 | 1.139 |
| Líneas borradas / añadidas | — | −30.839 / +808 |
| Rust | 90.427 líneas | 78.979 |
| TypeScript + TSX | 63.401 | 54.655 |
| Comandos Tauri registrados | 320 | 248 |
| Comandos sin llamador en la interfaz | 45 | 0 |
| Comandos definidos y nunca registrados | 31 | 0 |
| Pestañas en la barra lateral | 18 (5 plegadas en «Más») | 13, sin grupo plegable |
| Prompts editables en Ajustes | 35 (23 sin botón) | 12 |
| Órdenes de PowerShell que podía lanzar la ventana web | 23 | 0 |

Verificación tras los cambios: `tsc` 0 errores, `cargo check --all-targets`
0 avisos, `cargo fmt` limpio, **vitest 151/151**, **cargo test 919/920**. El
único fallo (`serve::lockfile::…carrera_de_hilos…`, «Acceso denegado») es un
test de carrera sobre un fichero que ya existía, no se ha tocado y pasa 5 de 5
veces ejecutado solo: es intermitente bajo carga en Windows y conviene
arreglarlo, pero no lo introduce esta rama.

## Lo que se ha retirado, y por qué

### Pestañas y funciones enteras

| Qué | Evidencia | Veredicto |
|---|---|---|
| **Finanzas** | `finance.rs` y `Finance.tsx` nunca existieron en este fork (son privados del repo de origen). `cargo check --features finance` fallaba con 31 errores. | Código muerto: 15 comandos registrados tras un `cfg` que aquí no puede compilar. |
| **Laboratorio TFG** (detector de texto escrito por IA) | Es investigación de un TFG, no una función del asistente. Arrastraba un gemelo Rust/JS que había que mantener en paridad, scripts de banco, fixtures y un paso de CI. | Fuera la cadena completa: pestaña, `tfg_lab`, `tfg_heuristics`, hook `ai-text-warn`, libs, scripts, `docs/research`, CI. |
| **Buscador de papers** (`maria_papers.rs`, 501 líneas) | Un comando registrado, **cero llamadores**: ni interfaz, ni chat, ni voz. Incumplía la norma de la casa («nada sin cablear»). | Fuera. El MCP de investigación de los hooks (`research-mcp.js`) hace lo mismo mejor y sí está conectado. |
| **Notas** | `~/.maria/cockpit/notes/` no existe: nunca se escribió una nota. | Cualquier editor lo hace mejor. |
| **Planes** | Desactivado en `features.json`, carpeta `plans/` vacía, sin entrada en la barra lateral. | Fuera, con sus 7 comandos. |
| **Panel** (Dashboard) | La pantalla de inicio es el orbe; sus seis tarjetas repetían datos que ya están en Memoria, Proyectos y Ajustes → Copias, y una dependía de Notas. | Fuera. La tarjeta genérica `Card` se conserva en `components/ui/`. |
| **Novedades** | Leía el `CHANGELOG.md` de ULTRON (59 KB de historia ajena al fork) y la app lo releía **cada 15 segundos** aunque nadie abriera la pestaña. | Fuera, con el sondeo. |
| **Aprender** | Documentación estática compilada dentro del binario. | La documentación vive en `docs/`. |
| **Apps instaladas** (Sistema) | Inventario con winget + desinstalador + clasificación por IA. | Windows ya lo hace; no es trabajo de un asistente. La voz sigue abriendo programas por nombre (`Start-Process`), que es lo único que usaba. |
| **Apagado programado** | Un envoltorio de `shutdown /s /t`. | Fuera. |
| **Bienvenida** (Onboarding) | Glosario en inglés que explica «qué es ULTRON». | No procede en una herramienta para expertos ni describe este producto. |
| **Comprobador de actualizaciones** | Consultaba las releases de `SkiTemplar/ultron`, repo **privado**: desde un fork siempre responde 404, o sea, «no hay novedades» para siempre. Los plugins `updater` y `process` de Tauri estaban instalados, inactivos y sin un solo uso. | Fuera ambos plugins, el módulo y el banner. |
| **Proxy free-tier** | Gestionaba `ultron-proxy.exe`, binario que **este repositorio no construye** ni trae. Sin interruptor en la interfaz, desactivado en el estado guardado. | No podía funcionar. Fuera, también del lanzador de sesiones. |
| **Plantilla OpenGL** (modal propio) | Segundo camino para algo que el asistente «Nuevo proyecto» ya ofrece como plantilla. | Fuera el modal y su comando; la plantilla sigue disponible en el asistente. |

### Código que existía y no hacía nada

- **72 comandos Tauri.** 31 estaban escritos y nunca registrados; 13
  registrados sin que nadie los invocara; el resto caía con las pestañas
  retiradas. Como viven en módulos `pub`, el compilador no avisaba.
- **Workflow runs.** Base de datos SQLite, cargador de YAML y un panel en
  Sesiones. Los comandos que *escribían* ejecuciones no tenían llamador: la
  tabla tiene 0 filas y no hay ningún workflow definido. Un panel que no puede
  dejar de estar vacío es exactamente el «no-op silencioso» que prohíbe la
  norma 11 del proyecto.
- **API de Ollama sin pantalla.** 7 comandos (estado, activar, benchmark,
  pull…) cuya sección se quitó de la interfaz hace tiempo. Se conserva
  `ollama::toggle`, que es lo que usa el modelo local.
- **Vigilante de costes** e **instalador por IA**: solo los alcanzaban comandos
  sin registrar.
- **`AIRouter/types.ts`**: catálogo de zonas y proveedores que nadie importaba,
  con identificadores de modelo caducados.
- **23 «button prompts»** de Planes, Panel, Finanzas, etc.: aparecían en Ajustes
  como editables y no gobernaban ningún botón.
- Ficheros de frontend que nada importaba: `DelegationForm`, `renderBody`,
  `todos`, `versions`.
- Dependencias sin uso: crates `zip` y `mockall`.

### Seguridad

`capabilities/default.json` concedía a la **ventana web** permiso para lanzar
23 órdenes de PowerShell (`shell:allow-execute`). La interfaz no usa la API de
shell de Tauri en ningún sitio: todos los procesos los lanza Rust, que no pasa
por esa lista. Era superficie de ataque a cambio de nada —un XSS en la ventana
habría podido ejecutar scripts del sistema— y se ha eliminado entera.

**Qdrant abierto a la red.** La app lanzaba `qdrant.exe` sin configuración y
Qdrant, por defecto, escucha en `0.0.0.0:6333` sin clave: toda la memoria era
legible desde cualquier equipo de la red local (visto en el arranque de prueba:
`listening on: 0.0.0.0:6333`). Ahora los cuatro lanzadores (Rust, PowerShell,
VBS y sh) fijan `QDRANT__SERVICE__HOST=127.0.0.1`, respetando la variable si el
usuario ya la tenía puesta. Una instancia ya en marcha no cambia hasta que se
reinicie.

### Fuera de la app

- Scripts que sus propios autores encabezan con *«maintainer-only, no runtime
  caller»*: `shared-duet.ps1`, `persona-benchmark-runner.py`,
  `skill-discovery.py`, `delete-orphan-releases.ps1`, `routing-test-runner.py`.
- `new-web.mjs` / `deploy-variants.mjs` (pipeline de webs en Vercel, ajeno al
  producto), `tools/home-reorg` (reorganizador de carpetas de un solo uso),
  `batches/*.py` de ejemplo, `docs/web` (web de marketing de ULTRON) y
  `gaming-enum.ps1` (resto de una función retirada en la v2.1).

## Reestructuración

- **Barra lateral** en tres bloques con nombre de lo que son —*Asistente*,
  *Cerebro*, *Trabajo*— más Avisos y Ajustes al pie. Desaparece el grupo «Más»:
  esconder no es decidir.
- **Backend**: los 19 ficheros sueltos `maria_*.rs` en la raíz de `src/` pasan
  a `src/maria/<nombre>.rs`. Un prefijo repetido 19 veces es un módulo pidiendo
  existir. Solo cambian rutas; ningún comando cambia de nombre.
- **Sistema** queda en dos sub-pestañas: diagnóstico y tareas programadas.
- **README** reescrito: el del fork seguía describiendo ULTRON y no mencionaba
  el orbe, el relevo, la voz, las terminales ni la webapp móvil.

## Lo que se queda y merece la pena

- **Memoria gobernada** (`memory/`, 18 mil líneas, sidecar `ultron-memory`): es
  la pieza de ingeniería más sólida del sistema. Escritor único, inbox con
  aprobación humana, redacción de secretos, recall híbrido con RRF, daemon que
  suelta los modelos por inactividad. No se ha tocado más que para quitarle la
  dependencia de los workflow runs.
- **Relevo de proveedores** (`maria/relay.rs`): un solo hilo que pasa de
  `claude` a `codex`, `antigravity` o el modelo local según cuota. Es la idea
  que diferencia a mar.ia y funciona con suscripciones, sin claves de API.
- **Voz**, **terminales embebidas**, **mosaico**, **`//maria`** global y la
  **webapp móvil**: coherentes con el producto y cableados de punta a punta.
- **Proyectos** (tablero, git, CLAUDE.md, lanzador de sesiones, cola *Run
  Batch*): en esta máquina hay 15 proyectos registrados y 0 tarjetas, pero es
  un circuito cerrado que funciona —el hook `batch-capture` ya ha encolado 7
  scripts— y es la forma de trabajar del proyecto de origen. Se queda.
- **Tonos**, **MCPs**, **Skills y agentes**, **Consumo**, **Diagnóstico**.

## Deuda que queda, dicha sin adornos

Esto no se ha tocado, a propósito: cada punto es una decisión de diseño que
debe tomarse entre los dos, no una limpieza.

1. ~~Dos sistemas de proveedores en paralelo.~~ **Resuelto el 2026-09-21: el AI
   Router se ha retirado.** Decidido con datos de esta instalación: ninguna
   clave de API configurada (solo `GITHUB_TOKEN`), así que dos de sus cuatro
   proveedores —gemini y claude por API— no podían contestar nunca; 4 llamadas
   ese día y 0 con éxito; y la interfaz usaba 1 solo de sus comandos. Sus seis
   llamadores (titular, resumir sesiones, nombrar hooks, tareas y captura de
   memoria, resumen de cambios de plugins) van ahora por `maria/interno.rs`, que
   es el relevo con tres reglas propias: nunca con acceso total, el modelo local
   primero y `haiku` si toca Claude. Probado de verdad: zona ligera → local en
   3,1 s; zona de código → Claude en 4,9 s; VRAM a 0 al acabar. Con él se van
   las claves de proveedores de Ajustes → API Keys (nada las consumía) y el
   diagnóstico que avisaba para siempre de «AI Router sin claves».
2. ~~Capa Python heredada.~~ **Decidido el 2026-09-21: se queda.** El análisis de
   alcance (desde lo que de verdad se ejecuta: backend Rust, hooks,
   instaladores, CI, pre-commit) dice que **44 de sus 46 scripts tienen llamador
   vivo**, y no residual: el propio backend invoca `scan_projects.py`,
   `launch_project.py`, `project_editor.py`, `mcp_health_check.py`,
   `skill_sync_security.py`, `skill_vault.py`, `registry_sync.py`, `doctor.py`
   y `deadwood_scanner.py`, y el enrutador de skills llama a `embed_skills.py`.
   La auditoría inicial la daba por «en buena parte superada por Rust» y era
   falso. Desmontarla sería reescribir unas diez funciones para no ganar nada.
   Solo salen los dos sin llamador: `system_diagnose.ps1` y `windows-tweaks.ps1`.
3. **Hooks: 38 registros en el manifiesto, 20 activos en esta máquina.** Seis
   procesos de Node por cada prompt enviado en la configuración completa. La
   plantilla pública (`templates/settings-hooks.json`) y el manifiesto
   (`hooks/manifest.json`, que refleja la máquina del mantenedor) describen
   conjuntos distintos: hay que fijar cuál es el canónico.
4. **Modo universitario** (`socratic-gate`, `uni-deliverable-guard`,
   `curso.mjs`, paso «Asignatura» del asistente de proyectos): útil para quien
   estudia, fuera de sitio en una herramienta profesional, y entrelazado con el
   plugin de Cowork y el servidor MCP de memoria. Debería ser un paquete
   opcional, no parte del núcleo.
5. **Plugin de Cowork con 43 copias literales de los hooks** versionadas en
   `plugins/`. El empaquetador ya sabe regenerarlas desde la fuente; al empezar
   esta auditoría una de ellas (`memory-session-resume.js`) estaba desfasada
   respecto al original. Lo generado no debería estar en git.
6. **«Conversaciones» y «Sesiones» leen el mismo dato** (los transcripts de
   `~/.claude/projects`). Una lee, la otra vigila y lanza. Candidatas a ser una
   sola pantalla con dos vistas.
7. **Nombre ULTRON por todas partes**: 2.554 apariciones en el código (`~/.ultron`,
   `ultron-memory.exe`, variables `ULTRON_*`, instaladores de 88 KB). Hoy lo
   sostiene un enlace de directorio. Funciona, pero es una muleta.
8. **«Reconstruir desde Ajustes» hace `git pull --ff-only`**: en un clon sin
   remoto falla antes de compilar.
9. **Código `pub` muerto dentro de `memory/`, `orchestrator/`, `serve/`**: el
   compilador no lo ve porque el sidecar consume esos módulos como biblioteca.
   No se ha auditado a mano.
10. **El test intermitente de `serve::lockfile`** citado arriba.

## Cómo comprobarlo

```bash
cd control-center
npx tsc --noEmit -p .
npx vitest run --silent
cd src-tauri
cargo check --all-targets
cargo test --lib
```
