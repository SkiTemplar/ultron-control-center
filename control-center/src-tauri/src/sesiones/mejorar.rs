// sesiones/mejorar.rs — `/mejorar` dentro de ULTRON Sessions.
//
// El mod `ultron-mejorar` deja su resultado en la caja de la TUI, que en
// Sessions está dentro del PTY oculto. Aquí la app lo resuelve sin pasar por
// Claude Code: junta el mismo contexto que el mod (proyecto, rama, cambios y
// último error), llama a la zona `light` del AI Router (Groq, con Gemini y
// Ollama local de relevo; coste 0 del plan de Claude) y devuelve el texto al
// composer para revisarlo antes de enviarlo.

use super::registro;

/// Zona del AI Router que reescribe el prompt.
pub const ZONE: &str = "light";
const MAX_STATUS_LINES: usize = 15;
const MAX_ERROR_CHARS: usize = 300;
const MAX_DRAFT_CHARS: usize = 12_000;

/// Fuente única de las reglas del editor de prompts: el `SYSTEM` del mod
/// `ultron-mejorar`, leído al compilar. Antes estaban copiadas aquí y podían
/// divergir sin que nada lo detectase.
const MOD_CONTEXT_TS: &str = include_str!("../../../../mods/ultron-mejorar/hooks/context.ts");

/// Extrae `export const SYSTEM = [ 'línea', … ].join('\n')` del fuente TS.
/// Solo acepta literales con comilla simple y sin escapes; cualquier otra
/// forma devuelve `None` (y `/mejorar` falla con el motivo, no a ciegas).
fn system_from_mod(ts: &str) -> Option<String> {
    let decl = &ts[ts.find("export const SYSTEM = [")?..];
    let body = &decl[decl.find('[')? + 1..decl.find("].join('\\n')")?];
    let lines = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let lit = l.strip_suffix(',').unwrap_or(l);
            let inner = lit.strip_prefix('\'')?.strip_suffix('\'')?;
            (!inner.contains(['\'', '\\'])).then_some(inner)
        })
        .collect::<Option<Vec<_>>>()?;
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// Valor de `export const <name> = <entero>` en el fuente TS.
#[cfg(test)]
fn ts_const(ts: &str, name: &str) -> Option<usize> {
    let decl = format!("export const {name} = ");
    let rest = &ts[ts.find(&decl)? + decl.len()..];
    rest.lines().next()?.trim().replace('_', "").parse().ok()
}

/// Reglas del mod ya extraídas; vacías si `context.ts` cambió de forma.
fn system_rules() -> &'static str {
    static RULES: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(|| system_from_mod(MOD_CONTEXT_TS).unwrap_or_default());
    RULES.as_str()
}

/// Hechos del proyecto que acompañan al borrador.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Contexto {
    pub cwd: String,
    pub project: Option<String>,
    pub branch: Option<String>,
    /// Líneas `XY ruta` de los cambios sin commitear.
    pub changes: Vec<String>,
    pub last_error: Option<String>,
}

/// Prompt completo para el modelo: reglas, contexto y borrador.
pub fn build_prompt(draft: &str, ctx: &Contexto) -> String {
    let mut facts = vec![format!("Directorio de trabajo: {}", ctx.cwd)];
    if let Some(p) = &ctx.project {
        facts.push(format!("Proyecto ULTRON: {p}"));
    }
    if let Some(b) = &ctx.branch {
        facts.push(format!("Rama: {b}"));
    }
    if !ctx.changes.is_empty() {
        let shown = &ctx.changes[..ctx.changes.len().min(MAX_STATUS_LINES)];
        let mut block = shown.join("\n");
        let rest = ctx.changes.len() - shown.len();
        if rest > 0 {
            block.push_str(&format!("\n… y {rest} más"));
        }
        facts.push(format!("Cambios sin commitear:\n{block}"));
    }
    if let Some(e) = ctx
        .last_error
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        let clipped: String = e.chars().take(MAX_ERROR_CHARS).collect();
        facts.push(format!("Último error de herramienta:\n{clipped}"));
    }
    format!(
        "{}\n\n<contexto>\n{}\n</contexto>\n\n<borrador>\n{draft}\n</borrador>",
        system_rules(),
        facts.join("\n")
    )
}

/// Prompt tal como sale al proveedor externo de la zona (Groq primero): sin
/// secretos y sin el nombre de la cuenta en las rutas (borrador, directorio y
/// último error incluidos). Seguridad MEDIUM de la auditoría 2026-10-17.
pub fn outbound_prompt(draft: &str, ctx: &Contexto) -> String {
    use crate::memory::redaction::redact_outbound;
    // El último error se redacta entero ANTES de que `build_prompt` lo recorte
    // a `MAX_ERROR_CHARS`: un token cortado por el tope queda por debajo del
    // mínimo del patrón y la pasada final ya no lo reconocería.
    let ctx = Contexto {
        last_error: ctx.last_error.as_deref().map(redact_outbound),
        ..ctx.clone()
    };
    redact_outbound(&build_prompt(draft, &ctx))
}

/// Limpia la respuesta: sin bloque de código envolvente ni etiquetas que el
/// modelo haya copiado del formato de entrada.
pub fn clean_reply(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(inner) = text.strip_prefix("```") {
        let inner = inner.split_once('\n').map_or("", |(_, rest)| rest);
        text = inner.strip_suffix("```").unwrap_or(inner).trim();
    }
    let text = text
        .strip_prefix("<borrador>")
        .and_then(|t| t.strip_suffix("</borrador>"))
        .unwrap_or(text);
    text.trim().to_string()
}

fn gather(id: &str, last_error: Option<String>) -> Result<Contexto, String> {
    let (cwd, project) = registro::read(id, |s| {
        (
            s.info.cwd.clone(),
            s.info
                .project_id
                .as_ref()
                .map(|_| s.info.project_name.clone()),
        )
    })?;
    let (branch, changes) = match crate::commands::projects::git_ops::repo_snapshot_blocking(&cwd) {
        Ok(snap) if snap.state.is_repo => (
            snap.state.branch,
            snap.changes
                .iter()
                .map(|c| format!("{}{} {}", c.index_status, c.worktree_status, c.path))
                .collect(),
        ),
        // Sin repo o git caído: el contexto sale sin rama ni cambios.
        _ => (None, Vec::new()),
    };
    Ok(Contexto {
        cwd,
        project,
        branch,
        changes,
        last_error,
    })
}

/// Reescribe `draft` con el contexto de la sesión `id`.
pub fn mejorar(id: &str, draft: &str, last_error: Option<String>) -> Result<String, String> {
    let draft = draft.trim();
    if draft.is_empty() {
        return Err("No hay borrador que mejorar: escribe /mejorar <borrador>.".into());
    }
    if draft.chars().count() > MAX_DRAFT_CHARS {
        return Err(format!(
            "El borrador pasa de {MAX_DRAFT_CHARS} caracteres: adjúntalo como fichero en vez de mejorarlo."
        ));
    }
    if system_rules().is_empty() {
        return Err(
            "No se pudo mejorar el prompt: las reglas del mod ultron-mejorar \
                    (hooks/context.ts, SYSTEM) no tienen la forma esperada."
                .into(),
        );
    }
    let ctx = gather(id, last_error)?;
    let reply = crate::ai_router::route(ZONE, &outbound_prompt(draft, &ctx))
        .map_err(|e| format!("No se pudo mejorar el prompt (AI Router, zona {ZONE}): {e}"))?;
    let text = clean_reply(&reply);
    if text.is_empty() {
        return Err("No se pudo mejorar el prompt: el modelo respondió vacío.".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Contexto {
        Contexto {
            cwd: "C:/p".into(),
            project: Some("Demo".into()),
            branch: Some("main".into()),
            changes: (0..20).map(|i| format!(" M f{i}.rs")).collect(),
            last_error: Some("x".repeat(500)),
        }
    }

    /// Fuente única: las reglas son las del `SYSTEM` del mod, línea a línea.
    #[test]
    fn las_reglas_salen_del_mod() {
        let rules = system_rules();
        assert!(rules.starts_with("Eres un editor de prompts para Claude Code."));
        assert!(rules.ends_with("devuelve SOLO el prompt reescrito."));
        assert_eq!(rules.lines().count(), 8, "{rules}");
        assert!(
            !rules.contains('\''),
            "sin comillas del literal TS: {rules}"
        );
        assert!(build_prompt("x", &ctx()).starts_with(rules));
    }

    #[test]
    fn un_system_malformado_no_se_acepta() {
        assert_eq!(system_from_mod("export const OTRO = 1"), None);
        assert_eq!(
            system_from_mod("export const SYSTEM = [\n].join('\\n')"),
            None
        );
        assert_eq!(
            system_from_mod("export const SYSTEM = [\n  `plantilla`,\n].join('\\n')"),
            None
        );
        assert_eq!(
            system_from_mod("export const SYSTEM = [\n  'a',\n  'b',\n].join('\\n')").as_deref(),
            Some("a\nb")
        );
    }

    /// Los topes del contexto son los mismos que los del mod.
    #[test]
    fn topes_en_paridad_con_el_mod() {
        assert_eq!(
            ts_const(MOD_CONTEXT_TS, "MAX_STATUS_LINES"),
            Some(MAX_STATUS_LINES)
        );
        assert_eq!(
            ts_const(MOD_CONTEXT_TS, "MAX_ERROR_CHARS"),
            Some(MAX_ERROR_CHARS)
        );
    }

    #[test]
    fn prompt_lleva_reglas_contexto_y_borrador() {
        let p = build_prompt("arregla el login", &ctx());
        assert!(p.starts_with("Eres un editor de prompts"));
        assert!(p.contains("Proyecto ULTRON: Demo"));
        assert!(p.contains("Rama: main"));
        assert!(p.contains("… y 5 más"), "recorta a 15 cambios");
        assert!(p.contains(&"x".repeat(300)) && !p.contains(&"x".repeat(301)));
        assert!(p.ends_with("<borrador>\narregla el login\n</borrador>"));
    }

    #[test]
    fn prompt_saliente_sin_secretos_ni_cuenta() {
        let token = format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
        let ctx = Contexto {
            cwd: r"C:\Users\cuenta\proyecto".into(),
            last_error: Some(format!("fallo con {token}")),
            ..Default::default()
        };
        let draft = r"revisa C:\Users\cuenta\proyecto\src\a.rs";
        // Caso negativo: el prompt crudo sí lleva la cuenta y el token.
        let raw = build_prompt(draft, &ctx);
        assert!(raw.contains("cuenta") && raw.contains(&token));
        let out = outbound_prompt(draft, &ctx);
        assert!(!out.contains("cuenta"), "la cuenta no sale: {out}");
        assert!(!out.contains(&token), "el token no sale: {out}");
        assert!(
            out.contains(r"revisa ~\proyecto\src\a.rs"),
            "la ruta sigue siendo útil: {out}"
        );
        assert!(out.contains("Directorio de trabajo: ~\\proyecto"));
    }

    #[test]
    fn prompt_sin_hechos_opcionales() {
        let p = build_prompt(
            "hola",
            &Contexto {
                cwd: "C:/p".into(),
                ..Default::default()
            },
        );
        assert!(!p.contains("Rama:") && !p.contains("Cambios sin") && !p.contains("Último error"));
    }

    #[test]
    fn limpia_bloque_de_codigo_y_etiquetas() {
        assert_eq!(clean_reply("```text\nHaz X.\n```"), "Haz X.");
        assert_eq!(clean_reply("<borrador>\nHaz Y.\n</borrador>"), "Haz Y.");
        assert_eq!(clean_reply("  Haz Z.  "), "Haz Z.");
    }

    #[test]
    fn borrador_vacio_o_enorme_falla_sin_llamar_al_router() {
        assert!(mejorar("no-existe", "   ", None)
            .unwrap_err()
            .contains("No hay borrador"));
        let big = "a".repeat(MAX_DRAFT_CHARS + 1);
        assert!(mejorar("no-existe", &big, None)
            .unwrap_err()
            .contains("adjúntalo"));
    }

    #[test]
    fn el_token_que_cruza_el_tope_del_error_no_sale_a_medias() {
        // El token empieza 5 caracteres antes del tope: recortar primero deja
        // `ghp_` + 5 caracteres, por debajo del mínimo del patrón, y escapa.
        let token = format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
        let error = format!("{} {token}", "x".repeat(MAX_ERROR_CHARS - 10));
        let ctx = Contexto {
            cwd: "C:/p".into(),
            last_error: Some(error),
            ..Default::default()
        };
        // Caso negativo: el prompt crudo sí lleva el prefijo recortado.
        assert!(build_prompt("hola", &ctx).contains("ghp_ABCDE"));
        let out = outbound_prompt("hola", &ctx);
        assert!(!out.contains("ghp_"), "ni el prefijo del token sale: {out}");
        assert!(
            out.contains("[REDACTED"),
            "queda constancia de la redacción: {out}"
        );
    }
}
