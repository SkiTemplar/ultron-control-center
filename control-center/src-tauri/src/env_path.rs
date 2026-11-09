// env_path.rs — PATH del proceso completado con el del registro (Windows).
//
// Lanzada desde el Explorador (acceso directo, autoarranque), la app hereda el
// PATH del Explorador, que puede ser anterior a la última instalación: medido
// el 2026-10-07, `claude` (en `%USERPROFILE%\.local\bin`) no aparecía y
// ULTRON Sessions fallaba con «'claude' not found on PATH». Al arrancar se
// añaden al PATH del proceso las entradas del PATH de máquina y de usuario del
// registro que falten (expandidas), sin reordenar ni quitar nada; los hijos
// (PTY, sondas `where`) heredan el resultado.

/// Valor de `Path` en la salida de `reg query … /v Path`.
pub fn parse_reg_path(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let t = line.trim_start();
        let rest = t.strip_prefix("Path").or_else(|| t.strip_prefix("PATH"))?;
        let rest = rest.trim_start();
        let rest = rest
            .strip_prefix("REG_EXPAND_SZ")
            .or_else(|| rest.strip_prefix("REG_SZ"))?;
        Some(rest.trim().to_string())
    })
}

/// Expande `%VAR%` con `lookup`; las variables desconocidas se dejan tal cual.
pub fn expand_vars(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn norm(entry: &str) -> String {
    entry.trim().trim_end_matches(['\\', '/']).to_lowercase()
}

/// `current` más las entradas de `extra` que no estén ya (sin distinguir
/// mayúsculas ni barra final). Devuelve `None` si no falta ninguna.
pub fn merge_path(current: &str, extra: &[String]) -> Option<String> {
    let mut seen: Vec<String> = current
        .split(';')
        .map(norm)
        .filter(|e| !e.is_empty())
        .collect();
    let mut added: Vec<&str> = Vec::new();
    for list in extra {
        for e in list.split(';') {
            let n = norm(e);
            if n.is_empty() || n.contains('%') || seen.contains(&n) {
                continue;
            }
            seen.push(n);
            added.push(e.trim());
        }
    }
    if added.is_empty() {
        return None;
    }
    let base = current.trim_end_matches(';');
    Some(if base.is_empty() {
        added.join(";")
    } else {
        format!("{base};{}", added.join(";"))
    })
}

#[cfg(windows)]
fn reg_path(key: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg")
        .args(["query", key, "/v", "Path"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_reg_path(&String::from_utf8_lossy(&out.stdout))
}

/// Completa el PATH del proceso con el del registro. Se llama al arrancar y,
/// en Windows, también al lanzar una CLI que no está en el PATH heredado
/// (`pty::spawn`): `SetEnvironmentVariableW` es seguro con otros hilos vivos.
#[cfg(windows)]
pub fn refresh_from_registry() {
    let keys = [
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        r"HKCU\Environment",
    ];
    let extra: Vec<String> = keys
        .iter()
        .filter_map(|k| reg_path(k))
        .map(|p| expand_vars(&p, |name| std::env::var(name).ok()))
        .collect();
    let current = std::env::var("PATH").unwrap_or_default();
    if let Some(merged) = merge_path(&current, &extra) {
        tracing::info!("PATH completado con entradas del registro");
        std::env::set_var("PATH", merged);
    }
}

#[cfg(not(windows))]
pub fn refresh_from_registry() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_valor_de_reg_query() {
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\a;%USERPROFILE%\\b\r\n\r\n";
        assert_eq!(
            parse_reg_path(out).as_deref(),
            Some("C:\\a;%USERPROFILE%\\b")
        );
        assert_eq!(parse_reg_path("nada"), None);
    }

    #[test]
    fn expande_variables_conocidas() {
        let look = |n: &str| (n == "USERPROFILE").then(|| "C:\\Users\\R".to_string());
        assert_eq!(
            expand_vars("%USERPROFILE%\\.local\\bin", look),
            "C:\\Users\\R\\.local\\bin"
        );
        assert_eq!(expand_vars("%NOPE%\\x;50%", look), "%NOPE%\\x;50%");
    }

    #[test]
    fn anade_solo_lo_que_falta_sin_reordenar() {
        let cur = "C:\\Windows;C:\\Tools\\";
        let extra = vec!["c:\\tools;C:\\Users\\R\\.local\\bin;%SIN%\\x".to_string()];
        assert_eq!(
            merge_path(cur, &extra).as_deref(),
            Some("C:\\Windows;C:\\Tools\\;C:\\Users\\R\\.local\\bin")
        );
        assert_eq!(merge_path(cur, &["C:\\windows\\".to_string()]), None);
    }
}
