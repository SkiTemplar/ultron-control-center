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
| Primer texto en pantalla | al terminar la respuesta entera | según se escribe | Streaming de Claude (`stream-json`), Ollama (NDJSON) y stdout del resto. |

## Matriz de capacidades

| Capacidad de Claude Desktop | mar.ia | Nota |
|---|---|---|
| Chat con historial, búsqueda, renombrar, fijar, carpetas, borrar | ✅ ya estaba | `ThreadSidebar`, comandos `/titulo`, `/fijar`, `/carpeta`, `/borrar` |
| Respuesta en streaming | ✅ **nuevo** | `maria/flujo.rs` + burbuja en vivo |
| Parar la respuesta | ✅ **nuevo** | Mata el proceso o cierra la conexión; conserva lo escrito |
| Adjuntar ficheros e imágenes (arrastrar, pegar, elegir) | ✅ **nuevo** | Las CLI reciben rutas; al local se le incrusta el texto. Una imagen nunca se enruta al modelo que no ve |
| Selector de modelo y de esfuerzo | ✅ ya estaba | Por proveedor, con lo que cada CLI soporta de verdad |
| Markdown, tablas, bloques de código, copiar | ✅ ya estaba | Sin resaltado de sintaxis (ver pendientes) |
| Memoria entre conversaciones | ✅ ya estaba, y mejor | Memoria gobernada con inbox; Claude Desktop no deja auditarla |
| Conectores MCP | ⚠️ parcial | Se gestionan en la pestaña MCPs y los usan las sesiones de Claude Code. En el **chat**, el modo ligero los apaga a cambio de velocidad; con «Claude ligero» desactivado vuelven |
| Dictado por voz | ✅ ya estaba, y mejor | Palabra clave, pulsar-para-hablar, respuesta hablada |
| Entrada rápida global | ✅ ya estaba | `Ctrl+Alt+M` y `//maria` en cualquier programa (Claude Desktop no tiene equivalente a lo segundo) |
| Sesiones de código (pestaña Code) | ✅ ya estaba | Terminales embebidas, mosaico, Sesiones, Proyectos |
| Proyectos con instrucciones y conocimiento propios | ⚠️ parcial | Hay carpetas de conversaciones y CLAUDE.md por proyecto, pero una conversación del chat no hereda instrucciones ni ficheros de un proyecto |
| **Artifacts** (panel lateral que renderiza HTML/SVG/Mermaid/código) | ❌ falta | Es la ausencia que más se nota. Ver pendientes |
| Editar un mensaje y regenerar / ramificar | ❌ falta | El hilo es un `.jsonl` de solo añadir; hace falta truncar o ramificar |
| Búsqueda web dentro del chat | ⚠️ indirecta | La hace el proveedor si su CLI la trae (Claude y Antigravity sí). No hay interruptor propio ni citas |
| Resaltado de sintaxis, LaTeX, Mermaid en el chat | ❌ falta | `react-markdown` + `remark-gfm` a secas |
| Estilos de respuesta | ✅ equivalente | Tonos (Library → Tones) |
| Exportar / compartir conversación | ❌ falta | El hilo es un `.jsonl` legible, pero no hay botón |
| Tareas programadas | ⚠️ parcial | Sistema → Tareas gestiona las de Windows; no hay «pregúntale esto cada mañana» |

### Lo que mar.ia tiene y Claude Desktop no

Relevo entre proveedores con traspaso de contexto · IA local sin coste ni red ·
consumo real por proveedor y ventana de cuota · voz bidireccional · `//maria`
global · webapp móvil que habla solo con tu PC · memoria auditable ·
criterio de reparto editable en texto llano.

## Pendiente, por orden de impacto

1. **Artifacts.** Panel a la derecha del chat que renderice en un `iframe`
   aislado los bloques ```html, ```svg y ```mermaid, con pestaña de código y
   botón de guardar a fichero. No depende del proveedor: se detecta sobre el
   markdown de la respuesta. Hay que ampliar la CSP solo para ese `iframe`
   (`sandbox` sin `allow-same-origin`).
2. **Editar y regenerar.** `relay::truncar_desde(thread_id, indice)` + botón en
   la última burbuja del usuario. Ramificar de verdad (conservar la rama vieja)
   pide un campo `parent` en `Turn`.
3. **Resaltado de sintaxis + Mermaid + LaTeX** en el markdown del chat
   (`rehype-highlight`, `mermaid`, `remark-math`/`rehype-katex`). Barato y muy
   visible.
4. **Continuidad de sesión con Claude.** Hoy cada turno es un `claude -p` sin
   estado con el contexto pegado como texto (8 turnos, 6.000 caracteres).
   Mientras conteste el mismo proveedor se puede usar `--session-id`/`--resume`:
   contexto completo, más caché de prompt, menos cuota. El paquete de contexto
   queda para cuando hay relevo de verdad.
5. **MCP selectivos en el chat.** Entre «todo Claude Code» (12 s) y «nada»
   (4,5 s) cabe un fichero `--mcp-config` solo con los conectores que el
   usuario marque para el chat.
6. **Conversaciones dentro de un proyecto**: que hereden su CLAUDE.md y su
   carpeta como `--add-dir`.
7. **Modelo local pequeño para lo trivial.** Con un modelo de ~2–4 GB la carga
   en frío baja a ~1 s y permite tener residencia sin ocupar media GPU. Hoy
   solo hay `qwen3.5:9b` instalado; el catálogo ya admite más de uno.
8. **Exportar** una conversación a Markdown.

## Multiagente en paralelo (pedido, sin empezar)

Pedir a Codex una cosa mientras Claude hace otra, sobre un espacio compartido.
Las piezas base ya existen —terminales embebidas por proveedor, mosaico, hilos
de mar.ia, carpeta de adjuntos por hilo— pero falta lo que lo convierte en un
sistema: una carpeta de trabajo común por encargo, un tablero de quién tiene
qué, y que el hilo principal reciba el resultado de cada agente al acabar. Es
un diseño propio, no un ajuste del relevo, y conviene acordarlo antes de
escribirlo.
