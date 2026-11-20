//! In-app creation of agents and skills.

use std::path::PathBuf;

use super::helpers::{atomic_write_bytes, is_kebab, resolve_agent_target, resolve_skill_dir};
use super::types::{
    AgentCreateSpec, SkillCreateSpec, TargetScope, AGENT_MAX_TURNS_RANGE, AGENT_MODEL_IDS,
    DEFAULT_AGENT_MAX_TURNS,
};

pub fn agent_create_inner(
    spec: AgentCreateSpec,
    target_scope: TargetScope,
    target_project_id: Option<String>,
) -> Result<PathBuf, String> {
    // Se valida todo antes de tocar el disco: un spec inválido no resuelve
    // rutas ni crea carpetas.
    let fm = render_agent_file(&spec)?;
    let target = resolve_agent_target(&spec.name, target_scope, target_project_id.as_deref())?;
    if target.exists() {
        return Err(format!("agent already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    atomic_write_bytes(&target, fm.as_bytes())?;
    Ok(target)
}

pub fn skill_create_inner(
    spec: SkillCreateSpec,
    target_scope: TargetScope,
    target_project_id: Option<String>,
) -> Result<PathBuf, String> {
    if !is_kebab(&spec.name) {
        return Err(format!("invalid name (must be kebab-case): {}", spec.name));
    }
    let dir = resolve_skill_dir(&spec.name, target_scope, target_project_id.as_deref())?;
    let target = dir.join("SKILL.md");
    if target.exists() {
        return Err(format!("skill already exists: {}", target.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!(
        "description: {}\n",
        yaml_string(&spec.description)
    ));
    fm.push_str("---\n\n");
    fm.push_str(&spec.body);
    if !fm.ends_with('\n') {
        fm.push('\n');
    }
    atomic_write_bytes(&target, fm.as_bytes())?;
    Ok(target)
}

/// Fichero completo del agente (frontmatter + cuerpo). Valida el nombre, el
/// modelo y `maxTurns`; `maxTurns` se escribe siempre.
pub(crate) fn render_agent_file(spec: &AgentCreateSpec) -> Result<String, String> {
    if !is_kebab(&spec.name) {
        return Err(format!("invalid name (must be kebab-case): {}", spec.name));
    }
    let model = normalize_agent_model(spec.model.as_deref())?;
    let max_turns = validate_max_turns(spec.max_turns)?;
    let mut fm = String::new();
    fm.push_str("---\n");
    fm.push_str(&format!("name: {}\n", spec.name));
    fm.push_str(&format!(
        "description: {}\n",
        yaml_string(&spec.description)
    ));
    if !spec.tools.is_empty() {
        let arr: Vec<String> = spec.tools.iter().map(|t| format!("\"{}\"", t)).collect();
        fm.push_str(&format!("tools: [{}]\n", arr.join(", ")));
    }
    if let Some(m) = model {
        fm.push_str(&format!("model: {}\n", m));
    }
    fm.push_str(&format!("maxTurns: {}\n", max_turns));
    fm.push_str("---\n\n");
    fm.push_str(&spec.body);
    if !fm.ends_with('\n') {
        fm.push('\n');
    }
    Ok(fm)
}

/// Modelo del frontmatter: `None` o vacío no escribe `model` (el agente
/// hereda el de la sesión); los alias `opus`/`sonnet`/`haiku` pasan al ID
/// exacto 5.5; cualquier otro valor que no sea uno de `AGENT_MODEL_IDS` es un
/// error (incluidos `claude-fable-5-2` y las versiones anteriores).
pub(crate) fn normalize_agent_model(model: Option<&str>) -> Result<Option<&'static str>, String> {
    let raw = match model.map(str::trim) {
        None | Some("") => return Ok(None),
        Some(m) => m,
    };
    let id = match raw {
        "opus" => "claude-opus-5-5",
        "sonnet" => "claude-sonnet-5-5",
        "haiku" => "claude-haiku-5-5",
        other => other,
    };
    AGENT_MODEL_IDS
        .iter()
        .copied()
        .find(|allowed| *allowed == id)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "invalid model: {raw} (allowed: {}, or the aliases opus/sonnet/haiku)",
                AGENT_MODEL_IDS.join(", ")
            )
        })
}

/// `maxTurns` del frontmatter: `None` da `DEFAULT_AGENT_MAX_TURNS`; fuera de
/// `AGENT_MAX_TURNS_RANGE` es un error.
pub(crate) fn validate_max_turns(max_turns: Option<i64>) -> Result<i64, String> {
    let value = max_turns.unwrap_or(DEFAULT_AGENT_MAX_TURNS);
    if AGENT_MAX_TURNS_RANGE.contains(&value) {
        return Ok(value);
    }
    Err(format!(
        "invalid maxTurns: {value} (must be an integer between {} and {})",
        AGENT_MAX_TURNS_RANGE.start(),
        AGENT_MAX_TURNS_RANGE.end()
    ))
}

fn yaml_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(model: Option<&str>, max_turns: Option<i64>) -> AgentCreateSpec {
        AgentCreateSpec {
            name: "mi-agente".into(),
            description: "Hace una cosa".into(),
            tools: vec!["Read".into()],
            model: model.map(String::from),
            body: "# Mi agente\n".into(),
            max_turns,
        }
    }

    fn frontmatter(file: &str) -> &str {
        let rest = file.strip_prefix("---\n").expect("abre con ---");
        &rest[..rest.find("---\n").expect("cierra con ---")]
    }

    #[test]
    fn el_frontmatter_lleva_siempre_max_turns_y_200_por_defecto() {
        let file = render_agent_file(&spec(Some("claude-opus-5-5"), None)).unwrap();
        let fm = frontmatter(&file);
        assert!(fm.contains("\nmaxTurns: 200\n"), "{fm}");
        assert!(fm.contains("\nmodel: claude-opus-5-5\n"), "{fm}");

        let file = render_agent_file(&spec(None, Some(120))).unwrap();
        let fm = frontmatter(&file);
        assert!(fm.contains("\nmaxTurns: 120\n"), "{fm}");
        assert!(
            !fm.contains("model:"),
            "sin modelo no se escribe la clave: {fm}"
        );
    }

    #[test]
    fn los_alias_pasan_al_id_exacto_5_5() {
        for (alias, id) in [
            ("opus", "claude-opus-5-5"),
            ("sonnet", "claude-sonnet-5-5"),
            ("haiku", "claude-haiku-5-5"),
        ] {
            assert_eq!(normalize_agent_model(Some(alias)).unwrap(), Some(id));
            let file = render_agent_file(&spec(Some(alias), Some(100))).unwrap();
            assert!(file.contains(&format!("\nmodel: {id}\n")), "{file}");
            assert!(!file.contains(&format!("model: {alias}\n")), "{file}");
        }
        assert_eq!(normalize_agent_model(Some("")).unwrap(), None);
        assert_eq!(normalize_agent_model(None).unwrap(), None);
    }

    #[test]
    fn un_modelo_fuera_de_la_lista_es_un_error() {
        for bad in [
            "claude-fable-5-2",
            "claude-opus-5",
            "claude-sonnet-4-5",
            "gpt-6",
            "inherit",
            "Opus",
        ] {
            let err = render_agent_file(&spec(Some(bad), Some(100))).unwrap_err();
            assert!(err.contains("invalid model"), "{bad}: {err}");
        }
    }

    #[test]
    fn max_turns_fuera_de_rango_es_un_error() {
        for bad in [0, -1, 501, i64::MAX] {
            let err = render_agent_file(&spec(Some("opus"), Some(bad))).unwrap_err();
            assert!(err.contains("invalid maxTurns"), "{bad}: {err}");
        }
        assert_eq!(validate_max_turns(Some(1)).unwrap(), 1);
        assert_eq!(validate_max_turns(Some(500)).unwrap(), 500);
    }

    #[test]
    fn el_spec_invalido_falla_antes_de_resolver_el_destino() {
        // Con un proyecto inexistente, si la validación no fuera primero el
        // error sería «project not found».
        let err = agent_create_inner(
            spec(Some("claude-fable-5-2"), None),
            TargetScope::Project,
            Some("no-existe".into()),
        )
        .unwrap_err();
        assert!(err.contains("invalid model"), "{err}");
    }

    #[test]
    fn max_turns_se_deserializa_en_camel_case() {
        let s: AgentCreateSpec = serde_json::from_str(
            r#"{"name":"a","description":"d","model":"sonnet","body":"b","maxTurns":80}"#,
        )
        .unwrap();
        assert_eq!(s.max_turns, Some(80));
        let s: AgentCreateSpec =
            serde_json::from_str(r#"{"name":"a","description":"d","body":"b"}"#).unwrap();
        assert_eq!(s.max_turns, None);
    }
}
