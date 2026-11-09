// sesiones/historial.rs — Historial de prompts del composer
// (`sesiones_prompt_history`, contrato v0.2, E5).
//
// Sale de los transcripts del proyecto (`~/.claude/projects/<slug>/*.jsonl`,
// sin las carpetas de subagentes): solo lo que escribió la persona. Se
// descartan los mensajes `isMeta`, de subagente, de resumen de compactación,
// los resultados de herramientas y los textos inyectados por el CLI
// (`<command-…>`, `<local-command…>`, `<system-reminder>`…). Más recientes
// primero, sin duplicados consecutivos y con un máximo de 500. Cada
// transcript se lee desde el final y solo hasta reunir los que faltan.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

use super::{lectura_final, registro};

pub const MAX_PROMPTS: usize = 500;
const DEFAULT_LIMIT: usize = 200;
const INJECTED_PREFIXES: &[&str] = &[
    "<command",
    "<local-command",
    "<system-reminder>",
    "<task-notification>",
    "<bash-",
    "<user-memory-input>",
    "[Request interrupted",
];

/// Prompt escrito por la persona en una línea del transcript, si lo hay.
pub fn user_prompt(line: &str) -> Option<String> {
    if !line.contains("\"user\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    prompt_de_persona(&v)
}

/// Prompt escrito por la persona en una línea ya parseada (hilo principal):
/// excluye comandos, `!cmd`, interrupciones, resúmenes de compactación,
/// notificaciones de tareas, metadatos y resultados de herramientas (§5.1).
pub fn prompt_de_persona(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    if flag("isMeta")
        || flag("isSidechain")
        || flag("isCompactSummary")
        || flag("isVisibleInTranscriptOnly")
        || v.get("agentId").is_some()
    {
        return None;
    }
    let text = match v.pointer("/message/content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            if blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            {
                return None;
            }
            blocks.iter().find_map(|b| {
                (b.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| b.get("text").and_then(Value::as_str))
                    .flatten()
                    .map(str::to_string)
            })?
        }
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || INJECTED_PREFIXES.iter().any(|p| t.starts_with(p)) {
        return None;
    }
    Some(t.to_string())
}

fn transcripts_by_recency(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(SystemTime, PathBuf)> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "jsonl"))
        .map(|p| {
            let t = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            (t, p)
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    files.into_iter().map(|(_, p)| p).collect()
}

/// Prompts de un transcript en orden cronológico, leyendo desde el final
/// hasta tener más de `faltan` distintos de su vecino (o el fichero entero).
fn prompts_finales(file: &Path, faltan: usize) -> Vec<String> {
    let r = lectura_final::buscar_desde_el_final(file, |fin| {
        let p: Vec<String> = fin.texto.lines().filter_map(user_prompt).collect();
        let distintos = p.windows(2).filter(|w| w[0] != w[1]).count() + usize::from(!p.is_empty());
        (distintos > faltan || fin.completo).then_some(p)
    });
    r.ok().flatten().unwrap_or_default()
}

/// Prompts de los transcripts de `dir`, más recientes primero.
pub fn history_from_dir(dir: &Path, limit: usize) -> Vec<String> {
    let limit = limit.clamp(1, MAX_PROMPTS);
    let mut out: Vec<String> = Vec::new();
    for file in transcripts_by_recency(dir) {
        let prompts = prompts_finales(&file, limit - out.len());
        for p in prompts.into_iter().rev() {
            if out.last() != Some(&p) {
                out.push(p);
            }
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

fn project_path(project_id: &str) -> Result<String, String> {
    crate::projects::list_projects_inner()?
        .into_iter()
        .find(|p| p.id == project_id)
        .and_then(|p| p.path)
        .ok_or_else(|| format!("el proyecto '{project_id}' no existe o no tiene ruta"))
}

pub fn prompt_history(
    project_id: Option<&str>,
    cwd: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let cwd = match (
        project_id.filter(|p| !p.is_empty()),
        cwd.filter(|c| !c.trim().is_empty()),
    ) {
        (Some(pid), _) => project_path(pid)?,
        (None, Some(c)) => c.trim().to_string(),
        (None, None) => return Err("falta projectId o cwd".to_string()),
    };
    let base =
        registro::claude_projects_dir().ok_or_else(|| "no hay directorio personal".to_string())?;
    let dir = base.join(registro::claude_slug(cwd.trim_end_matches(['\\', '/'])));
    Ok(history_from_dir(&dir, limit.unwrap_or(DEFAULT_LIMIT)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> String {
        format!(r#"{{"type":"user","uuid":"u","message":{{"role":"user","content":{content}}}}}"#)
    }

    #[test]
    fn filtra_meta_comandos_y_resultados_de_herramientas() {
        let lines = [
            user(r#""arregla el test""#),
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"caveat"}}"#
                .to_string(),
            user(r#""<command-name>/model</command-name>""#),
            user(r#""<system-reminder>x</system-reminder>""#),
            user(r#"[{"type":"tool_result","tool_use_id":"t","content":"ok"}]"#),
            r#"{"type":"user","agentId":"a1","message":{"role":"user","content":"del subagente"}}"#
                .to_string(),
            user(r#"[{"type":"text","text":"con imagen"},{"type":"image","source":{}}]"#),
            r#"{"type":"assistant","message":{"role":"assistant","content":"no"}}"#.to_string(),
        ];
        let got: Vec<String> = lines.iter().filter_map(|l| user_prompt(l)).collect();
        assert_eq!(got, vec!["arregla el test", "con imagen"]);
    }

    #[test]
    fn mas_recientes_primero_sin_duplicados_consecutivos_y_con_tope() {
        let dir = tempfile::tempdir().expect("tempdir");
        let old = [user(r#""uno""#), user(r#""dos""#)].join("\n");
        std::fs::write(dir.path().join("a.jsonl"), old).expect("a");
        std::thread::sleep(std::time::Duration::from_millis(30));
        let new = [user(r#""tres""#), user(r#""cuatro""#), user(r#""cuatro""#)].join("\n");
        std::fs::write(dir.path().join("b.jsonl"), new).expect("b");
        std::fs::create_dir(dir.path().join("sub")).expect("sub");
        std::fs::write(dir.path().join("sub").join("c.jsonl"), user(r#""oculto""#)).expect("c");
        let h = history_from_dir(dir.path(), 500);
        assert_eq!(h, vec!["cuatro", "tres", "dos", "uno"]);
        assert_eq!(history_from_dir(dir.path(), 2), vec!["cuatro", "tres"]);
    }

    #[test]
    fn un_transcript_grande_se_lee_desde_el_final() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut lineas: Vec<String> = (0..10_000).map(|i| user(&format!("\"p{i}\""))).collect();
        lineas.extend((0..50).map(|_| user(r#""repetido""#)));
        let texto = lineas.join("\n");
        assert!(texto.len() as u64 > lectura_final::VENTANA_INICIAL);
        std::fs::write(dir.path().join("a.jsonl"), texto).expect("a");
        let h = history_from_dir(dir.path(), 3);
        assert_eq!(h, vec!["repetido", "p9999", "p9998"]);
        assert_eq!(history_from_dir(dir.path(), 500).len(), 500);
    }

    #[test]
    fn sin_proyecto_ni_cwd_es_error() {
        assert!(prompt_history(None, Some("  "), None).is_err());
        let missing = tempfile::tempdir().expect("tempdir").path().join("nada");
        assert!(history_from_dir(&missing, 10).is_empty());
    }
}
