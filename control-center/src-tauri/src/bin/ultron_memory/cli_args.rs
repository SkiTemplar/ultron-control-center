//! CLI argument helpers shared by every `ultron-memory` subcommand.

pub(crate) fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// Whether a boolean flag (e.g. `--golden`) is present anywhere in `args`.
pub(crate) fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// Rechaza cualquier `--flag` en `args` que no este en `allowed`. Sin esto, un
/// typo (`--gold` por `--golden`) se ignora en silencio y el subcomando finge
/// medir con el eval sintetico (recall=1.0) — un no-op silencioso (cat6.5,
/// mandamiento 11). `--flag=valor` se normaliza a `--flag` para el chequeo.
pub(crate) fn reject_unknown_flags(args: &[String], allowed: &[&str]) -> Result<(), String> {
    for a in args.iter().skip(2) {
        let Some(body) = a.strip_prefix("--") else {
            continue;
        };
        let name = body.split('=').next().unwrap_or(body);
        let full = format!("--{name}");
        if !allowed.contains(&full.as_str()) {
            return Err(format!(
                "flag desconocido: {a} (permitidos aqui: {})",
                allowed.join(", ")
            ));
        }
    }
    Ok(())
}

/// First positional arg(s) after the subcommand, excluding `--project <val>` and
/// the recognised boolean flags (so e.g. `--cross` is not folded into the query).
pub(crate) fn positional(args: &[String]) -> Result<String, String> {
    const BOOL_FLAGS: &[&str] = &[
        "--cross",
        "--all-projects",
        "--golden",
        "--agents",
        "--skills",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        if args[i] == "--project" {
            i += 2;
            continue;
        }
        if BOOL_FLAGS.contains(&args[i].as_str()) {
            i += 1;
            continue;
        }
        out.push(args[i].clone());
        i += 1;
    }
    if out.is_empty() {
        return Err("missing argument (prompt/query)".to_string());
    }
    Ok(out.join(" "))
}
