# ultron-memory (plugin de Claude Desktop / Claude Cowork)

Expone la memoria personal de ULTRON (`brain.db` + Qdrant, recall hibrido
BM25+E5 via el sidecar `ultron-memory.exe`) como servidor MCP local, de solo
lectura (ninguna tool escribe en `brain.db` ni en Qdrant).

## Formato y fuente

Mismo formato que un plugin de Claude Code (`.claude-plugin/plugin.json` +
`.mcp.json` en la raiz del plugin, comando `stdio` con `${CLAUDE_PLUGIN_ROOT}`).
Confirmado en la documentacion oficial:

- Formato de plugin identico entre Claude (chat/Desktop/Cowork) y Claude Code:
  "For details on plugin structure and formatting, see the Plugins reference
  in our Claude Code docs."
  https://support.claude.com/en/articles/13837440-use-plugins-in-claude
- Referencia de plugins (manifiesto, `.mcp.json`, `${CLAUDE_PLUGIN_ROOT}`):
  https://code.claude.com/docs/en/plugins-reference
- Donde corre: "Local connectors and plugins that include local MCP servers
  work through the desktop app only."
  https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile
- Arquitectura Cowork: en sesion local, "the agent loop runs natively on the
  device. This includes (...) local plugin MCP servers"; solo la ejecucion de
  shell/codigo va a la VM Linux (Hyper-V en Windows). El MCP corre en el host,
  no en la VM — por eso el `.exe` de Windows funciona.
  https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview

## Por que hay una copia del script dentro del plugin

`server/mcp-memory-server.mjs` es una copia de
`scripts/mcp-memory-server.mjs` (raiz del repo ULTRON), ya usado hoy como MCP
de Claude Code. Se duplica porque, una vez instalado, un plugin no puede
referenciar ficheros fuera de su propio directorio (la referencia de plugins
lo rechaza como "path escapes plugin directory"; ver "Path traversal
limitations" en la referencia de plugins). Si cambia el protocolo o las
tools en el original, replicar el cambio aqui.

## Limites

- Solo funciona con la app de escritorio Claude abierta, y solo en sesiones
  locales (Cowork en la nube o Chrome side panel sin la app abierta no llega
  al MCP local).
- Depende de que `%USERPROFILE%\.ultron\bin\ultron-memory.exe` exista en esa
  maquina (instalacion de ULTRON local). No tiene sentido instalarlo en una
  maquina sin ULTRON.
- Tools expuestas: `memory_recall`, `memory_stats`, `memory_provenance` — las
  tres de solo lectura.

## Instalación (app de escritorio de Claude)

1. Abrir la app de escritorio Claude (no Claude Code).
2. Menu **Customize** (barra lateral) -> pestana **Plugins**.
3. Boton "+" junto a "Personal plugins" -> subir un plugin propio, apuntando
   a la carpeta `%USERPROFILE%\.ultron\plugins\ultron-memory-cowork`
   (o a un `.zip` de esa carpeta si la UI solo acepta fichero).
4. Confirmar instalacion. El plugin queda guardado localmente en el equipo.
5. Abrir un chat o una sesion de Cowork **local** (Desktop) y comprobar que
   las tools `memory_recall` / `memory_stats` / `memory_provenance` aparecen
   en el selector de herramientas/skills.
6. Probar con un prompt tipo: "usa memory_stats para ver el estado de mi
   memoria" y verificar que responde con datos reales (activos/deprecados).

Nota: en Cowork **en la nube** (o Chrome side panel sin la app abierta) este
MCP no estara disponible — es esperado, no es un fallo del plugin.
