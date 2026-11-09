// Guarda del parche de tao (vendor/tao/ULTRON-PATCH.md): con tao 0.35.2 sin
// parchear, la app entera se cuelga cada vez que se reinicia el Explorador
// (interbloqueo en TaskbarCreated). La verificación de comportamiento es
// manual (reiniciar el Explorador con la app abierta y comprobar que responde);
// esto impide perder el parche sin enterarse al revendorizar o al tocar el
// [patch.crates-io].

const CARGO_TOML: &str = include_str!("../Cargo.toml");
const EVENT_LOOP: &str = include_str!("../vendor/tao/src/platform_impl/windows/event_loop.rs");

#[test]
fn tao_se_compila_desde_la_copia_parcheada() {
    assert!(
        CARGO_TOML.contains("[patch.crates-io]")
            && CARGO_TOML.contains(r#"tao = { path = "vendor/tao" }"#),
        "falta el [patch.crates-io] de tao en Cargo.toml"
    );
}

#[test]
fn taskbar_created_suelta_el_lock_antes_de_itaskbarlist() {
    let rama = EVENT_LOOP
        .split("msg == *S_U_TASKBAR_RESTART")
        .nth(1)
        .expect("rama S_U_TASKBAR_RESTART en event_loop.rs");
    let rama = &rama[..rama.find("\n      }\n").unwrap_or(rama.len())];
    assert!(
        rama.contains("let skip_taskbar = subclass_input.window_state.lock().skip_taskbar;"),
        "el lock de window_state debe soltarse en la misma sentencia"
    );
    assert!(
        !rama.contains("let window_state = subclass_input.window_state.lock();"),
        "volvió el interbloqueo: lock vivo durante set_skip_taskbar"
    );
}
