# tao 0.35.2 parcheado

Copia de `tao` 0.35.2 (crates.io) con un único cambio en
`src/platform_impl/windows/event_loop.rs`, rama `S_U_TASKBAR_RESTART`.

**Fallo:** al reiniciarse el Explorador, Windows difunde `TaskbarCreated` y tao vuelve a aplicar
`skip_taskbar` con el lock de `window_state` tomado. `ITaskbarList::AddTab` o `DeleteTab` hacen
un `SendMessage` a la misma ventana; el procedimiento reentrante pide el mismo lock
(`parking_lot`, no reentrante) y el hilo de la UI queda bloqueado para siempre. Diagnosticado
el 2026-10-28 con un volcado de `control-center.exe` (cdb: `TaskbarList::DeleteTab` →
`SendMessageW` → `RawMutex::lock_slow`).

**Arreglo:** el mismo de tao 0.37 (rama `dev`): se copia `skip_taskbar`, se suelta el lock y
solo se llama si la ventana debe ir sin botón.

Se elimina este directorio y el `[patch.crates-io]` de `Cargo.toml` al subir a un tauri con
tao >= 0.37.
