// hooks_admin/descriptions.rs — Readable descriptions for hooks (no AI, no mutations).

use std::fs;
use std::path::{Path, PathBuf};

use super::io::{flatten_hooks, read_settings_value};
use super::types::HookDescription;

/// Curated (title, summary) for the known ULTRON hook scripts, keyed by the
/// script's file name. Kept here (not AI) so the names are stable and precise.
fn curated_hook_meta(basename: &str) -> Option<(&'static str, &'static str)> {
    let meta: &[(&str, &str, &str)] = &[
        (
            "stop-compress-session.js",
            "Comprimir sesion a Qdrant",
            "Al cerrar, resume la sesion en hechos estructurados y los guarda en la coleccion Qdrant ultron_sessions para recall semantico.",
        ),
        (
            "kanban-update-reminder.js",
            "Recordatorio de Kanban",
            "Si detecta que se completo una tarea, recuerda actualizar el kanban del proyecto activo antes de cerrar.",
        ),
        (
            "load-cross-project-memory.js",
            "Cargar memoria cross-proyecto",
            "Al iniciar, inyecta un indice de las memorias (MEMORY.md) de todos los proyectos recientes, no solo el actual.",
        ),
        (
            "session-start-override.js",
            "Resumen de sesion previa (fallback por proyecto)",
            "Al iniciar, inyecta el resumen de la ultima sesion del mismo proyecto cuando el match por worktree del plugin falla.",
        ),
        (
            "routing-dispatcher.js",
            "Router de skills y personas",
            "En cada prompt, puntua el texto contra personas y skills y sugiere la mas adecuada (sin LLM).",
        ),
        (
            "save-user-prompt.js",
            "Auto-guardar prompts del usuario",
            "En cada prompt, archiva el mensaje en un inbox markdown por dia y marca el conocimiento critico.",
        ),
        (
            "ensure-qdrant.ps1",
            "Arrancar Qdrant",
            "Al iniciar, comprueba que Qdrant este vivo en el puerto 6333 y lo lanza si hace falta.",
        ),
        (
            "memory-warmup.js",
            "Precalentar memoria",
            "Al iniciar, precarga el indice de memoria y el modelo de embeddings E5 para que el primer recall no tarde.",
        ),
        (
            "project-card.js",
            "Ficha del proyecto",
            "Al iniciar, inyecta una ficha cacheada del proyecto actual (estado, decisiones, ubicacion de funciones).",
        ),
        (
            "memory-session-resume.js",
            "Resumen de memoria al iniciar",
            "Al iniciar, inyecta el resume de tareas abiertas y decisiones recientes desde el sistema de memoria de ULTRON.",
        ),
        (
            "memory-orchestrate.js",
            "Orquestar memoria por prompt",
            "En cada prompt, hace prefetch del contexto relevante (recall hibrido sparse+denso) y lo inyecta como orientacion.",
        ),
        (
            "deny-secrets.py",
            "Bloquear secretos",
            "Antes de cada herramienta, bloquea operaciones que expondrían secretos o credenciales (write-path guard).",
        ),
        (
            "posttoolfail-capture.js",
            "Capturar fallos de herramienta",
            "Tras un fallo de herramienta, registra el error como patron para el recall futuro.",
        ),
        (
            "batch-capture.js",
            "Captura batch al cerrar",
            "Al cerrar, drena los candidatos de memoria pendientes acumulados durante la sesion.",
        ),
        (
            "qdrant-mirror-sync.js",
            "Espejar memoria a Qdrant",
            "Al cerrar, sincroniza los items nuevos de SQLite hacia la coleccion densa de Qdrant.",
        ),
        (
            "route_quality_aggregator.py",
            "Agregar calidad de routing",
            "Al cerrar, agrega la telemetria de routing de la sesion para medir aciertos del dispatcher.",
        ),
        (
            "session-end-summary.js",
            "Resumen al terminar la sesion",
            "En SessionEnd, escribe un resumen final de la sesion para arrancar mejor la siguiente.",
        ),
        (
            "precompact-preserve-l0.js",
            "Preservar contexto L0 antes de compactar",
            "Antes de compactar, guarda el contexto L0 (<=400 tokens) para que sobreviva a la compactacion.",
        ),
        (
            "subagent-harvest.js",
            "Cosechar subagentes",
            "Cuando un subagente termina, recoge sus hallazgos hacia el sistema de memoria.",
        ),
        (
            "notify-relay.js",
            "Rele de notificaciones",
            "Reenvía las notificaciones de Claude Code hacia el Control Center / sistema operativo.",
        ),
    ];
    meta.iter()
        .find(|(name, _, _)| *name == basename)
        .map(|(_, title, summary)| (*title, *summary))
}

/// Extract the first script-like path argument from a hook command, e.g.
/// `node C:/Users/.../foo.js` -> `C:/Users/.../foo.js`. Returns the raw token
/// (with `~` expanded) when it ends in a known script extension.
fn extract_script_path(command: &str) -> Option<PathBuf> {
    const EXTS: [&str; 6] = [".js", ".cjs", ".mjs", ".ts", ".py", ".ps1"];
    for raw in command.split_whitespace() {
        let tok = raw.trim_matches(|c| c == '"' || c == '\'');
        let lower = tok.to_ascii_lowercase();
        if EXTS.iter().any(|e| lower.ends_with(e)) {
            let expanded =
                if let Some(rest) = tok.strip_prefix("~/").or_else(|| tok.strip_prefix("~\\")) {
                    dirs::home_dir()
                        .map(|h| h.join(rest))
                        .unwrap_or_else(|| PathBuf::from(tok))
                } else {
                    PathBuf::from(tok)
                };
            return Some(expanded);
        }
    }
    None
}

/// Read the leading header comment of a script and return its first meaningful
/// sentence as a one-line summary. Handles `/** */`, `//` and `#` styles.
fn parse_script_header(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let mut summary_lines: Vec<String> = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        if idx > 40 {
            break;
        }
        let t = line.trim();
        if t.is_empty() {
            if summary_lines.is_empty() {
                continue;
            } else {
                break;
            }
        }
        if t.starts_with("#!") {
            continue;
        }
        let cleaned = t
            .trim_start_matches("/**")
            .trim_start_matches("/*")
            .trim_start_matches("*/")
            .trim_start_matches('*')
            .trim_start_matches("//")
            .trim_start_matches('#')
            .trim();
        let is_comment =
            t.starts_with("/*") || t.starts_with('*') || t.starts_with("//") || t.starts_with('#');
        if !is_comment {
            if summary_lines.is_empty() {
                continue;
            }
            break;
        }
        if cleaned.is_empty() || cleaned == "'use strict';" {
            continue;
        }
        summary_lines.push(cleaned.to_string());
        if summary_lines.len() >= 2 {
            break;
        }
    }
    if summary_lines.is_empty() {
        return None;
    }
    let joined = summary_lines.join(" ");
    let first = joined.split(". ").next().unwrap_or(&joined).trim();
    let mut s = first.trim_end_matches('.').to_string();
    const MAX: usize = 160;
    if s.chars().count() > MAX {
        s = s.chars().take(MAX - 1).collect::<String>() + "\u{2026}";
    }
    Some(s)
}

/// Turn `stop-compress-session.js` -> `Stop compress session`.
fn humanize_basename(basename: &str) -> String {
    let stem = basename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(basename);
    let words: Vec<String> = stem
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect();
    if words.is_empty() {
        return basename.to_string();
    }
    let mut out = words.join(" ");
    if let Some(first) = out.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    out
}

/// Compute readable descriptions for every hook (no AI, no mutations).
pub fn get_hook_descriptions_inner() -> Vec<HookDescription> {
    let Ok(root) = read_settings_value() else {
        return Vec::new();
    };
    let mut out: Vec<HookDescription> = Vec::new();
    for hook in flatten_hooks(&root) {
        let script = extract_script_path(&hook.command);
        let basename = script
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let (title, summary, source) = if let Some((t, s)) = curated_hook_meta(&basename) {
            (t.to_string(), s.to_string(), "curated")
        } else if let Some(s) = script.as_ref().and_then(|p| parse_script_header(p)) {
            (humanize_basename(&basename), s, "header")
        } else if !basename.is_empty() {
            (humanize_basename(&basename), String::new(), "filename")
        } else {
            let preview = hook.command.chars().take(80).collect::<String>();
            (
                hook.description.clone().unwrap_or_else(|| preview.clone()),
                String::new(),
                "command",
            )
        };

        out.push(HookDescription {
            id: hook.id,
            title,
            summary,
            source: source.to_string(),
        });
    }
    out
}
