// sesiones/uso_motores.rs — Uso de las suscripciones de Codex y agy para la
// pestaña Uso (`sesiones_engines_usage`).
//
// No parsea los rollouts ni `agy /usage`: lanza `scripts/engine-usage.mjs
// --json`, que usa `hooks/scripts/lib/engine-usage.js`, la misma librería que
// la statusline y `usage-outlook.mjs`. Así hay un solo lector. Aquí solo se
// comprueba que la respuesta trae `engines` y se le añaden el saldo de
// DeepSeek y el resumen de delegaciones (`uso_externo`), que se piden en
// paralelo con el script.

use std::time::Duration;

use serde_json::Value;

use super::motores::{self, Program};

const SCRIPT: &str = "scripts/engine-usage.mjs";
/// `agy -p /usage` tarda unos 3-4 s y el script lo corta a los 20 s.
const TOPE: Duration = Duration::from_secs(30);

/// Argumentos del script: `--force` (Actualizar) salta la caché de agy.
pub fn argumentos(force: bool) -> Vec<&'static str> {
    if force {
        vec!["--json", "--force"]
    } else {
        vec!["--json"]
    }
}

/// Respuesta del script: un objeto con la lista `engines`.
pub fn leer_respuesta(stdout: &[u8]) -> Result<Value, String> {
    let v: Value = serde_json::from_slice(stdout)
        .map_err(|e| format!("respuesta del uso de motores ilegible: {e}"))?;
    if !v.get("engines").is_some_and(Value::is_array) {
        return Err("la respuesta del uso de motores no trae 'engines'".into());
    }
    Ok(v)
}

/// Uso de Codex y agy según `scripts/engine-usage.mjs`, más DeepSeek y las
/// delegaciones.
pub fn engines_usage(force: bool) -> Result<Value, String> {
    std::thread::scope(|s| {
        let saldo = s.spawn(move || super::uso_externo::deepseek_balance(force));
        let mut v = uso_de_suscripciones(force)?;
        let saldo = saldo
            .join()
            .map_err(|_| "el saldo de DeepSeek falló (panic)".to_string())?;
        super::uso_externo::anadir(&mut v, saldo);
        Ok(v)
    })
}

fn uso_de_suscripciones(force: bool) -> Result<Value, String> {
    let root = crate::ultron_root()?;
    let script = root.join(SCRIPT);
    if !script.is_file() {
        return Err(format!(
            "no está el lector de uso de motores: {}",
            script.display()
        ));
    }
    let node = which::which("node").map_err(|_| "no se encontró 'node' en el PATH".to_string())?;
    let mut pre_args = vec![script.to_string_lossy().into_owned()];
    pre_args.extend(argumentos(force).into_iter().map(String::from));
    let program = Program {
        exe: node,
        pre_args,
    };
    let cmd = motores::command_for(&program, &root.to_string_lossy());
    let out = super::cli_info::run_cli_input(cmd, None, TOPE, "el uso de motores")
        .map_err(|e| format!("el uso de motores falló: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "el uso de motores falló: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    leer_respuesta(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actualizar_pide_saltar_la_cache() {
        assert_eq!(argumentos(false), vec!["--json"]);
        assert_eq!(argumentos(true), vec!["--json", "--force"]);
    }

    #[test]
    fn la_respuesta_valida_pasa_tal_cual() {
        let v = leer_respuesta(br#"{"generatedAtMs":1,"engines":[{"id":"codex","windows":[]}]}"#)
            .expect("válida");
        assert_eq!(v["engines"][0]["id"], "codex");
    }

    #[test]
    fn una_respuesta_rota_o_sin_engines_es_error() {
        assert!(leer_respuesta(b"no es json").is_err());
        let e = leer_respuesta(br#"{"engines":{}}"#).expect_err("engines no es lista");
        assert!(e.contains("engines"), "{e}");
        assert!(leer_respuesta(b"[]").is_err());
    }
}
