# ULTRON Sesiones — contrato v0.3 (estabilidad)

Sustituye en `CONTRATO.md` y `CONTRATO-v2.md` todo lo relativo a estado de la
sesión, cola de envíos, preguntas, comandos `/` y protocolo del puente. Lo que
aquí no aparece sigue como estaba. Fuente de diseño: el contrato de
estabilidad del 2026-10-08 y su cambio de diseño («todos los slash commands
desde el chat»). La frase «¿Lo integras?» de «Traer a Claude» queda retirada.

## 1. Estado de la sesión

El backend es la única fuente de verdad. `SessionStatus` conserva
`starting | idle | working | waiting | exited`; el detalle viaja en
`SessionInfo`: `waiting` (`question | permission | plan | menu | trust`, con
`askId`, `label`, `since` y, solo en `menu`, `options`, leídas de la pantalla
emulada al proyectar; la etiqueta de un menú abierto por un turno de comando
es `/<comando>` y, si no, «Menú abierto en la TUI»), `stalled` (subcondición
de `working`: `noTurnStart | toolOverdue | tuiFrozen | noEvents`; y de
`starting`: `startupTimeout`; con `since` y `detail`), `workingSince`,
`lastActivityAt`, `turnId`, `screen`, `permissionMode` real,
`launchPermissionMode`, `exitCode` y `bridgeProtocol` (0 sin hello, 1 mod
antiguo, 2 este contrato).

`terminalAttached?`: terminal del bloque de menú enganchada (#31); solo
viaja cuando es `true`. El backend lo fija al enganchar y al soltar la
terminal (también en el reinicio) y reemite `sesiones://sessions` solo si
cambia. En `idle` con elementos `queued`, la línea de estado muestra
«Cola en pausa» con «Soltar la terminal» (`restore-size` y después
`detach`). Al cerrar la última ventana o recargar su
página, el backend restaura el tamaño, suelta todas las terminales y quita
la pausa; con otra ventana abierta, cerrar la del menú no suelta nada
(queda el `pagehide` del frontend).

`foregroundTool?`: `{ toolUseId, name, since, backgroundable }`, la
herramienta del hilo principal en primer plano según el puente (la más
reciente de las abiertas); solo viaja con una abierta y su llegada o su
cierre reemiten `sesiones://sessions`. `backgroundable` es `true` para
`Bash`, `PowerShell`, `Agent`, `Task` y `mcp__*` (las que Ctrl+B puede pasar
a segundo plano, §3.4) solo mientras la TUI pinta «ctrl+b to run in
background» (`Senal::Pantalla.pista`): Claude Code 2.1.306 a veces no la pinta
y entonces no atiende Ctrl+B (incidente del 2026-10-21). La línea de estado la usa para el tiempo de la
herramienta en curso (el inicio del backend sobrevive a recargar la
ventana) y para ofrecer «Segundo plano».

`queuePause?`: `{ reason, since }` mientras la cola de ULTRON sigue retenida;
solo viaja con pausa. `sesiones_queue_send_now` («Enviar ahora») levanta
cualquiera. En `idle` con elementos `queued`, la línea de estado lo dice con
«Enviar ahora». Si hay varias, viaja la que tarda más en resolverse sola:
`usageLimit`, `interrupted`, `deadline`.

- `deadline`: tras un cierre de turno por plazo con puente (`lost` o red de
  seguridad del transcript sin `turnEnd`). También la levantan un `turnEnd` o
  `hello` real del puente y 30 s de prompt estable en `idle`. La red de
  seguridad no pausa si el puente mandó un `turnEnd` (aunque se ignorase por
  atrasado o ajeno) en los 3 s previos a la evidencia del transcript, y el
  aviso `sesiones://notice` de la pausa solo sale con algo en cola.
- `interrupted`: el usuario interrumpió (`InterrupcionPedida`), un turno cerró
  como abortado, el transcript trae la línea de interrupción (Esc en la
  terminal) o la sesión se restauró con el turno a medias (`TurnoCortado`).
  También la levantan un prompt del usuario (no un `/comando` ni un `!bash`) y
  Reiniciar. Sobrevive a cualquier fin de turno posterior: mientras dure, todo
  turno sale como `aborted`, también el que la CLI abra sola tras la
  interrupción.
- `usageLimit`: Claude llegó a su límite de uso (§ Límite de uso, abajo).
  También la levanta el fin del límite. Un prompt o Reiniciar no: no prueban que
  la cuota haya vuelto. Con ella, un envío automático entra en la cola en vez de
  escribirse.

Límite de uso (`relevo_limite.rs`, también con `automaticRelay` apagado): el
primer aviso de cuota del transcript retiene la cola, y lo mismo hace
`registro_drenaje::drenar` antes de escribir si el aviso ya está al final del
fichero con menos de 60 s (el `turnEnd` del puente llega antes que el seguidor)
o si la muestra local de uso está al 100 % con el reinicio pendiente (sesión
restaurada en pleno límite). El aviso `sesiones://notice` sale una vez y solo
con algo en cola. Lo encolado espera y sale al volver: no entra en el traspaso
del relevo, porque llegaría dos veces, y el motor del relevo no lo conoce. Con
relevo, el límite acaba en la vuelta a Claude; sin relevo, a la hora del aviso o
de la muestra, aplazada si la muestra sigue al 100 %. Sin hora conocida, o con
el relevo en error, espera a «Enviar ahora». Comprobado con tests de la máquina
y del relevo con motores falsos; no se ha ejercitado con un límite real.

Recuperación (`sesiones_recover`, `interrupt`): pasos nuevos `turnoNuevo`
(el turno pedido cerró y la CLI abrió otro: se aborta ese una vez por el
puente, nunca con teclas), `retomaPorTarea` (ese turno lo abrió el aviso de
una tarea en segundo plano, Bash o subagente; sustituye a
`retomaPorSubagente`, que el frontend sigue leyendo), `colaDevuelta` y
`esc2` (el Esc solo sacó la cola nativa a la caja: se devuelve a la cola y
otro Esc), `ctrlCOmitido` (Ctrl+C solo con el mismo turno, la caja vacía y
la pantalla ocupada), `sinRespuesta` (el mismo turno sigue, sin actividad
del puente: único caso con aviso de error de la máquina) y `antirrebote`
(la anterior terminó hace menos de 1,5 s; `enCurso` queda para una en
marcha). Con `turnoNuevo`/`retomaPorTarea` la máquina avisa en ámbar.
`colaNativaSinTurnAbort`: con mensajes en la cola nativa de la CLI
(`cliQueued`) no se usa `turn.abort`, que cierra el turno sin marca de
interrupción y deja que la CLI saque acto seguido el siguiente mensaje (Claude
seguía trabajando, 2026-10-21); se empieza por Esc, que devuelve esa cola a la
caja (`colaDevuelta`). La pausa de la cola (`interrupted`, arriba) empieza con
`InterrupcionPedida`, no al cerrar el turno: lo devuelto a mitad de la
recuperación no se reenvía hasta «Enviar ahora». `RecuperacionTerminada` puede
llegar antes que la pantalla en prompt (la máquina la recibe con 150-250 ms de
retraso): el cierre queda pendiente y se aplica al llegar el prompt, si antes no
empezó otro turno ni se escribió otro envío.

La máquina (`maquina.rs`) es pura: `transicion(estado, señal, ahora,
tickets) -> (estado, efectos)`. Señales: las de `senales.rs` (PTY, puente,
transcript, reloj y recuperación). Jerarquía: puente > transcript >
pantalla. Reglas clave:

- Fin de turno: `turnEnd` filtrado por `turnId` y por los 32 últimos turnos
  cerrados (un `turnEnd` atrasado nunca devuelve `idle`); `idle` solo sin
  pendientes (envíos sin evidencia, cola nativa de la CLI, asks).
- Sin puente: `turn_duration`, `[Request interrupted…]`, la salida de un
  comando local o de `!cmd` cierran; `end_turn` solo tras 1,5 s sin actividad.
  Con puente, red de 3 s si el transcript cerró y no llegó `turnEnd`; durante
  2 s tras un `turnEnd` del puente que dejó un turno de relleno, el fin de
  turno del transcript es el eco del mismo turno: no cierra otro, y pasa a
  `idle` si ya no quedan pendientes (un `cliQueued` absorbido en ese turno)
  y no ha llegado ningún `prompt` del puente después del `turnEnd` (#41.3).
  El puente aplica la señal del `prompt` antes de la entrega en la cola, para
  que el eco nunca vea la cola sin pendientes sin ver también el `prompt`.
- Reconciliación por pantalla: `prompt` estable 3 s sin turno ni herramientas;
  `turnId` abierto con `prompt` 10 s sin progreso, con 10 s desde el inicio
  del turno y 10 s desde la última actividad (cuentan los eventos del
  puente) = `turnEnd` perdido.
- Comandos: `commandEnd` cierra los locales; los de clase `prompt` esperan
  15 s a que abran turno.
- Asks: varios a la vez; `waiting` hasta cerrar el último. Interrumpir no
  cancela los asks hasta `turnEnd` o 2 s.
- Reinicio: `starting`; los `cliQueued` (cola nativa del proceso que se
  mata) pasan a `failed` con Reintentar y los `sending` esperan evidencia
  (`cola.rs::fallar_cola_cli`); salida del proceso sin reinicio:
  `exited`, envíos en vuelo a `failed`.
- Modo de permisos: gana el cambio más reciente (hook o pantalla estable
  500 ms).
- Colgado: `noTurnStart` (15 s con puente), `toolOverdue` (timeout + 30 s,
  o 15 min; nunca para `Agent`, `Task` o `Workflow`), `tuiFrozen` (30 s en
  `busy` sin progreso) y `noEvents` (umbral de prefs, 60-600 s). En
  `starting`, la única es `startupTimeout`: 30 s desde el alta o el reinicio
  sin salir de `starting`; el detalle nombra la pantalla y la línea de estado
  ofrece «Reiniciar sesión».
- Reiniciar (`recover` con `restart`, #32): relanza con `--resume <sid>`
  solo si la conversación tiene transcript (el fijado en el registro o
  `<slug>/<sid>.jsonl`). Si no lo tiene (arranque que no llegó al prompt),
  relanza como sesión nueva con `--session-id <sid>` y la misma `Config`, y
  los pasos incluyen `sinTranscriptConversacionNueva`, que el frontend
  muestra como nota `warn` («No se encontró el transcript: se ha abierto una
  conversación nueva con el mismo id»). En el reinicio, los `cliQueued`
  pasan a `failed` (la cola nativa muere con el proceso). Sin verificar en
  vivo.
- Recuperación (`sesiones_recover`): si interrumpir no saca la sesión de
  `busy`, los pasos acaban en `sigueTrabajando` y, si desde que empezó llegó
  una `<task-notification>` al hilo principal, en `retomaPorSubagente`. El
  frontend lo muestra como nota `warn` y en la línea de estado con
  Interrumpir hasta que la sesión sale de `working`.

Eventos: `sesiones://sessions` con cada cambio visible, con cada cambio de
`waiting.options` de un menú aunque el estado no cambie (submenú o cursor
movido desde el xterm) y con `lastActivityAt` como mucho cada 5 s (`emitir =
cambio visible || actividad || opciones cambiadas`), `sesiones://turn` al cerrar un turno principal (`usage`
y `subagentUsage`), `sesiones://reset` al cambiar de conversación y
`sesiones://notice` para los avisos. La latencia (`t_first_event`,
`t_first_token`) queda en el log por turno.

## 2. Comandos `/`

Clases (`CommandKind`): `prompt` (abre turno), `local` (imprime texto), `menu`
(abre un menú o diálogo de la TUI), `exit` (cierra la CLI) y `unsupported`
solo con imposibilidad real (segundo plano, disposición de la TUI, vim, voz,
Desktop), siempre con nota. `panel` y `terminal` quedan en el cable por
compatibilidad y no se producen. Catálogo: lista viva del puente
(`sesiones://commands`) fusionada con `BUILTIN_META` (integrados 2.1.293) y
`MOD_META` (mods de ULTRON); sin puente, la fuente estática (parcial). Un
desconocido con lista viva es un error con sugerencias; sin ella se envía como
`prompt` con la nota «Comando no catalogado».

`sesiones_run_command(id, command, args, clientId) -> CommandOutcome`:

| Clase | Sesión en reposo | Sesión ocupada |
|---|---|---|
| `unsupported` | nota, sin PTY | nota |
| `menu`, `exit` | PTY con el prompt a la vista (`disposition: menu` para el bloque de menú) | PTY si es inmediato y la pantalla está ocupada; si no, cola |
| `prompt`, `local` | buzón `command.run` con puente v2 (reserva: PTY con el prompt a la vista); sin puente, PTY | igual que arriba |

En `waiting` nunca se escribe: el comando entra en la cola como `command`.

## 3. Cola de envíos

Una cola por sesión en el backend (`sesiones://queue {id, items}`), en
memoria y guardada en disco con la sesión (§8). `sesiones_send` y
`sesiones_queue_enqueue` son idempotentes por `clientId`. Estados `queued →
sending → cliQueued → absorbed | delivered`, o `failed` (Reintentar y
Editar) por un error de escritura o porque `resolver_huerfanos` no halló
evidencia («La CLI no confirmó el envío»). Si el proceso sale, los
`sending` y `cliQueued` pasan a `failed` («la sesión terminó»); en un
Reiniciar, los `cliQueued` pasan a `failed` («El reinicio cerró la CLI con
el mensaje en su cola: reinténtalo») y los `sending` siguen esperando
evidencia. `queued` → `sending` es atómico: si el drenaje y un envío
directo toman el mismo elemento, solo uno lo escribe. Un `failed` sin `messageUuid`
vuelve a `delivered`/`absorbed` (sin error) si después llega su mensaje; un
`sending` vivo con el mismo texto tiene prioridad. Drenaje: lo pide la
máquina y escribe un elemento por turno.

- Emparejamiento exacto con `normalizar_envio` (quita `<pasted_content>` y
  las menciones `@`), FIFO: `queue-operation` del transcript, `prompt` del
  puente y mensajes del usuario (`clientId` en `ChatMessage`). Las
  `task-notification` no cuentan.
- Prompt del transcript sin candidato (no cuenta un uuid ya emparejado ni
  una sesión sin cola): se anota con su texto normalizado, hasta 8 por
  sesión. Al resolver huérfanos, un `sending` escrito antes que ese prompt se
  da por entregado con su uuid (entrega por orden) solo si el prompt lo
  contiene entero. Si solo comparten 32 caracteres de prefijo (pudo ser otro
  prompt escrito a mano que empieza igual), pasa a `failed` con «La CLI no
  confirmó el envío: pudo llegar transformado…», y el Reintentar pide
  confirmación; sin indicio, `failed` con «La CLI no confirmó el envío».
- `popAll` y la recuperación de la caja de la TUI (G3 y `recover`) dan el
  texto por cubierto solo si coincide exactamente con un elemento que estaba
  en la caja (`sending`, `cliQueued` o `queued` devuelto por un `popAll`) o
  con su concatenación en orden; si no, crean un elemento de origen CLI. Con
  la caja igual al envío en vuelo no se crea ni se reencola nada; si la caja
  es un tramo que incluye el envío en vuelo, vuelven a `queued` solo los
  demás del tramo.
- Escritor del PTY: `Atascado` = trabajo cancelado antes de empezar, nunca se
  escribe (error de escritura); `SinConfirmar` = empezó y no confirmó en 10 s, se trata
  como escrito y queda en `sending`; si la escritura acaba fallando después,
  el error real queda en el log.
- Eco del frontend: se retira por `clientId` o por el `messageUuid` del
  elemento de la cola (el caso de la entrega por orden).

### 3.4 Forzar con Claude trabajando

Tres acciones del composer y de la línea de estado; todas dejan un
resultado visible (nunca un no-op silencioso).

| Acción | Atajo | Qué hace |
|---|---|---|
| «Enviar ya» | Ctrl+Enter | `sesiones_send` con `mode: "now"`: pegado + Enter en el acto, a la cola nativa de la CLI (`cliQueued` → `absorbed`). Claude lo lee en la siguiente frontera de herramienta |
| «Interrumpir y enviar» | Ctrl+Mayús+Enter | `sesiones_interrupt_send`: para el turno y manda el mensaje por delante de lo que la interrupción devuelva a la cola |
| «Segundo plano» | Ctrl+B | `sesiones_background`: Ctrl+B a la CLI con una herramienta en primer plano, verificado |
| «Subagente» | Ctrl+Mayús+D | alterna la delegación del siguiente mensaje (solo destino Claude) |

Ctrl+B también funciona con el foco fuera del composer: actúa sobre la
sesión del panel con foco (el mismo criterio que Ctrl+F). Con la tecla
mantenida solo cuenta la primera pulsación.

Decisión del composer (`submit.ts`): libre, los tres modos envían normal; con
un menú o la confianza en pantalla, o la sesión terminada, los modos forzados
se bloquean con una nota de error y el borrador se conserva; «Enviar ya»
esperando una respuesta (pregunta, permiso o plan) también se bloquea con el
motivo, porque Claude no leería nada hasta la respuesta. Los botones «Enviar
ya» (solo `working`) e «Interrumpir y enviar» (`working` o `waiting` sin
menú) aparecen con borrador y destino Claude.

**Limitación medida en este equipo.** La CLI pasa sola a segundo plano la
herramienta en curso cuando llega un mensaje encolado, salvo que haya un hook
`PostToolUse`/`PostToolUseFailure` que case con la herramienta, un
`PostToolBatch` o un mod que enganche `tool.call` (leído en el binario de
2.1.301). Aquí se dan las tres (`posttoolfail-capture.js` con matcher `*`,
`ultron-checkpoint`, `ultron-cierre` y el propio `ultron-puente`), y el spike
del 2026-10-16 lo confirma: un mensaje encolado durante un Bash de 90 s se
absorbió 90 s después, al terminar el comando; con Ctrl+B, en 1,5 s
(`docs/sesiones/spikes-pty.md`). Así que un «Enviar ya» espera a que acabe la
herramienta en curso, por larga que sea; para que llegue antes, Ctrl+B.

`sesiones_interrupt_send(id, text, attachments?, clientId?, delegate?) ->
InterruptSendOutcome { interrupted, sent, steps, item }`. Pasos: (1) el
mensaje entra `queued` en la primera posición (`encolar_delante`,
idempotente por `clientId`; uno ya enviado devuelve `yaEnviado` sin
interrumpir otra vez); (2) con `working` o `waiting`, la interrupción de §3.3
con la misma reserva que `sesiones_recover` (`enCurso` → espera, como
mucho 6 s, a que acabe la otra y vale si la pantalla ya no está ocupada:
`otraParo` u `otraNoParo`; `antirrebote` → paró si la pantalla ya no está
ocupada); (3) si paró, espera como mucho 1 s a que la máquina salga de
`working`/`waiting` (la señal de pantalla puede llegar un tick tarde;
`estadoSinCambiar` si no) y sale solo ese elemento (`enviar_ya` con su `clientId`) y lo que la interrupción
devolvió a la cola (popAll) se queda `queued` detrás y drena al cerrar el
turno nuevo. Si no paró (`sigueTrabajando`, `turnoNuevo`, `retomaPorTarea`),
`sent: false` y el mensaje sigue el primero de la cola: el frontend lo avisa
en ámbar con los pasos. Si además la cola está en pausa (`pausa_drenaje`,
p. ej. tras otra interrupción que sí paró), el último paso es `colaPausada`
y la nota pide pulsar «Enviar ahora», porque no drenará al cerrar el turno.
El frontend comparte la guarda de vuelo de «Interrumpir» (`beginRecover`). Con la sesión libre, `sinTurno` y envío inmediato.
Err sin encolar con la sesión terminada o arrancando, o con un diálogo o la
confianza en pantalla. El tipo del elemento sale del texto (`!` bash, `/`
comando, si no prompt); un `/comando` forzado no lleva eco.

`sesiones_background(id) -> BackgroundOutcome { ok, toolUseId, tool,
evidence: "toolEnd" | "none", steps, reason? }`. Uno por sesión: reserva
`<id>:Background` de §3.3; con otro en vuelo o recién terminado (< 1,5 s) no
escribe nada y devuelve `ok: false`, `steps: ["enCurso"]` o
`["antirrebote"]`, `tool` vacío y sin `reason` (nota informativa, no error).
El frontend ignora la autorrepetición de Ctrl+B y no lanza un segundo
`background` de la sesión mientras hay uno en vuelo. La CLI enlaza
`task:background` a Ctrl+B en el contexto `Task`, activo solo mientras hay
una tarea en primer plano (pinta «ctrl+b to run in background»); en el
transcript (Ctrl+O) Ctrl+B es pasar página. Por eso: Err sin escribir si no
hay herramienta abierta («No hay ninguna herramienta en primer plano») o si
no es de las que Ctrl+B mueve («Read no se puede pasar a segundo plano»). Si no,
espera hasta 4 s a que la pantalla pinte la pista
(`Clasificacion.pista_segundo_plano`: en el spike apareció unos 3 s después
de arrancar el comando y un Ctrl+B anterior no hizo nada), manda un `0x02`
por el escritor (guarda G5: solo con la pantalla `busy` y como mucho uno
cada 1,5 s; si no, `Ctrl+B rechazado: …`) y espera hasta 3 s a que el
puente cierre esa herramienta (el `tool.call` del mod termina con el
`tool_result` «Command was manually backgrounded by user with ID: …»).
Si la pista no llega, no se manda nada: `ok: false`, paso único `sinPista` y
`reason` «Claude Code no lo ofrece ahora (la TUI no pinta “ctrl+b to run in
background”); Esc para interrumpir». `ok: true` con `evidence: "toolEnd"`
(si terminó sola en ese plazo también cuenta: la nota dice «terminó o pasó a
segundo plano»); sin cierre, `ok: false` con `reason` «Claude Code no
confirmó el paso a segundo plano en 3 s». Pasos: `pista`, `ctrlB`, `toolEnd`
o `sinCierre`; `terminadaSinCtrlB` si la herramienta terminó sola mientras se
esperaba la pista (no se escribe nada). `sesiones_key` no admite Ctrl+B:
solo sale por este comando.

Línea de estado: con una herramienta en curso, «Ejecutando npm test… · 2 min
13 s»; si es `backgroundable`, las acciones son «Segundo plano» e
«Interrumpir», y desde los 2 min el aviso dice «Ctrl+B para pasarla a
segundo plano o Esc para interrumpir». Un `toolOverdue` con herramienta
movible antepone «Segundo plano».

## 4. Preguntas

Sin caducidad mientras la sesión vive. Se resuelven como `answered` o
`cancelled{interrupted | turnEnded | sessionExited | modAborted | restart}`.
`sesiones_pending_asks(id?)` las devuelve para ventanas nuevas o recargadas;
responder una ya resuelta da `ask_gone`. Sin ventanas abiertas se registra un
aviso del Control Center y la pregunta sigue pendiente.

## 5. Puente v2

- Token por sesión, rotado en cada lanzamiento (alta, reinicio y
  restauración): un proceso que sobreviva al PTY anterior recibe 401. Token
  de una sesión con el `sesionId` de otra: 403. El 401, el 405 y el 503 se
  deciden en el hilo aceptador y los responde un grupo fijo de 4 hilos.
- Cupos: 32 peticiones de control, 64 de `/v1/events`, 128 sondeos largos en
  total (`CUPO_SONDEOS`) y 4 por sesión; el exceso, 503.
- `POST /v1/hello {protocol:2, claudeSessionId, transcriptPath?, source}` →
  `{ok, protocol:2, generation, launchPermissionMode}` (`interceptPanels` y el evento `panel` se retiraron el 2026-10-17: no tenían productor).
  Sin `protocol`: protocolo 1 (ask bloqueante). `claudeSessionId`, si
  viene, es un UUID con guiones (36 caracteres); si no, 400 sin tocar el
  registro. El mod manda además
  `instanceId` (aleatorio por proceso, estable entre `/clear` y `/resume`) y
  `helloSeq` (monótono por proceso). Un `hello` `start` de otra instancia con
  otro `claudeSessionId` en el PTY del dueño (un `claude` hijo que heredó las
  variables del puente) es 409 y esa instancia queda vetada para cualquier
  `source`; el veto es del proceso, no del sid, así que el dueño puede hacer
  `/resume` de ese sid. Con dueño en el PTY solo se acepta su sid (recarga
  del mod): un `hello` de otra instancia sin `claudeSessionId` también es
  409 con veto, y no repunta el transcript ni sube la generación. Un reintento con el `helloSeq` aceptado devuelve la
  misma generación sin reaplicarse; uno anterior, `{ok, superseded:true,
  generation}` sin aplicarse ni rechazar. Sin `instanceId` (mod anterior),
  cualquier `hello` que cambie el sid del dueño es 409 («actualiza
  ultron-puente»): el mod y la app se publican juntos. Los `hello` de una
  sesión se procesan en serie de principio a fin (veredicto, registro,
  generación, buzón y señal). El mod trata el 409 como rechazo
  permanente: sin eventos, sin `hello` de `/clear` o de turno y sin preguntas
  a la ventana; un anuncio sustituido lo abandona en silencio. El primer
  rechazo de cada instancia vetada emite `sesiones://notice` (`warn`) a la
  sesión: «Otro claude se ha arrancado dentro de esta sesión y su puente se
  ha rechazado…». Un lock del estado del puente envenenado se recupera con
  su último dato válido: el veto, la generación y el `seq` nunca fallan en
  abierto.
- `POST /v1/events {generation, events[]}`: `seq` por generación (repetidos
  descartados), tipos desconocidos ignorados, lotes de una generación vieja
  `{stale, generation}` (el mod los reenvía renumerados). Generación 0 con un
  `hello` ya aceptado: 409 (lote de un `claude` sin `hello` aceptado). Con
  protocolo 2, un lote sin `generation` cuenta como generación 0. El
  `turnEnd` de un subagente (`agentId`) lleva `model?`, el de sus
  `turn.step`; sin él, su uso se valora con el modelo de la sesión.
- `POST /v1/ask {async:true}` → `{askId}`, o 429 con 32 asks pendientes en
  la sesión (`MAX_ASKS_SESION`); `POST /v1/ask/wait {generation, askIds}`
  multiplexado (20 s) → `{results}` o `{stale:true}`, y un `askId` de otra
  sesión sale `cancelled{unknown}`; `POST /v1/ask/cancel` → `modAborted`.
- `POST /v1/inbox {generation}` (20 s) → `{ops}` con todas las operaciones
  sin resultado o `{stale:true}`; `POST /v1/result {sesionId, opId, ok,
  value?, error?}` idempotente, `sesionId` obligatorio (400 si falta) y solo
  resuelve operaciones de esa sesión; caducidad a 10 min (5 s para
  `turn.abort`; 3 s para `prompt.read` y `prompt.clear`) con
  `sesiones://op-result` (salvo `prompt.read`/`prompt.clear`, internas de
  G3, que no se emiten). Cada operación lleva `expiresAt` (ms desde la época
  UNIX): el mod no ejecuta una vencida y la contesta `ok:false` («caducada»);
  sin el campo, la ejecuta.
- `POST /v1/fill` → `sesiones://composer-fill`.
- Texto en vivo con `step` y `block`; `sesiones://stream-matched` cuando el
  bloque del transcript coincide exactamente con la entrada en vivo.

## 6. Ajustes

`SessionPrefs` vive en los datos locales de la app; su modo de lanzamiento se
calcula una vez desde `claude_safe_mode` al crear el fichero. Modelo, effort
y modo rápido se aplican como comando (el effort solo cambia si el texto
devuelto lo confirma). `/config` (filas y cambios) y `$.session.usage()`
exigen el puente v2 y fallan de forma explícita sin él. CLAUDE.md y reglas de
permisos de los tres settings, en solo lectura.

## 7. Historial paginado (sesiones largas)

Un transcript de días pesa 50-200 MB; nunca viaja entero por IPC.

- `sesiones_history(id, agentId?, beforeUuid?, limit?) -> HistoryPage`, con
  `HistoryPage { messages: ChatMessage[], hasMore: bool }` (camelCase en el
  cable). `limit` por defecto 400, recortado a [1, 2000].
- Página = los últimos `limit` mensajes estrictamente anteriores a
  `beforeUuid` (sin él, hasta el final). El inicio retrocede hasta el primer
  mensaje `kind: prompt` anterior, como mucho otros `limit` mensajes, para no
  partir un turno. `hasMore` = quedan mensajes antes del inicio.
- Tope de 2 MB de JSON por página: si los mensajes pesan más (capturas en
  base64 de los `toolResult`), la página se corta antes y `hasMore` sigue
  en `true`. Medido con un transcript real de 76 MB: primera página de 72
  mensajes, 1,89 MB, 188 ms (antes, 2.200 mensajes y 34 MB en una llamada).
- `beforeUuid` que no existe en el transcript: error `history_cursor_gone`
  (el cliente recarga desde el final).
- Los `input` de `toolUse` se recortan como los `toolResult`
  (`TOOL_RESULT_MAX_CHARS` por cadena, con la marca de recorte), en el
  historial y en vivo.
- Cliente: carga inicial = última página; al llegar arriba del chat pide la
  anterior con el `uuid` del primer mensaje y la antepone sin mover el
  scroll. En vivo, por encima de 1500 mensajes en memoria se sueltan los más
  antiguos hasta 1200 y `hasMore` pasa a `true`. Cada carga lleva la
  generación de la conversación (`claudeSessionId`); una respuesta de una
  generación anterior (llega tras `sesiones://reset`) se descarta.
- Caché de parseo en el backend: hasta 2 transcripts (clave ruta, agente,
  tamaño y mtime); cada entrada se suelta a los 90 s sin uso y un transcript
  que deje la suma por encima de 128 MB no se guarda.
- La primera página del hilo principal (sin `agentId` ni `beforeUuid`)
  entrega antes las notas pendientes de la restauración (§8).
- Seguidor: una sesión nueva (`Arranque::Nueva`, `historia_esperada =
  false`) solo da por historia copiada una respuesta del asistente anterior
  a la creación del fichero (un `/branch` dentro de la TUI sigue cubierto);
  en una reanudada, la historia previa se da por copiada.

## 8. Sesiones abiertas y arranque (#35)

- `~/.ultron/cockpit/sesiones/abiertas.json`: `{version: 1, sesiones: [{id,
  projectId, cwd, title, titleAuto, titleSource, claudeSessionId, transcript, model,
  launchPermissionMode, startedAt, config: {cwd, projectId, model, effort,
  permissionMode} | null, cola: [{clientId, text, attachments, delegate,
  kind, origin, state: queued | failed, createdAt, error}]}]}`. No lleva
  `status`, `lastActivityAt` ni `settingsFile`. Un `sending` o un `cliQueued`
  (la cola nativa vive en la memoria del proceso `claude`, que muere al
  cerrar ULTRON) se guarda como `queued` con el error «Se estaba enviando
  cuando se cerró ULTRON: al restaurar se comprueba en el transcript si
  llegó.»; `absorbed` y `delivered` no se guardan.
- Título (`titulo.rs`, `titleSource`: `provisional | prompt | ia | manual |
  legado`): «Nueva sesión»/«Reanudada …» hasta el primer prompt, que pone su
  primera línea; el resumen que Claude Code escribe en el transcript
  (`{"type":"ai-title","aiTitle":…}`, histórico o vivo, solo del hilo
  principal) lo sustituye. Al cambiar de transcript (`/clear`, otra
  conversación) un título automático vuelve a `provisional`: se ve el
  anterior hasta que el primer prompt y el resumen de la nueva lo
  sustituyen, y el lote pendiente del transcript viejo se descarta con su
  cursor (hallazgo de Codex del 2026-10-23); renombrar a mano
  (`sesiones_rename`) lo fija y nada lo pisa. `titleAuto` se sigue escribiendo
  (`true` solo en `provisional`) para las versiones anteriores; un fichero sin
  `titleSource` y con `titleAuto: false` se carga como `legado`, que se
  resuelve con el primer prompt del transcript: si el título coincide con el
  suyo pasa a `prompt` y si no, a `manual`.
- Escritura atómica (tmp + rename) tras 500 ms de calma (3 s como máximo) y
  solo si cambia el contenido. Al salir de ULTRON (`RunEvent::Exit`, antes
  de matar los PTY) se vuelca en el acto, sin esperar la calma; si el hilo
  escritor está a mitad de una escritura, se espera como mucho 200 ms. Sin
  escritor activo no se escribe. No se escribe nada hasta haber leído el
  fichero en el arranque. `sesiones_kill` quita la sesión del fichero; una
  sesión `exited` que sigue en la lista se guarda y se relanza. Si la
  proyección no se puede calcular (registro o cola envenenados), no se
  escribe nada, se conserva el fichero anterior y el Control Center recibe un
  aviso una sola vez: una proyección vacía por error nunca sustituye a la
  guardada.
- Arranque: cada sesión guardada se da de alta con su mismo id (`starting`,
  `historia_esperada`), su cola repuesta y su `Config` con los settings
  regenerados, y se relanza con `claude --resume <sid>` en su cwd, de una en
  una. Si el relanzamiento falla, queda `exited` con su cola y una nota que
  pide usar Reiniciar. El frontend carga la cola también de las `exited`.
- Envíos en vuelo: un error que empiece por «Se estaba enviando cuando se
  cerró ULTRON» (también el texto anterior) se cruza con el último prompt o
  `<bash-input>` del hilo principal en los últimos 4 MiB del transcript,
  con `normalizar_envio`. Si es igual o lo contiene entero, no se repone (ya
  llegó); si el último mensaje es otro y solo había uno en vuelo, se repone como
  `queued` sin error; si no se puede comprobar (transcript ilegible o sin
  prompts en ese tramo, `kind: command`, varios en vuelo o un último prompt que
  solo comparte 32 caracteres de prefijo, como en la cola en vivo), como `queued`
  con «Se estaba enviando cuando se cerró ULTRON y no se ha podido comprobar
  en el transcript si llegó: saldrá otra vez en cuanto la sesión quede
  libre.», que no se vuelve a cruzar en arranques siguientes. Lo repuesto lo
  drena la máquina al llegar a `idle`, salvo con el turno a medias: entonces
  la cola queda retenida (`queuePause.reason = interrupted`) para no salir por
  delante de la continuación que ofrece el composer. La fila de la cola muestra
  el `error` también en los `queued`.
- No se restauran (aviso del Control Center con el título, el motivo y
  cuántos mensajes de cola se pierden): sin `claudeSessionId` válido, sin
  carpeta, sin `<sid>.jsonl`, o con la conversación ya abierta en otra
  sesión o repetida en el fichero. Las de causa pasajera (carpeta de trabajo
  o carpeta de transcripts inaccesibles: una unidad sin montar) se apartan
  con su cola en `abiertas.descartadas.json`, junto a `abiertas.json` y con
  su formato, y el aviso da esa ruta; se reintentan en cada arranque, salen
  del fichero al restaurarse y se borra cuando queda vacío. Sin `<sid>.jsonl`
  con la carpeta de transcripts accesible, la conversación no llegó a empezar
  (Claude Code escribe el transcript con el primer mensaje): descarte
  definitivo, que no avisa si tampoco hay cola (igual que sin
  `claudeSessionId`), solo queda en el log. JSON no válido o versión distinta de 1:
  se renombra a `abiertas.json.bad` (o `abiertas.<ms>.json.bad`) y se
  arranca sin sesiones. Si existe pero no se puede leer, no se toca y esa
  ejecución no guarda nada.
- Notas (`sesiones://notice`): la del chat dice cuántos mensajes vuelven a la
  cola y cuántos envíos ya constaban en el transcript, no llegaron o no se
  pudieron comprobar. Si la cola guardada no se puede reponer, una nota de
  nivel `error` en el chat (y un aviso del Control Center) dice cuántos
  mensajes no entraron; el fichero los conserva. Las pendientes se entregan en la primera página de
  `sesiones_history`; después, una nota nueva de esa sesión (el fallo del
  relanzamiento) se emite en el acto si hay una ventana de Sessions abierta
  y, si no, espera a la siguiente primera página. `sesiones_kill` olvida las
  notas y la marca de entrega.

## 9. Tarjeta de `Workflow` en el chat

La llamada `Workflow` de Claude Code (ultracode) se pinta con su fila de
herramienta y, debajo, una tarjeta en vivo del run (`WorkflowCard.tsx`).

- **Evento** `sesiones://workflow` `{ id, run: WorkflowRun }`: lo emite el
  seguidor de transcripts (`workflows_seguidor.rs`, como mucho cada 500 ms
  por sesión) solo cuando el run cambia. Un run cerrado hace más de 120 s se
  revisa cada 10 s por si se reanuda.
- **Comando** `sesiones_workflows(id) -> WorkflowRun[]`: la foto del
  seguidor o, si aún no la hay, una reconstrucción completa desde el disco.
  El cliente lo pide al montar el chat principal y tras `sesiones://reset`;
  lo recibido en vivo manda sobre la lista.
- **`WorkflowRun`**: `runId`, `name`, `description`, `status`
  (`running|completed|failed|killed|stopped`), `startedAt`/`endedAt`/
  `durationMs` (ms), `phases[]` (`title`, `detail`, `total`, `done`,
  `failed`, `running`), `agents[]` (`key`, `agentId`, `label`, `phase`,
  `status` `running|done|failed|cached|stopped`, `attempt`, `agentType`,
  `model`, tiempos, `contextTokens`, `toolCalls`, `lastActivity`,
  `resultPreview`), `totalTokens`, `totalToolCalls`, `resultPreview` (≤ 600
  caracteres) y `error` (primera línea).
- **Fuentes** (formato interno de Claude Code, sin documentar): el journal
  `subagents/workflows/<runId>/journal.jsonl` (sin marcas de tiempo; un
  reintento repite `started` con la misma clave y otro agente; `failed` sin
  motivo; sin evento de fin), `agent-<id>.meta.json` y `agent-<id>.jsonl`
  (tiempos, último uso por `message.id` y última herramienta), el `meta` del
  script `workflows/scripts/<nombre>-<runId>.js` (leído sin evaluar JS) y
  `workflows/<runId>.json`, que solo existe al terminar y cuenta si no es más
  viejo que el journal (un `resumeFromRunId` reutiliza el runId).
- **Fin sin JSON final**: con la sesión cerrada, o con un journal sin tocar
  desde que arrancó el proceso actual de Claude, el run pasa a `stopped`. En
  el cliente, la `<task-notification>` de la llamada (`<tool-use-id>` y
  `<status>`) corrige un run que el disco aún da por en curso.
- **Sin run**: con la lista cargada y el runId ausente, el chat avisa de que
  no está en disco; sin lista, en un hilo de subagente o sin `Run ID`, queda
  la fila normal.
- Fuera de alcance: abortar un run desde la tarjeta, agentes `skipped` (solo
  existen como agregado en la notificación) y `Workflow` lanzados por
  subagentes.
