# ultron-memory (plugin de Claude Desktop / Claude Cowork)

Lleva ULTRON a la app de escritorio de Claude: dos servidores MCP locales de
solo lectura (memoria personal + buscador de papers academicos) y los 3 hooks
minimos de memoria (resume al abrir, gate socratico por prompt, captura al
cerrar). Ninguna tool ni hook escribe en `brain.db` ni en Qdrant salvo via el
escritor unico gobernado (`ultron-memory candidate`, cae `pending` al inbox).

## Formato y fuente

Mismo formato que un plugin de Claude Code (`.claude-plugin/plugin.json` +
`.mcp.json` + `hooks/hooks.json` en la raiz del plugin, comando `stdio` con
`${CLAUDE_PLUGIN_ROOT}`). Confirmado en la documentacion oficial:

- Formato de plugin identico entre Claude (chat/Desktop/Cowork) y Claude Code:
  "For details on plugin structure and formatting, see the Plugins reference
  in our Claude Code docs."
  https://support.claude.com/en/articles/13837440-use-plugins-in-claude
- Referencia de plugins (manifiesto, `hooks/hooks.json`, `.mcp.json`,
  `${CLAUDE_PLUGIN_ROOT}`, "Path traversal limitations"):
  https://code.claude.com/docs/en/plugins-reference
- Plugins en Cowork ("Plugins are available in Cowork and Code. They aren't
  used in Chat.") y que un plugin puede incluir hooks:
  https://claude.com/docs/cowork/guide/plugins
- Donde corren los hooks de un plugin instalado por el usuario — "Plugin
  hooks": "Cowork sessions run hooks from marketplace plugins, from plugins in
  the org-plugins/ directory, and from plugins users add themselves. Code
  sessions run hooks from marketplace plugins (...) and from plugins the user
  installed for Claude Code."
  https://claude.com/docs/cowork/3p/extensions
- Donde corre el MCP local: "Local connectors and plugins that include local
  MCP servers work through the desktop app only."
  https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile
- Arquitectura Cowork: en sesion local, "the agent loop runs natively on the
  device. This includes (...) local plugin MCP servers"; solo la ejecucion de
  shell/codigo va a la VM Linux (Hyper-V en Windows). El MCP corre en el host,
  no en la VM — por eso el binario de Windows funciona.
  https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview

### La pestaña Code de la app de escritorio, ¿es la misma CLI?

Si, con matices. Cita literal: "Code in Claude Desktop on third-party (3P) is
the embedded Claude Code interface. It runs the same Claude Code engine as the
standalone CLI, with a graphical session manager, and it inherits your Claude
Desktop on 3P configuration automatically."
(https://claude.com/docs/third-party/claude-desktop/code)

Para MCP, la misma pagina nombra explicitamente `~/.claude.json` como "el lado
de Claude Code" que una sesion Code carga por defecto: una politica admin
opcional (`managedMcpServers.strictPluginOnlyCustomization`) puede apagarlo,
pero sin esa politica el `.mcp.json` de un plugin instalado por el usuario, y
los servidores que el usuario haya anadido con `claude mcp add` a
`~/.claude.json`, cargan igual que en terminal.

Para hooks, la cita de "Plugin hooks" de arriba (`cowork/3p/extensions`) es
la que aplica a este plugin: al instalarlo desde el file-upload de Cowork
(`Customize -> Plugins -> +`), cae en "plugins users add themselves" /
"plugins the user installed for Claude Code" — sus hooks corren en **ambas**
pestañas, Cowork y Code. Los hooks propios del usuario en
`~/.claude/settings.json` (los que usa la CLI, no los de este plugin) no
aparecen documentados linea por linea en esa pagina para el caso 3P; no
verificado en runtime para esta maquina (solo se probaron via CLI directa).

## Que expone

**Servidor `ultron-memory`** (`server/mcp-memory-server.mjs`, copia de
`scripts/mcp-memory-server.mjs` — el mismo que usa Claude Code por CLI):

- `memory_recall` — recall hibrido BM25+E5 sobre brain.db/Qdrant.
- `memory_stats` — salud y tamaño de la memoria.
- `memory_provenance` — origen verificable de un item.
- `curso_status` — indice del curso academico (asignaturas, TFG, proyectos
  enlazados, ultimo commit/fichero de cada uno). Lee
  `~/.ultron/cockpit/curso.json` en la maquina donde corre el plugin; ese
  fichero es personal y NO se empaqueta en el zip.

**Servidor `ultron-research`** (`server/hooks-scripts/research-mcp.js`, copia
de `hooks/scripts/research-mcp.js` + `hooks/scripts/lib/research/`): busca y
verifica papers academicos (OpenAlex + Semantic Scholar), resuelve acceso
abierto, comprueba retracciones y hace bola de nieve de citas/referencias. No
resume el paper por el usuario: siempre devuelve metadatos y enlaces a la
fuente primaria para que la verifique.

**Hooks** (`hooks/hooks.json`, copias de `hooks/scripts/`):

- `SessionStart` -> `memory-session-resume.js`: resume de la memoria de
  ULTRON al abrir sesion (solo lectura del sidecar).
- `UserPromptSubmit` -> `socratic-gate.js`: gate socratico (protocolo de
  decisiones: la IA codea, el usuario decide arquitectura con eleccion
  razonada). Nunca bloquea el prompt.
- `SessionEnd` -> `session-end-summary.js`: al cerrar, propone un resumen de
  sesion como candidate gobernado (`pending` en el inbox, nunca auto-promueve).

Deliberadamente **no** se incluye `memory-orchestrate.js` (prefetch de
memoria por cada prompt): se probo y se descarto por meter ruido en el pack
de contexto. Tampoco el resto de hooks del sistema completo (kanban,
codegraph, guardrails de texto-IA, etc.): no tienen sentido fuera de este
repo o dependen de estado que Cowork no tiene.

## Por que hay copias de los scripts dentro del plugin

Un plugin instalado no puede referenciar ficheros fuera de su propio
directorio (la referencia de plugins lo rechaza como "path escapes plugin
directory"; ver "Path traversal limitations"). `server/` es siempre una
copia de las fuentes canonicas:

- `server/mcp-memory-server.mjs` + `server/lib/curso.mjs` <-
  `scripts/mcp-memory-server.mjs` + `scripts/lib/curso.mjs`.
- `server/hooks-scripts/` <- `hooks/scripts/` (research-mcp.js, los 3 hooks
  y todo lo que arrastran via `require()`/`import`).

La fuente unica son los originales: no editar las copias a mano.
`node scripts/package-cowork-plugin.mjs` resuelve el grafo real de
imports/requires desde cada punto de entrada (no una lista escrita a mano) y
sincroniza el cierre completo antes de empaquetar — copia lo que cambio,
borra lo que sobra. `scripts/package-cowork-plugin.selftest.mjs` falla si
alguna copia commiteada difiere de su fuente o si algun require local deja
de resolver.

## Limites

- Solo funciona con la app de escritorio Claude abierta, y solo en sesiones
  locales (Cowork en la nube o Chrome side panel sin la app abierta no llega
  al MCP ni a los hooks locales).
- Depende de que `%USERPROFILE%\.ultron\bin\ultron-memory.exe` exista en esa
  maquina (instalacion de ULTRON local). No tiene sentido instalarlo en una
  maquina sin ULTRON.
- `research_search` y el resto de tools de `ultron-research` llaman a APIs
  externas (OpenAlex, Semantic Scholar, Crossref, Unpaywall): necesitan red.
- No verificado en runtime: la carga real del plugin dentro de la app de
  escritorio de Claude (Cowork/Code). Lo que se verifico fue arrancar cada
  servidor MCP por stdio y listar sus tools, y ejecutar cada hook con un
  payload de ejemplo — ver "Verificacion" abajo.

## Verificacion

Antes de instalar, o tras cualquier cambio:

```bash
node scripts/package-cowork-plugin.mjs               # sincroniza server/ y regenera el zip
node scripts/package-cowork-plugin.selftest.mjs       # estructura del zip + paridad con las fuentes
node scripts/mcp-memory-server.selftest.mjs           # servidor de memoria (fuente canonica)
node scripts/lib/curso.selftest.mjs                   # curso_status
node hooks/scripts/research-mcp.selftest.mjs          # servidor de investigacion (fuente canonica)
```

`package-cowork-plugin.selftest.mjs` arranca los dos servidores copiados y
comprueba, ficha a ficha, que cada uno es identico a su fuente; no repite las
pruebas de comportamiento de los selftests canonicos de arriba (para eso ya
existen). No prueba la carga dentro de la app de escritorio de Claude.

## Instalación (app de escritorio de Claude)

1. Regenerar el zip desde la raiz del repo ULTRON:
   `node scripts/package-cowork-plugin.mjs` (escribe
   `plugins/ultron-memory-cowork.zip`). No comprimir la carpeta a mano: el zip
   debe llevar el manifiesto en la raiz, rutas con `/`, entradas de directorio
   y ningun `.zip` anidado, y un zip antiguo no refleja los cambios del
   manifiesto ni de los servidores/hooks sincronizados.
2. Abrir la app de escritorio Claude (no la terminal de Claude Code).
3. Menu **Customize** (barra lateral) -> pestaña **Plugins**.
4. Botón "+" junto a "Personal plugins" -> subir
   `%USERPROFILE%\.ultron\plugins\ultron-memory-cowork.zip`.
5. Confirmar instalación. El plugin queda guardado localmente en el equipo.
6. Abrir un chat, una sesión de Cowork o una sesión de Code, todas
   **locales** (Desktop), y comprobar que las tools `memory_recall` /
   `memory_stats` / `memory_provenance` / `curso_status` /
   `research_search` / ... aparecen en el selector de herramientas, y que
   `hooks/hooks.json` aparece en la vista de detalle del plugin.
7. Probar con un prompt tipo: "usa memory_stats para ver el estado de mi
   memoria" y verificar que responde con datos reales (activos/deprecados).

Nota: en Cowork **en la nube** (o Chrome side panel sin la app abierta) este
MCP y estos hooks no estarán disponibles — es esperado, no es un fallo del
plugin.
