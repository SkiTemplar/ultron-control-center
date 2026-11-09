// sesiones/ediciones_turno.rs — Ficheros que editó Claude en un turno, leídos
// del transcript.
//
// La segunda opinión automática se lanza cuando un turno edita
// `AUTO_REVIEW_MIN_FILES` ficheros o más. Contarlos en la ventana falla en los
// turnos largos: el store recorta los mensajes (por número y por bytes) y
// suelta los hilos de subagente cerrados, así que la cuenta sale corta y la
// revisión no se lanza o va incompleta. Aquí se cuentan sobre el disco: el
// hilo principal desde el final hasta el inicio del turno y los transcripts
// de subagente escritos durante el turno.

use std::collections::HashSet;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::agentes;
use super::lectura_final::{self, Final};

/// Tope de rutas devueltas.
pub const MAX_FICHEROS: usize = 500;
/// Herramientas que escriben un fichero (las mismas que cuenta la ventana).
const HERRAMIENTAS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// Rutas distintas editadas desde `desde` en el hilo principal (`main`) y en
/// los subagentes de `sub`, en orden de aparición y con tope `MAX_FICHEROS`.
/// Un transcript que no se puede leer no aporta nada (se registra).
pub fn editados(main: Option<&Path>, sub: Option<&Path>, desde: DateTime<Utc>) -> Vec<String> {
    let mut acum = Acumulador::default();
    if let Some(p) = main.filter(|p| p.is_file()) {
        leer(p, desde, &mut acum);
    }
    if let Some(dir) = sub {
        for (_, p) in agentes::list_agent_files(dir) {
            if escrito_desde(&p, desde) {
                leer(&p, desde, &mut acum);
            }
        }
    }
    acum.rutas
}

#[derive(Default)]
struct Acumulador {
    vistas: HashSet<String>,
    rutas: Vec<String>,
}

impl Acumulador {
    fn anotar(&mut self, ruta: &str) {
        if self.rutas.len() < MAX_FICHEROS && self.vistas.insert(ruta.to_string()) {
            self.rutas.push(ruta.to_string());
        }
    }
}

/// true si el fichero se modificó en `desde` o después. Sin fecha legible se
/// lee igualmente: el filtro por línea decide.
fn escrito_desde(p: &Path, desde: DateTime<Utc>) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .map(|t| DateTime::<Utc>::from(t) >= desde)
        .unwrap_or(true)
}

fn leer(p: &Path, desde: DateTime<Utc>, acum: &mut Acumulador) {
    match lectura_final::buscar_desde_el_final(p, |fin| ventana(fin, desde)) {
        Ok(Some(rutas)) => rutas.iter().for_each(|r| acum.anotar(r)),
        Ok(None) => {}
        Err(e) => tracing::warn!(
            fichero = %p.display(),
            error = %e,
            "no se pudo leer el transcript para contar los ficheros del turno"
        ),
    }
}

/// Rutas editadas desde `desde` dentro de la ventana, si la ventana empieza
/// antes del turno (o es el fichero entero); `None` para pedir una mayor.
fn ventana(fin: &Final, desde: DateTime<Utc>) -> Option<Vec<String>> {
    let mut lineas = fin.texto.lines().filter_map(linea_con_fecha).peekable();
    let primera = lineas.peek().map(|(t, _)| *t);
    let basta = fin.completo || primera.is_some_and(|t| t < desde);
    if !basta {
        return None;
    }
    let rutas = lineas
        .filter(|(t, _)| *t >= desde)
        .flat_map(|(_, v)| rutas_editadas(&v))
        .collect();
    Some(rutas)
}

fn linea_con_fecha(linea: &str) -> Option<(DateTime<Utc>, Value)> {
    let v: Value = serde_json::from_str(linea.trim()).ok()?;
    let t = v.get("timestamp").and_then(Value::as_str)?;
    let t = DateTime::parse_from_rfc3339(t).ok()?.with_timezone(&Utc);
    Some((t, v))
}

/// `file_path` (o `notebook_path`) de cada herramienta de escritura de un
/// mensaje del asistente.
fn rutas_editadas(v: &Value) -> Vec<String> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(bloques) = v.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    bloques
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter(|b| {
            b.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| HERRAMIENTAS.contains(&n))
        })
        .filter_map(|b| {
            let input = b.get("input")?;
            input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .map(str::to_string)
        })
        .collect()
}

#[cfg(test)]
#[path = "tests_ediciones_turno.rs"]
mod tests;
