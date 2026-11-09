// sesiones/persistencia_turno_texto.rs — Prompt de continuación de una sesión
// cortada a mitad de turno y nota del chat que lo acompaña. El prompt va al
// composer sin enviarse: el usuario lo revisa y decide.

use std::path::PathBuf;

use super::{Checkpoint, TurnoVivo};

/// Prompt de continuación. `script` resuelve el script de un runId (para que
/// la llamada de reanudación sea completa); sin él, solo va el runId.
pub fn continuacion(t: &TurnoVivo, script: &dyn Fn(&str) -> Option<PathBuf>) -> String {
    let mut l = vec![cabecera(t)];
    if let Some(p) = &t.ultimo_prompt {
        l.push(format!("Lo último que pedí: «{p}»."));
    }
    if let Some(h) = &t.herramienta_en_curso {
        l.push(format!("Herramienta en curso al cortarse: {h}."));
    }
    if let Some(c) = &t.checkpoint {
        l.push(texto_checkpoint(c));
    }
    for run in &t.workflows_vivos {
        l.push(texto_workflow(run, script(run)));
    }
    l.push(revisar(t.checkpoint.is_some()));
    l.join("\n")
}

fn cabecera(t: &TurnoVivo) -> String {
    match &t.desde {
        Some(d) => format!(
            "La sesión se cortó a mitad de turno al cerrar ULTRON (turno iniciado {}).",
            fecha(d)
        ),
        None => "ULTRON se cerró con un Workflow en segundo plano sin terminar en esta sesión."
            .to_string(),
    }
}

/// `el 15/10 a las 14:32` en hora local; el texto tal cual si no es ISO.
fn fecha(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("el %d/%m a las %H:%M")
                .to_string()
        })
        .unwrap_or_else(|_| iso.to_string())
}

fn texto_checkpoint(c: &Checkpoint) -> String {
    let head = c
        .head
        .as_deref()
        .map(|h| h.chars().take(8).collect::<String>())
        .unwrap_or_else(|| "sin commits".to_string());
    let rama = c
        .rama
        .as_deref()
        .map(|r| format!(" en {r}"))
        .unwrap_or_default();
    let arbol = if c.sucio {
        "con cambios sin confirmar"
    } else {
        "árbol limpio"
    };
    format!("Checkpoint al cerrar: HEAD {head}{rama}, {arbol}.")
}

fn texto_workflow(run: &str, script: Option<PathBuf>) -> String {
    let llamada = match script {
        Some(p) => {
            let p = p.to_string_lossy().replace('\\', "/");
            format!("Workflow({{ scriptPath: \"{p}\", resumeFromRunId: \"{run}\" }})")
        }
        None => format!("Workflow con resumeFromRunId: \"{run}\" (y el scriptPath de ese run)"),
    };
    format!(
        "Había un Workflow sin terminar (runId {run}): reanúdalo con {llamada}; los agentes \
         ya completados devuelven su resultado en caché."
    )
}

fn revisar(es_repo: bool) -> String {
    if es_repo {
        "Antes de seguir, revisa el estado real con `git status` (y `git log -1` si el HEAD \
         cambió) por si el corte dejó trabajo a medias, y continúa desde ahí."
            .to_string()
    } else {
        "Antes de seguir, revisa el estado real de los ficheros que se estaban tocando por si \
         el corte dejó trabajo a medias, y continúa desde ahí."
            .to_string()
    }
}

/// Nota del chat al dejar la continuación en la caja.
pub fn nota(t: &TurnoVivo) -> String {
    let mut s = if t.desde.is_some() {
        "La sesión se cortó a mitad de turno al cerrar ULTRON: tienes en la caja un prompt de \
         continuación, sin enviar."
            .to_string()
    } else {
        "ULTRON se cerró con un Workflow en segundo plano sin terminar: tienes en la caja un \
         prompt para reanudarlo, sin enviar."
            .to_string()
    };
    if !t.workflows_vivos.is_empty() {
        s.push_str(&format!(
            " Workflow(s) por reanudar: {}.",
            t.workflows_vivos.join(", ")
        ));
    }
    s
}
