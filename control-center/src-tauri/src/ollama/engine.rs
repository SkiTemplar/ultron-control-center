// ULTRON Control Center — Ollama: cambio de motor del editor, compartido.
//
// Unico mando del autocompletado: el motor del editor (`ollamaTab.engine`,
// ver `editor.rs`). Lo usan el comando `editor_engine_set` (AI Router >
// Modelo local) y el item de la bandeja (`tray.rs`), así que la logica vive
// aqui una sola vez:
//
//   - `set_engine_blocking` / `toggle_engine_blocking`: toman el guard de
//     concurrencia (`toggle::try_acquire_busy`) y aplican la secuencia de
//     `switch.rs` (verificacion previa, escritura del settings.json de VS
//     Code, liberar la VRAM salvo el destino, cargar, revertir si falla y
//     guardar el ultimo motor local) contra el I/O real. Bloqueantes:
//     llamar desde un hilo de fondo.
//   - `current_reference`: motor local de referencia y su modelo (el activo
//     si es local; si no, el ultimo local; si no, `mid`).
//   - `active_local_model`: modelo del motor local activo y su plazo de
//     residencia, para que el AI Router no lo suelte de VRAM al usarlo.
//   - Funciones puras de la bandeja (`tray_next_engine`, `tray_view`).

use super::config;
use super::editor::{self, EditorEngineStatus};
use super::switch::{self, EngineBackend};
use super::toggle;

pub const BUSY_ERROR: &str = "hay otra accion de Ollama en curso — espera a que termine";

/// `EngineBackend` contra VS Code, Ollama y `config.json` reales.
struct LiveBackend;

impl EngineBackend for LiveBackend {
    fn editor_status(&self) -> EditorEngineStatus {
        editor::status()
    }
    fn write_engine(&self, engine: &str) -> Result<(), String> {
        editor::write_engine(engine).map(|_| ())
    }
    fn ensure_server(&self) -> Result<(), String> {
        toggle::ensure_server_running()
    }
    fn downloaded_models(&self) -> Result<Vec<String>, String> {
        toggle::downloaded_model_names()
    }
    fn loaded_models(&self) -> Result<Vec<String>, String> {
        toggle::loaded_model_names()
    }
    fn load(&self, model: &str, keep_alive: &str) -> Result<(), String> {
        toggle::activate(model, keep_alive)
    }
    fn unload(&self, model: &str) -> Result<(), String> {
        toggle::deactivate(model)
    }
    fn persist_last_local(&self, engine: &str) -> Result<(), String> {
        config::write_last_local_engine(engine)
    }
}

/// Cambia el motor del editor a `engine`. Devuelve el estado del motor ya
/// actualizado.
pub fn set_engine_blocking(engine: &str) -> Result<EditorEngineStatus, String> {
    let _guard = toggle::try_acquire_busy().ok_or_else(|| BUSY_ERROR.to_string())?;
    switch::apply_engine(&LiveBackend, engine)
}

/// Clic de la bandeja: decide el motor siguiente (`tray_next_engine`) con el
/// estado leido DESPUES de tomar el guard, para no decidir sobre un motor
/// que otra accion estaba cambiando.
pub fn toggle_engine_blocking() -> Result<EditorEngineStatus, String> {
    let _guard = toggle::try_acquire_busy().ok_or_else(|| BUSY_ERROR.to_string())?;
    let current = editor::status().engine;
    let next = tray_next_engine(&current, config::read_last_local_engine());
    switch::apply_engine(&LiveBackend, next)
}

/// Modelo del motor local activo y su plazo de residencia (`keep_alive`);
/// `None` con Copilot, apagado o sin settings.json. El AI Router lo usa para
/// no soltar de VRAM el modelo del autocompletado al despacharle algo.
pub fn active_local_model() -> Option<(String, String)> {
    let status = editor::status();
    if !status.available {
        return None;
    }
    let keep_alive = status.keep_alive(&status.engine);
    status.active_model.map(|model| (model, keep_alive))
}

/// Motor local de referencia y su modelo, a partir del estado del editor y
/// del ultimo motor local persistido. Puro.
pub fn reference_of(
    status: &EditorEngineStatus,
    last_local: Option<&str>,
) -> (&'static str, String) {
    let engine = editor::reference_local_engine(&status.engine, last_local);
    let model = status.model_for(engine).unwrap_or_default().to_string();
    (engine, model)
}

/// `reference_of` contra el disco (settings.json de VS Code + config.json).
pub fn current_reference() -> (&'static str, String) {
    reference_of(&editor::status(), config::read_last_local_engine())
}

// ---------------------------------------------------------------------------
// Bandeja (puro, testeable)
// ---------------------------------------------------------------------------

/// Motor al que lleva un clic en la bandeja: un motor local pasa a Copilot;
/// Copilot o apagado vuelven al ultimo motor local (por defecto `mid`).
pub fn tray_next_engine(current: &str, last_local: Option<&str>) -> &'static str {
    if editor::is_local_engine(current) {
        return "copilot";
    }
    last_local
        .and_then(editor::as_local_engine)
        .unwrap_or(editor::DEFAULT_LOCAL_ENGINE)
}

/// Texto, marca y habilitacion del item de la bandeja.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    pub label: String,
    pub checked: bool,
    pub enabled: bool,
}

impl TrayView {
    /// Mientras se cambia de motor: deshabilitado para no lanzar dos
    /// acciones a la vez.
    pub fn busy() -> Self {
        TrayView {
            label: "Autocompletado: cambiando…".to_string(),
            checked: false,
            enabled: false,
        }
    }
}

/// Vista del item para el estado del editor. `loaded` = el modelo del motor
/// activo esta cargado en Ollama (solo cuenta si el motor es local).
pub fn tray_view(status: &EditorEngineStatus, loaded: bool) -> TrayView {
    if !status.available {
        return TrayView {
            label: "Autocompletado: VS Code no encontrado".to_string(),
            checked: false,
            enabled: false,
        };
    }
    let (label, checked) = match status.model_for(&status.engine) {
        Some(model) => (
            format!("Autocompletado: {} local", editor::model_size_label(model)),
            loaded,
        ),
        None if status.engine == "copilot" => ("Autocompletado: Copilot".to_string(), false),
        None => ("Autocompletado: apagado".to_string(), false),
    };
    TrayView {
        label,
        checked,
        enabled: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(engine: &str) -> EditorEngineStatus {
        EditorEngineStatus {
            available: true,
            engine: engine.to_string(),
            model_low: "qwen2.5-coder:1.5b-base".to_string(),
            model_mid: "qwen2.5-coder:3b-base".to_string(),
            model_high: "qwen2.5-coder:7b-base".to_string(),
            active_model: None,
            settings_path: None,
            keep_alive_override: None,
        }
    }

    #[test]
    fn tray_next_engine_lleva_cualquier_motor_local_a_copilot() {
        for current in ["low", "mid", "high"] {
            assert_eq!(
                tray_next_engine(current, Some("high")),
                "copilot",
                "{current}"
            );
            assert_eq!(tray_next_engine(current, None), "copilot", "{current}");
        }
    }

    #[test]
    fn tray_next_engine_vuelve_al_ultimo_motor_local() {
        assert_eq!(tray_next_engine("copilot", Some("high")), "high");
        assert_eq!(tray_next_engine("off", Some("low")), "low");
    }

    #[test]
    fn tray_next_engine_usa_mid_sin_ultimo_motor_local() {
        assert_eq!(tray_next_engine("copilot", None), "mid");
        assert_eq!(tray_next_engine("off", None), "mid");
    }

    /// Caso negativo: un ultimo motor que no es local (fichero manipulado)
    /// nunca devuelve Copilot/apagado desde Copilot/apagado, que seria un
    /// clic sin efecto.
    #[test]
    fn tray_next_engine_ignora_un_ultimo_motor_no_local() {
        assert_eq!(tray_next_engine("copilot", Some("copilot")), "mid");
        assert_eq!(tray_next_engine("off", Some("off")), "mid");
        assert_eq!(tray_next_engine("copilot", Some("turbo")), "mid");
    }

    #[test]
    fn tray_view_nombra_el_tamano_y_marca_solo_si_esta_cargado() {
        let view = tray_view(&status("mid"), true);
        assert_eq!(view.label, "Autocompletado: 3b local");
        assert!(view.checked && view.enabled);

        let view = tray_view(&status("low"), false);
        assert_eq!(view.label, "Autocompletado: 1.5b local");
        assert!(!view.checked);
    }

    /// Caso negativo: Copilot o apagado nunca salen marcados aunque haya un
    /// modelo local cargado por otra via.
    #[test]
    fn tray_view_copilot_y_apagado_no_se_marcan() {
        let view = tray_view(&status("copilot"), true);
        assert_eq!(view.label, "Autocompletado: Copilot");
        assert!(!view.checked);

        let view = tray_view(&status("off"), true);
        assert_eq!(view.label, "Autocompletado: apagado");
        assert!(!view.checked);
    }

    #[test]
    fn tray_view_sin_vscode_queda_deshabilitado() {
        let mut s = status("mid");
        s.available = false;
        let view = tray_view(&s, true);
        assert!(!view.enabled && !view.checked);
    }

    #[test]
    fn reference_of_usa_el_motor_activo_o_el_ultimo_local() {
        assert_eq!(
            reference_of(&status("high"), Some("low")),
            ("high", "qwen2.5-coder:7b-base".to_string())
        );
        assert_eq!(
            reference_of(&status("copilot"), Some("low")),
            ("low", "qwen2.5-coder:1.5b-base".to_string())
        );
        assert_eq!(
            reference_of(&status("off"), None),
            ("mid", "qwen2.5-coder:3b-base".to_string())
        );
    }
}
