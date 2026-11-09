# ultron-puente: spikes del protocolo 2 (contrato de estabilidad 2026-10-08, §8.5 paso 0)

Estado de cada supuesto [S] del contrato que toca al mod. «Kit» = `claude plugin test` (CLI 2.1.293 al escribirlo;
repasado con la 2.1.309 el 2026-10-23: 74 pruebas en verde); «real» = una sesión de Claude Code de verdad bajo ULTRON
Sessions.

> Revisión del 2026-10-23: ninguna fila «sin verificar» se ha verificado en real todavía; siguen como supuestos con
> su reserva. La captura de `$.command.list()` sigue pendiente, así que el fixture
> `control-center/src-tauri/src/sesiones/fixtures/commands-2.1.293.json` (lo usa `sesiones/tests_catalogo.rs`)
> continúa marcado como provisional y describe la CLI 2.1.293, no la 2.1.309 instalada.

| Supuesto | Resultado | Evidencia | Consecuencia |
|---|---|---|---|
| El hook `prompt.fill` del puente ve los `$.prompt.fill` de otros mods | Sí (kit) | `tests/hooks.test.ts`, «prompt.fill de otro mod» con un plugin en línea | No se activa la reserva `ULTRON_SESIONES` en los mods de ULTRON |
| El hook `ui.open` del puente ve los `$.ui.open` de otros mods y puede quitar `focus` o denegar | Sí (kit) | `tests/hooks.test.ts`, «ui.open de otro mod»: el fondo recibe la apertura sin `focus`; la automática vuelve con `deny` | Igual que la fila anterior |
| Los hooks `ui.toast`, `ui.log`, `ui.status` y `prompt.suggest` del puente ven los avisos de otros mods | Sí en el kit; sin verificar en real | `tests/hooks.test.ts`, «avisos de otro mod» | Si en real no llegan, `ultron-cierre` vuelve a ser un no-op en Sessions: comprobarlo con un turno que deje ficheros sin commitear |
| `classic.*` convive con `classic.SessionStart` y `classic.PermissionRequest` registrados aparte | Sí (kit y `claude plugin validate`) | 74 pruebas en verde (2026-10-23; eran 60 el 2026-10-08); el validador lista los tres registros | — |
| `$.state` sobrevive a un segundo `session.start` (lo que dispara una recarga) | Sí (kit) | `tests/buzon.test.ts`, «recarga simulada» y «en curso de la generación 1» | El buzón no repite efectos tras recargar |
| `$.command.run` y `$.config.*` desde `$.clock.after` (fuera de un hook) | Sí en el kit; sin verificar en real | `tests/buzon.test.ts` (el buzón corre en temporizadores) | Si falla en real, el backend cae a su reserva por PTY (§2.2) |
| `$.turn.abort` con la cola nativa llena y su `turn.complete{aborted}` | Sin verificar | Requiere una sesión real con turno en curso | El backend conserva la reserva Esc/Ctrl+C (§3.3, WP-PTY) |
| `classic.SessionStart{source:clear}` tras `/clear` y `{resume}` tras `/resume` | Sin verificar en real; cubierto en el kit | `tests/hooks.test.ts`, «/clear» | Segunda red ya implementada: `turn.start` repite el `hello` (`source:"turn"`) si cambia `$.session.id()` |
| `$.http.fetch` mantiene 20 s de sondeo largo | Sin verificar | Necesita un servidor que tarde 20 s y una sesión viva | Si el host corta antes, el sondeo vuelve con error y el mod reintenta (inbox a los 2 s; `wait` cuenta el fallo): el backend debe bajar la espera a 10 s |
| Captura de `$.command.list()` en `SPIKES/commands-2.1.293.json` | **No capturada** | Un `claude -p` con un plugin de captura dispara los hooks `SessionEnd` del usuario (bitácora, memoria); con `disableAllHooks` no cargan los mods; la ejecución consumió presupuesto de API | La captura queda para la pasada real (§9.3): abrir una sesión en Sessions con el puente y guardar `$.command.list()` |

## Presupuesto del hook y sondeo multiplexado

`HookBudget` (index.d.ts, l. 5060-5096) para el reloj del hook solo mientras **ese** hook tiene una llamada `$` en
vuelo. Un hook que espera una promesa resuelta por el sondeo de otro hook consume su presupuesto. Por eso
`hooks/asks.ts` hace el sondeo `wait` siempre con el `$` de uno de los hooks que esperan (un solo sondeo en vuelo en el
caso normal) y, si otro hook que espera baja de 4 s de presupuesto, lanza su propio sondeo multiplexado. Con
preguntas en paralelo durante más de ~6 s puede haber dos sondeos `wait` a la vez (más el `inbox`): dentro del cupo de
4 por sesión del §6.1.

## Desviaciones del contrato

- Interceptación de paneles (§2.2, `setIntercept`, evento `panel`): retirada por el «CAMBIO DE DISEÑO» del contrato
  (los menús se manejan en el chat). `command.run` siempre llama a `next(e)`; `commandEnd.intercepted` es siempre
  `false`; la operación `setIntercept` responde `ok:false` con el motivo.
- `commands.items[].immediate` no se envía: `$.command.list()` no lo expone; el backend lo toma de `MOD_META`.
- Reintento de lotes: 0,5 s, 1 s, 2 s y después cada 2 s mientras el backend no responda (no hay tope de intentos).
