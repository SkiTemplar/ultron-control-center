# Tutorial — usar ULTRON en el día a día

Para dos lectores: **tú** (persona que acaba de instalar) y **tu asistente IA**
(Claude Code u otro cliente MCP), que puede leer este fichero para operar el
sistema correctamente. El tour de pestañas de 5 minutos está en
[`QUICKSTART.md`](QUICKSTART.md); la spec técnica de la memoria en
[`memory-spec.md`](memory-spec.md).

## La idea en una frase

Trabajas con Claude Code como siempre; ULTRON escucha por hooks, recuerda lo
que importa y se lo devuelve a la IA en cada sesión. No cambias tu flujo:
lo enriqueces.

## Qué pasa solo (sin que hagas nada)

| Momento | Qué ocurre |
|---|---|
| Abres una sesión de Claude Code | El hook `SessionStart` inyecta un resume del proyecto: estado, tareas, decisiones recientes. La IA "recuerda" dónde lo dejasteis. |
| Escribes cualquier prompt | El hook `UserPromptSubmit` busca en la memoria (recall híbrido) e inyecta las memorias relevantes + sugiere skills/agentes. Si el corpus no sabe nada útil, se abstiene. |
| Cierras la sesión | El hook `Stop` extrae hechos durables del transcript y los propone como **candidatos** al inbox. Nada se escribe como memoria activa sin pasar por gobernanza. |

Los primeros días la memoria está vacía: el recall aportará poco hasta que
acumules sesiones. Es normal.

## Tu rutina mínima (2 minutos al día)

1. **Inbox** (pestaña Memory): revisa los candidatos capturados. Aprueba lo
   que quieras recordar, rechaza el ruido. También hay drain automático con
   política de bandas — el inbox se vacía solo si no lo tocas.
2. **Dashboard**: si algo está rojo, el propio panel te dice qué.

## Proyectos y kanban

- Registra un proyecto: pestaña Projects → alta (o
  `node scripts/project-new.mjs --name "X" --path "C:\ruta" --card "primera tarea"`).
- Las tarjetas se gestionan por CLI o UI: `node scripts/kanban.mjs list <proyecto>`,
  `add`, `mv`, `rm`. **La IA debe usar el CLI, nunca editar `kanban.json` a mano.**
- Las memorias se etiquetan por proyecto: el recall prioriza lo del proyecto
  activo (por el `cwd` de la sesión).

## Instrucciones para tu asistente IA

Si eres el asistente del usuario, esto es lo que debes saber:

- **No gestiones memoria por tu cuenta**: los hooks ya capturan y recuperan.
  Escribir memoria activa directamente está prohibido (escritor único).
- **Consultas manuales** cuando el contexto inyectado no baste:
  - `~/.ultron/bin/ultron-memory recall "<consulta>" --project <slug>` — pack de memorias.
  - `... recall "<consulta>" --cross` — buscar en todo el cerebro.
  - `... trace "<consulta>"` — por qué entró (o no) cada memoria.
  - `... provenance --id <prefijo>` — origen verificable de una memoria.
  - `... stats` / `... doctor` — salud del sistema.
- **Vía MCP** (si el server `ultron-memory` está registrado): tools
  `memory_recall`, `memory_stats`, `memory_provenance` — mismo motor.
- **Curación puntual**: `... curate --id <prefijo> --project <slug> --title "..." --apply`
  (dry-run sin `--apply`). Para reetiquetar o retitular un item concreto.
- **Kanban**: siempre `node scripts/kanban.mjs ...`, nunca el JSON a mano.
- **Tras tocar código Rust de la memoria**: recompilar el sidecar y
  redesplegarlo (`node control-center/scripts/deploy-sidecar.mjs`); un binario
  viejo es la causa nº1 de "mi cambio no se aplicó".
- **La app de escritorio bloquea su .exe**: ciérrala antes de `npm run build:local`.

## Skills, agentes y tonos

- **Skills**: viven `.disabled` por defecto; el dispatcher las activa
  on-demand según el prompt (routing lazy). No actives skills en masa: sube
  el coste de contexto de cada sesión. Gestión en Library → Skills.
- **Agentes**: el orquestador sugiere especialistas por prompt y puede emitir
  una directiva de delegación. La instalación pública no incluye agentes
  preinstalados; añade los tuyos en `~/.claude/agents/`.
- **Tonos**: Library → Tones. Detección determinista del registro del chat.
  Tu configuración es local (`~/.ultron/personality.json`, gitignored).

## AI Router y cuentas

- **AI Router**: zonas con cadena primario→fallback para las llamadas que
  hace la app (no afecta a tu Claude Code, que habla directo con Anthropic).
  Keys en Settings → API Keys.
- **MCP Accounts** (Settings): varias cuentas del mismo servicio (Supabase,
  GitHub) como servers MCP paralelos — pega alias + token y nombra la cuenta
  en el chat; sin rotación.

## Comprobación de salud en 30 segundos

```powershell
~/.ultron/bin/ultron-memory.exe doctor    # todo ok / qué está roto
~/.ultron/bin/ultron-memory.exe stats     # tamaño de la memoria
~/.ultron/bin/ultron-memory.exe serve-ping # ¿daemon vivo?
```
