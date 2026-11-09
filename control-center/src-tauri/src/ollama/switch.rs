// ULTRON Control Center — Ollama: orquestacion del cambio de motor.
//
// Secuencia de `engine::set_engine_blocking`, separada del I/O real tras el
// trait `EngineBackend` para poder probarla con un doble en memoria:
//
//   1. Verificacion previa (solo motor local): el servidor arranca y el
//      modelo del motor esta descargado (`/api/tags`). Si falla, NO se toca
//      el settings.json: el editor sigue con el motor que tenia.
//   2. Se escribe el motor en el settings.json de VS Code.
//   3. Se suelta TODO lo que `/api/ps` tenga cargado salvo el modelo
//      destino (Copilot y apagado liberan la VRAM entera, no solo los tres
//      modelos configurados) y se carga el destino. Soltar primero y cargar
//      despues: con 8 GB de VRAM, al reves caben los dos a la vez.
//   4. Si el paso 3 falla, se revierte el settings.json al motor anterior,
//      se intenta recargar su modelo y se devuelve el error (con lo que no
//      se haya podido restaurar, si algo falla tambien ahi).
//   5. Si el motor es local, se guarda como ultimo motor local.

use super::editor::{self, EditorEngineStatus};

/// Operaciones de I/O que necesita el cambio de motor.
pub trait EngineBackend {
    fn editor_status(&self) -> EditorEngineStatus;
    fn write_engine(&self, engine: &str) -> Result<(), String>;
    fn ensure_server(&self) -> Result<(), String>;
    fn downloaded_models(&self) -> Result<Vec<String>, String>;
    fn loaded_models(&self) -> Result<Vec<String>, String>;
    fn load(&self, model: &str, keep_alive: &str) -> Result<(), String>;
    fn unload(&self, model: &str) -> Result<(), String>;
    fn persist_last_local(&self, engine: &str) -> Result<(), String>;
}

/// Ollama trata un nombre sin tag como `:latest`.
fn normalized(model: &str) -> String {
    let after_namespace = model.rsplit('/').next().unwrap_or(model);
    if after_namespace.contains(':') {
        model.to_string()
    } else {
        format!("{model}:latest")
    }
}

/// `true` si `a` y `b` nombran el mismo modelo de Ollama.
pub fn same_model(a: &str, b: &str) -> bool {
    normalized(a) == normalized(b)
}

/// Error si `model` no esta entre los descargados.
pub fn check_downloaded(model: &str, downloaded: &[String]) -> Result<(), String> {
    if downloaded.iter().any(|d| same_model(d, model)) {
        Ok(())
    } else {
        Err(format!(
            "el modelo '{model}' no esta descargado — descargalo en AI Router > Modelo local \
             antes de elegir este motor"
        ))
    }
}

/// Modelos a soltar: todo lo cargado salvo el destino.
pub fn models_to_unload(loaded: &[String], target: Option<&str>) -> Vec<String> {
    loaded
        .iter()
        .filter(|m| target.is_none_or(|t| !same_model(m, t)))
        .cloned()
        .collect()
}

fn move_models<B: EngineBackend>(
    backend: &B,
    loaded: &[String],
    target: Option<&str>,
    keep_alive: &str,
) -> Result<(), String> {
    for model in models_to_unload(loaded, target) {
        backend.unload(&model)?;
    }
    if let Some(model) = target {
        backend.load(model, keep_alive)?;
    }
    Ok(())
}

/// Revierte el settings.json al motor anterior y recarga su modelo. Devuelve
/// el mensaje de error final, con lo que no se haya podido restaurar.
fn rollback<B: EngineBackend>(backend: &B, before: &EditorEngineStatus, error: &str) -> String {
    let previous = before.engine.as_str();
    let mut message = format!("{error} — se restaura el motor anterior ('{previous}')");
    if let Err(e) = backend.write_engine(previous) {
        message.push_str(&format!("; no se pudo restaurar settings.json: {e}"));
        return message;
    }
    if let Some(model) = before.model_for(previous) {
        if let Err(e) = backend.load(model, &before.keep_alive(previous)) {
            message.push_str(&format!("; no se pudo recargar '{model}': {e}"));
        }
    }
    message
}

/// Cambia el motor siguiendo la secuencia de la cabecera. Sin guard: lo toma
/// el llamador (`engine.rs`).
pub fn apply_engine<B: EngineBackend>(
    backend: &B,
    engine: &str,
) -> Result<EditorEngineStatus, String> {
    if !editor::ENGINES.contains(&engine) {
        return Err(format!("motor invalido: '{engine}'"));
    }
    let before = backend.editor_status();
    if !before.available {
        return Err("no se encontro el settings.json de VS Code".to_string());
    }
    let target = before.model_for(engine).map(str::to_string);
    if let Some(model) = &target {
        backend.ensure_server()?;
        check_downloaded(model, &backend.downloaded_models()?)?;
    }
    let loaded = backend.loaded_models()?;

    backend.write_engine(engine)?;
    if let Err(error) = move_models(
        backend,
        &loaded,
        target.as_deref(),
        &before.keep_alive(engine),
    ) {
        return Err(rollback(backend, &before, &error));
    }
    if editor::is_local_engine(engine) {
        backend.persist_last_local(engine)?;
    }
    Ok(backend.editor_status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Doble en memoria: registra cada llamada y falla donde se le pida.
    struct Fake {
        engine: RefCell<String>,
        downloaded: Vec<String>,
        loaded: RefCell<Vec<String>>,
        fail_load: Option<String>,
        fail_server: bool,
        calls: RefCell<Vec<String>>,
    }

    impl Fake {
        fn new(engine: &str, loaded: &[&str]) -> Self {
            Fake {
                engine: RefCell::new(engine.to_string()),
                downloaded: vec!["m:1b".into(), "m:3b".into(), "m:7b".into()],
                loaded: RefCell::new(loaded.iter().map(|s| s.to_string()).collect()),
                fail_load: None,
                fail_server: false,
                calls: RefCell::new(Vec::new()),
            }
        }
        fn log(&self, entry: String) {
            self.calls.borrow_mut().push(entry);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl EngineBackend for Fake {
        fn editor_status(&self) -> EditorEngineStatus {
            let engine = self.engine.borrow().clone();
            let models = ["m:1b", "m:3b", "m:7b"].map(String::from);
            let (active_model, _) = editor::plan_for(&engine, &models);
            EditorEngineStatus {
                available: true,
                engine,
                model_low: models[0].clone(),
                model_mid: models[1].clone(),
                model_high: models[2].clone(),
                active_model,
                settings_path: None,
                keep_alive_override: None,
            }
        }
        fn write_engine(&self, engine: &str) -> Result<(), String> {
            self.log(format!("write {engine}"));
            *self.engine.borrow_mut() = engine.to_string();
            Ok(())
        }
        fn ensure_server(&self) -> Result<(), String> {
            if self.fail_server {
                return Err("ollama no arranca".into());
            }
            Ok(())
        }
        fn downloaded_models(&self) -> Result<Vec<String>, String> {
            Ok(self.downloaded.clone())
        }
        fn loaded_models(&self) -> Result<Vec<String>, String> {
            Ok(self.loaded.borrow().clone())
        }
        fn load(&self, model: &str, keep_alive: &str) -> Result<(), String> {
            self.log(format!("load {model} {keep_alive}"));
            if self.fail_load.as_deref() == Some(model) {
                return Err(format!("fallo al cargar {model}"));
            }
            self.loaded.borrow_mut().push(model.to_string());
            Ok(())
        }
        fn unload(&self, model: &str) -> Result<(), String> {
            self.log(format!("unload {model}"));
            self.loaded.borrow_mut().retain(|m| m != model);
            Ok(())
        }
        fn persist_last_local(&self, engine: &str) -> Result<(), String> {
            self.log(format!("persist {engine}"));
            Ok(())
        }
    }

    #[test]
    fn same_model_trata_sin_tag_como_latest() {
        assert!(same_model("llama3", "llama3:latest"));
        assert!(same_model("hf.co/u/m", "hf.co/u/m:latest"));
        assert!(!same_model("m:3b", "m:7b"));
    }

    #[test]
    fn models_to_unload_suelta_todo_menos_el_destino() {
        let loaded = vec![
            "m:1b".to_string(),
            "otro:latest".to_string(),
            "m:3b".to_string(),
        ];
        assert_eq!(
            models_to_unload(&loaded, Some("m:3b")),
            vec!["m:1b".to_string(), "otro:latest".to_string()]
        );
        assert_eq!(models_to_unload(&loaded, None), loaded);
    }

    #[test]
    fn check_downloaded_acepta_el_modelo_presente_y_rechaza_el_ausente() {
        let downloaded = vec!["m:3b".to_string()];
        assert!(check_downloaded("m:3b", &downloaded).is_ok());
        let err = check_downloaded("m:7b", &downloaded).unwrap_err();
        assert!(err.contains("no esta descargado"));
    }

    #[test]
    fn local_suelta_lo_ajeno_carga_el_destino_y_persiste() {
        let fake = Fake::new("low", &["m:1b", "chat:latest"]);
        let status = apply_engine(&fake, "mid").expect("cambio a mid");
        assert_eq!(status.engine, "mid");
        assert_eq!(
            fake.calls(),
            vec![
                "write mid",
                "unload m:1b",
                "unload chat:latest",
                "load m:3b 5m",
                "persist mid"
            ]
        );
    }

    /// Copilot y apagado liberan TODO lo cargado, incluido un modelo que no es
    /// ninguno de los tres configurados.
    #[test]
    fn copilot_libera_toda_la_vram_y_no_persiste() {
        let fake = Fake::new("mid", &["m:3b", "m:1b", "chat:latest"]);
        apply_engine(&fake, "copilot").expect("cambio a copilot");
        assert_eq!(
            fake.calls(),
            vec![
                "write copilot",
                "unload m:3b",
                "unload m:1b",
                "unload chat:latest"
            ]
        );
        assert!(fake.loaded.borrow().is_empty());
    }

    /// Caso negativo: modelo no descargado -> error y settings.json intacto.
    #[test]
    fn modelo_no_descargado_no_toca_settings() {
        let mut fake = Fake::new("copilot", &[]);
        fake.downloaded = vec!["m:1b".into()];
        let err = apply_engine(&fake, "high").unwrap_err();
        assert!(err.contains("m:7b"));
        assert!(fake.calls().is_empty(), "{:?}", fake.calls());
        assert_eq!(*fake.engine.borrow(), "copilot");
    }

    /// Caso negativo: servidor que no arranca -> error y settings.json intacto.
    #[test]
    fn servidor_que_no_arranca_no_toca_settings() {
        let mut fake = Fake::new("off", &[]);
        fake.fail_server = true;
        assert!(apply_engine(&fake, "low").is_err());
        assert!(fake.calls().is_empty());
    }

    /// Si la carga falla tras escribir, se revierte al motor anterior, se
    /// recarga su modelo y no se persiste el motor fallido.
    #[test]
    fn carga_fallida_revierte_al_motor_anterior() {
        let mut fake = Fake::new("low", &["m:1b"]);
        fake.fail_load = Some("m:7b".into());
        let err = apply_engine(&fake, "high").unwrap_err();
        assert!(err.contains("fallo al cargar m:7b"));
        assert!(err.contains("se restaura el motor anterior ('low')"));
        assert_eq!(*fake.engine.borrow(), "low");
        assert_eq!(
            fake.calls(),
            vec![
                "write high",
                "unload m:1b",
                "load m:7b 10m",
                "write low",
                "load m:1b 5m"
            ]
        );
    }

    #[test]
    fn motor_invalido_falla_sin_efectos() {
        let fake = Fake::new("low", &["m:1b"]);
        assert!(apply_engine(&fake, "turbo").is_err());
        assert!(fake.calls().is_empty());
    }
}
