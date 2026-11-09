// sesiones/proyecto.rs — Bitácora del proyecto para el inspector
// (`sesiones_bitacora`; contrato v0.2, E10). Los comandos del kanban se
// retiraron el 2026-10-14 junto con su pestaña.

use std::path::Path;

use serde_json::Value;

use super::ajustes::valid_project_id;
use super::types::Bitacora;

fn check_id(project_id: &str) -> Result<(), String> {
    if valid_project_id(project_id) {
        Ok(())
    } else {
        Err(format!("id de proyecto no válido: '{project_id}'"))
    }
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Bitácora de un `estado.json`; vacía si el fichero no existe.
pub fn bitacora_from(path: &Path) -> Result<Bitacora, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Bitacora::default()),
        Err(e) => return Err(format!("no se pudo leer {}: {e}", path.display())),
    };
    let v: Value =
        serde_json::from_str(&raw).map_err(|e| format!("estado.json no es JSON válido: {e}"))?;
    Ok(Bitacora {
        resumen: v
            .get("resumen")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pendientes: strings(&v, "pendientes"),
        decisiones: strings(&v, "decisiones"),
        gotchas: strings(&v, "gotchas"),
        updated_at: v
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn bitacora(project_id: &str) -> Result<Bitacora, String> {
    check_id(project_id)?;
    let path = dirs::home_dir()
        .ok_or_else(|| "no hay directorio personal".to_string())?
        .join(".ultron/cockpit/projects")
        .join(project_id)
        .join("estado.json");
    bitacora_from(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_bitacora_lee_estado_json() {
        let d = tempfile::tempdir().expect("tempdir");
        let p = d.path().join("estado.json");
        std::fs::write(
            &p,
            r#"{"resumen":"r","pendientes":["a"],"decisiones":["b",3],"updated_at":"2026-10-07T00:00:00Z"}"#,
        )
        .expect("estado");
        let b = bitacora_from(&p).expect("bitácora");
        assert_eq!(b.resumen, "r");
        assert_eq!(b.pendientes, vec!["a"]);
        assert_eq!(b.decisiones, vec!["b"]);
        assert!(b.gotchas.is_empty());
        assert_eq!(b.updated_at.as_deref(), Some("2026-10-07T00:00:00Z"));
    }

    #[test]
    fn sin_estado_la_bitacora_esta_vacia_y_un_json_roto_es_error() {
        let d = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            bitacora_from(&d.path().join("no")).expect("vacía"),
            Bitacora::default()
        );
        let p = d.path().join("roto.json");
        std::fs::write(&p, "{").expect("roto");
        assert!(bitacora_from(&p).is_err());
    }

    #[test]
    fn ids_con_traversal_se_rechazan() {
        assert!(bitacora("../secreto").is_err());
        assert!(bitacora("a/b").is_err());
    }
}
