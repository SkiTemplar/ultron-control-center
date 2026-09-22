# mar.ia frente a Claude Desktop — estado real a 2026-09-21

Objetivo declarado por el usuario: que mar.ia haga lo que hace Claude Desktop,
**más** relevo entre proveedores cuando uno se queda sin cuota, **más** IA local
para lo cotidiano, conservando su interfaz (orbe, HUD) y sus extras (voz,
`//maria`, terminales, mosaico, móvil, memoria gobernada).

Este documento dice qué hay, qué se ha añadido en esta tanda y qué falta. Lo que
falta está ordenado por lo que más se nota al usarlo.

## Medidas de partida (esta máquina, RTX 4080 Laptop 12 GB)

| Qué | Antes | Ahora | Cómo |
|---|---|---|---|
| Mensaje a Claude desde el chat | 12,2 s | 4,3–5,0 s | `claude -p` cargaba todos los hooks y MCP de Claude Code en cada mensaje. Modo ligero: `--settings {"disableAllHooks":true}` + `--strict-mcp-config`. Misma respuesta, caché de prompt intacta. |
| «hola» contestado por la IA local | 2 cargas de modelo (decidir + contestar) | 1 carga: 7,6 s en frío | El destino de lo evidente se decide por reglas, sin modelo. |
| Lo mismo con el modelo residente | — | ~0,4 s | Opcional, apagado por defecto. De los 4,2 s de una respuesta local, 3,7 s (87 %) son cargar 6,6 GB a VRAM; generando va a 64 tok/s. |
| Proveedor sin cuota | se reintentaba en CADA mensaje | se le salta hasta que venza su plazo | Enfriamiento con el plazo que diga el error, o 15 min crecientes (tope 2 h). |
| Memoria lenta o caída | hasta 8 s en fila delante de todo | en paralelo, 2 s como mucho | Si el daemon está caliente llega en 100–300 ms y entra igual. |
| VRAM ocupada con mar.ia cerrada | 8,6 GB durante 5 min tras cada llamada interna | se suelta al acabar | El AI Router llamaba a Ollama sin `keep_alive` y heredaba los 5 min por defecto. Lo disparaban también los hooks de cualquier sesión de Claude Code (captura de memoria) a través del sidecar. |
| Segundo turno con el mismo proveedor | hilo pegado como texto en cada turno | sesión reanudada: Claude 5,0 → 3,7 s | Verificado con las tres CLI reales: mismo identificador de sesión y las tres recordaron un dato del turno anterior. |
| Primer texto en pantalla | al terminar la respuesta entera | según se escribe | Streaming de Claude (`stream-json`), Ollama (NDJSON) y stdout del resto. |

## Matriz de capacidades

| Capacidad de Claude Desktop | mar.ia | Nota |
|---|---|---|
| Chat con historial, búsqueda, renombrar, fijar, carpetas, borrar | ✅ ya estaba, y la búsqueda mejor | `ThreadSidebar`, comandos `/titulo`, `/fijar`, `/carpeta`, `/borrar`. La caja de buscar mira también DENTRO de las conversaciones (`maria_threads_buscar`) y enseña el fragmento; al pulsarlo abre el hilo en ese turno. Hacía falta porque el título lo pone una IA a posteriori: buscar por lo que uno escribió no encontraba nada |
| Respuesta en streaming | ✅ **nuevo** | `maria/flujo.rs` + burbuja en vivo |
| Parar la respuesta | ✅ **nuevo** | Mata el proceso o cierra la conexión; conserva lo escrito |
| Adjuntar ficheros e imágenes (arrastrar, pegar, elegir) | ✅ **nuevo** | Las CLI reciben rutas; al local se le incrusta el texto. Una imagen nunca se enruta al modelo que no ve |
| Selector de modelo y de esfuerzo | ✅ ya estaba, y desde el 2026-09-22 **por suscripción** | Por proveedor, con lo que TU cuenta permite: Claude lee lo que la CLI deja en `~/.claude.json` (extras como Fable 5.1 y vetos) más los alias `opus/sonnet/haiku/fable` e ids concretos (Opus 5, Opus 4.6, Sonnet 5…); Codex, el catálogo que el servidor sirve a la cuenta (`codex debug models`); Antigravity, `agy models`. El plan detectado va junto al proveedor («claude · Claude Pro», «codex · ChatGPT Free»), lo vetado se ve en gris con el motivo, un rechazo real se recuerda 7 días y `/modelos` (o «actualizar modelos» en Ajustes → Cuentas) vuelve a preguntar. El esfuerzo en Claude ya es bandera real (`--effort`) |
| Markdown, tablas, bloques de código, copiar | ✅ ya estaba | Sin resaltado de sintaxis (ver pendientes) |
| Memoria entre conversaciones | ✅ ya estaba, y mejor | Memoria gobernada con inbox; Claude Desktop no deja auditarla |
| Conectores MCP | ✅ **nuevo** | En Router → Criterio se eligen los MCP locales que siguen activos en el chat con el modo ligero, y un botón los da de alta en Codex y Antigravity con el gestor de cada CLI. Los conectores de claude.ai no se pueden clonar: van con el inicio de sesión de Claude |
| Dictado por voz | ✅ ya estaba, y mejor | Palabra clave, pulsar-para-hablar, respuesta hablada |
| Entrada rápida global | ✅ ya estaba | `Ctrl+Alt+M` y `//maria` en cualquier programa (Claude Desktop no tiene equivalente a lo segundo) |
| Sesiones de código (pestaña Code) | ✅ ya estaba | Terminales embebidas, mosaico, Sesiones, Proyectos |
| Proyectos con instrucciones y conocimiento propios | ✅ **nuevo** | Selector «proyecto» en la cabecera del chat (o `/proyecto <ruta>`): los agentes arrancan en esa carpeta —Claude lee su `CLAUDE.md`, Codex su `AGENTS.md`— y el panel Cambios enseña su diff |
| **Artifacts** (panel lateral que renderiza HTML/SVG/Mermaid/código) | ✅ **nuevo** | Panel a la derecha con vista/código, copiar y guardar. El HTML corre con su JavaScript en un `iframe` aislado servido desde otro origen (probado: un botón que cambia el fondo funciona) |
| Editar un mensaje, regenerar y ramas | ✅ **nuevo** | «editar» en tus mensajes, «regenerar» en la última respuesta. Lo que se aparta queda como **rama** (`/ramas`, `/rama n`); volver a una guarda la actual |
| Búsqueda web dentro del chat | ⚠️ indirecta | La hace el proveedor si su CLI la trae (Claude y Antigravity sí). No hay interruptor propio ni citas |
| Resaltado de sintaxis, LaTeX, Mermaid en el chat | ✅ **nuevo** | Con barra por bloque (lenguaje, abrir, copiar). Mermaid se carga solo cuando aparece un diagrama. Los enlaces ahora se abren en el navegador |
| Estilos de respuesta | ✅ equivalente | Tonos (Library → Tones) |
| Exportar conversación | ✅ **nuevo** | Botón «exportar» y `/exportar`: Markdown con quién dijo qué |
| **Paneles laterales** (cambios, vista previa web, ficheros) | ✅ **nuevo** | A la derecha del chat, con pestañas. Cambios: `git status` + diff coloreado por fichero, se relee cuando un agente termina, y desde ahí mismo se prepara, se descarta (con confirmación, y nunca sobre ficheros sin seguir) y se confirma con mensaje. Web: vista previa en marco, y ventana propia o navegador para los sitios que no se dejan enmarcar. Ficheros: la carpeta de la conversación; `html`/`svg`/`mmd` se abren como artefacto y `md` con formato |
| Paleta de órdenes y atajos del chat | ✅ **nuevo** | `Ctrl+K` en castellano y sin distinguir tildes. Las acciones del chat (nueva, parar, regenerar, exportar, paneles, ramas, delegar) son UNA lista: salen a la vez en la paleta y como atajo (`Alt+N/G/E/C/F/W`, `Escape` para parar), y solo existen con el chat en pantalla. Los paneles se recorren con las flechas sin tocar el ratón |
| Tareas programadas | ⚠️ parcial | Sistema → Tareas gestiona las de Windows; no hay «pregúntale esto cada mañana» |

### Lo que mar.ia tiene y Claude Desktop no

Relevo entre proveedores con traspaso de contexto · IA local sin coste ni red ·
consumo real por proveedor y ventana de cuota · voz bidireccional · `//maria`
global · webapp móvil que habla solo con tu PC · memoria auditable ·
criterio de reparto editable en texto llano.

## Pendiente, por orden de impacto

1. **Modelo local pequeño para lo trivial.** Aparcado a petición del usuario:
   se sigue con `qwen3.5:9b`. Con uno de ~2–4 GB la carga en frío bajaría a ~1 s.
2. **Streaming token a token en Codex.** `codex exec --json` entrega mensajes
   enteros, no deltas: se ve qué orden ejecuta, pero el texto llega de golpe.
   Es un límite de su CLI. Antigravity y Claude ya van token a token.
3. **Imágenes en el panel Ficheros.** Se abren con su programa; pintarlas dentro
   pide habilitar el protocolo `asset` de Tauri con un alcance acotado.
4. **Encargos que se hablen en directo.** Hoy se coordinan por el tablero y los
   ficheros.

## Multiagente en paralelo (hecho)

`/delegar <proveedor> <encargo>` lanza un trabajo en segundo plano: el chat
sigue libre y hasta cuatro encargos corren a la vez por conversación. Lo que lo
hace un entorno compartido:

- **Carpeta de trabajo** común por conversación (`<hilo>.trabajo/`): todos los
  agentes arrancan ahí.
- **`TABLERO.md`** dentro de ella, con una línea por encargo (quién, estado,
  qué). Cada agente lo recibe al empezar para no repetir lo de otro.
- **El hilo**: al acabar, el resultado entra en la conversación firmado por
  quien lo hizo, y el siguiente mensaje del chat ya lo ve.

En pantalla: una tira sobre la caja de escritura con el estado de cada encargo,
lo último que está haciendo y un botón de parar. Probado en la aplicación real:
Codex redactó un índice mientras el modelo local contestaba otra pregunta.

**Reparto automático** (Router → Criterio): quien contesta puede encargar parte
del trabajo él mismo con una línea `@delegar <proveedor>: <encargo>` al principio
de línea y con un proveedor conocido; una mención en mitad de una frase no lanza
nada. La respuesta dice qué encargos ha lanzado.

Límites declarados: los agentes no se hablan en directo, se coordinan por el
tablero y los ficheros; y un encargo no reanuda sesión, es un trabajo cerrado
con el contexto del hilo por delante.

## Acceso total y capacidades compartidas

Ajuste «Acceso total al equipo» (Router → Criterio), **apagado por defecto en el
código** para que quien clone el repo no herede un agente con el equipo abierto:

- Claude y Antigravity con `--dangerously-skip-permissions`, Codex con
  `--dangerously-bypass-approvals-and-sandbox`; los tres arrancan en la carpeta
  de trabajo de la conversación.
- El **modelo local** recibe herramientas por la API de Ollama: leer y escribir
  ficheros, listar carpetas, ejecutar PowerShell y consultar la memoria. Lleva
  tres cinturones que las CLI grandes no necesitan: lista de órdenes vetadas
  (formatear, borrar la raíz, apagar, tocar el arranque o el registro del
  sistema), topes de 60 s y 6.000 caracteres por orden, y ocho vueltas por turno.
- **Skills para todos**: Claude las carga de forma nativa; al resto se les da el
  índice de las que casan con la petición (nombre, para qué sirve y ruta del
  `SKILL.md`) para que la abran. Es texto en el mensaje, no una carga nativa.
- **El manual**: cada sesión empieza sabiendo dónde está la carpeta común y cómo
  encender o apagar skills (`_disabled/`) y MCP (`claude|codex|agy mcp …`) por
  su cuenta.
