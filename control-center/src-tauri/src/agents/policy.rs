//! Política de los agentes de usuario activos (`~/.claude/rules/common/core.md`):
//! cada uno fija un ID exacto de la familia 5.5 en `model` y lleva `maxTurns`,
//! porque `context-guard` no actúa dentro de un subagente. Un alias (`haiku`)
//! o `inherit` no valen: el alias puede resolver a una versión anterior.
//!
//! La pestaña Agents pasa por aquí al activar un agente desactivado y al
//! guardar uno activo; un agente desactivado se puede editar sin restricción
//! para poder corregirlo antes de activarlo.

/// IDs permitidos en el `model` del frontmatter (con o sin la variante `[1m]`).
pub(super) const ALLOWED_MODELS: &[&str] =
    &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/// El bloque YAML entre el primer `---` y el siguiente, si el fichero lo tiene.
fn frontmatter(contents: &str) -> Option<&str> {
    let trimmed = contents.trim_start_matches('\u{feff}').trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// Valor de una clave de primer nivel del frontmatter, sin comillas.
fn field<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block.lines().find_map(|line| {
        let value = line.strip_prefix(key)?.strip_prefix(':')?;
        Some(value.trim().trim_matches(|c| c == '"' || c == '\''))
    })
}

fn is_allowed_model(model: &str) -> bool {
    let base = model.strip_suffix("[1m]").unwrap_or(model);
    ALLOWED_MODELS.contains(&base)
}

/// Motivos por los que el contenido no puede quedar en un agente activo.
fn violations(contents: &str) -> Vec<String> {
    let Some(block) = frontmatter(contents) else {
        return vec!["sin frontmatter YAML (faltan model y maxTurns)".to_string()];
    };
    let mut out = Vec::new();
    match field(block, "model") {
        None | Some("") => out.push("falta model (un ID exacto de la familia 5.5)".to_string()),
        Some(model) if !is_allowed_model(model) => out.push(format!(
            "model '{model}' fuera de la familia 5.5 ({})",
            ALLOWED_MODELS.join(", ")
        )),
        Some(_) => {}
    }
    match field(block, "maxTurns").map(str::parse::<u32>) {
        None => out.push("falta maxTurns".to_string()),
        Some(Ok(turns)) if turns > 0 => {}
        Some(_) => out.push("maxTurns debe ser un entero positivo".to_string()),
    }
    out
}

/// `Ok` si el contenido puede quedar en un agente activo; si no, el motivo
/// para la persona, con el nombre del agente y lo que tiene que corregir.
pub(super) fn check_active_agent(name: &str, contents: &str) -> Result<(), String> {
    let found = violations(contents);
    if found.is_empty() {
        return Ok(());
    }
    Err(format!(
        "el agente '{name}' no puede quedar activo: {}. Corrige el frontmatter y vuelve a intentarlo.",
        found.join("; ")
    ))
}
