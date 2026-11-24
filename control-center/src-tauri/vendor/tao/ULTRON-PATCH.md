# tao 0.35.2 parcheado

Copia de `tao` 0.35.2 (crates.io) con dos cambios locales en el backend de Windows. Cada
uno lleva un comentario `ULTRON (parche de 0.35.2)` en el código.

## 1. Bloqueo al reiniciarse el Explorador

`src/platform_impl/windows/event_loop.rs`, rama `S_U_TASKBAR_RESTART`.

**Fallo:** al reiniciarse el Explorador, Windows difunde `TaskbarCreated` y tao vuelve a aplicar
`skip_taskbar` con el lock de `window_state` tomado. `ITaskbarList::AddTab` o `DeleteTab` hacen
un `SendMessage` a la misma ventana; el procedimiento reentrante pide el mismo lock
(`parking_lot`, no reentrante) y el hilo de la UI queda bloqueado para siempre. Diagnosticado
el 2026-10-28 con un volcado de `control-center.exe` (cdb: `TaskbarList::DeleteTab` →
`SendMessageW` → `RawMutex::lock_slow`).

**Arreglo:** el mismo de tao 0.37 (rama `dev`): se copia `skip_taskbar`, se suelta el lock y
solo se llama si la ventana debe ir sin botón.

## 2. Pánico `cannot move state from Destroyed` al apagar Windows

`src/platform_impl/windows/event_loop/runner.rs`, `send_event` y `move_state_to`.

**Fallo:** al apagar Windows, `WM_ENDSESSION` llama a `loop_destroyed` y el runner pasa a
`Destroyed`. Antes de que el proceso termine siguen llegando mensajes (repintados, eventos de
otros hilos); `send_event` intentaba volver a `HandlingMainEvents` y `move_state_to` hacía
`panic!`. El pánico ocurre dentro del procedimiento de ventana (`extern "system"`), no puede
propagarse y el proceso aborta. `panic.log` lo registraba en casi cada cierre de la app y en
los apagados del 2026-11-19, 2026-11-22 y 2026-11-23 (1-2 s después del evento 1074).
Igual en tao 0.35.3.

**Arreglo:** `send_event` descarta los eventos con el runner en `Destroyed` y la transición
desde `Destroyed` se ignora en lugar de entrar en pánico. Tests en `runner.rs`
(`ultron_tests`), con caso negativo; como tao no es miembro del workspace, se ejecutan
aparte:

```bash
CARGO_TARGET_DIR=<dir temporal> cargo test --manifest-path vendor/tao/Cargo.toml --lib ultron_tests
```

## Retirada

El cambio 1 se elimina al subir a un tauri con tao >= 0.37. El cambio 2 hay que comprobarlo
en la versión nueva antes de quitar este directorio y el `[patch.crates-io]` de `Cargo.toml`.
