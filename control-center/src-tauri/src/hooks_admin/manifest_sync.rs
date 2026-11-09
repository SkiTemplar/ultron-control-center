// hooks_admin/manifest_sync.rs — regenera hooks/manifest.json tras guardar.
//
// hooks-8 (auditoría 2026-10-23): añadir, editar, activar o borrar un hook
// desde la pestaña Hooks solo tocaba ~/.claude/settings.json; manifest.json y
// templates/settings-hooks.json quedaban desfasados y el siguiente commit
// fallaba en el gate `node hooks/regen-manifest.js --check`. Tras cada
// cambio se ejecuta el mismo regen-manifest.js y su resultado viaja en
// `HookMutationResult.manifest_sync`, para que la UI lo enseñe.

use std::process::Command;
use std::time::Duration;

const REGEN_TIMEOUT: Duration = Duration::from_secs(30);

/// Resumen de una línea por cada línea de salida, recortado.
fn summary(stdout: &[u8], stderr: &[u8]) -> String {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines.join(" · ");
    joined.chars().take(400).collect()
}

fn regen() -> Result<String, String> {
    let root = crate::ultron_root()?;
    let script = root.join("hooks").join("regen-manifest.js");
    if !script.exists() {
        return Err(format!("no existe {}", script.display()));
    }
    let mut cmd = Command::new("node");
    cmd.arg(&script).current_dir(&root);
    let out = crate::ai_router::exec::run_with_timeout(cmd, REGEN_TIMEOUT, None)
        .map_err(|e| format!("node: {e}"))?;
    let text = summary(&out.stdout, &out.stderr);
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            format!("salida {:?}", out.status.code())
        } else {
            text
        })
    }
}

/// Regenera el manifest y devuelve el texto para la UI. Nunca falla: un error
/// se devuelve como texto, porque el cambio en settings.json ya está hecho.
pub fn sync_manifest() -> String {
    match regen() {
        Ok(text) => text,
        Err(e) => format!("manifest sin regenerar: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::summary;

    #[test]
    fn summary_une_lineas_y_quita_vacias() {
        let s = summary(
            b"manifest regenerado: 31 hooks\n\n",
            b"AVISO descripciones TODO: x\n",
        );
        assert_eq!(
            s,
            "manifest regenerado: 31 hooks · AVISO descripciones TODO: x"
        );
    }

    #[test]
    fn summary_recorta_a_400() {
        let big = "x".repeat(1000);
        assert_eq!(summary(big.as_bytes(), b"").chars().count(), 400);
    }
}
