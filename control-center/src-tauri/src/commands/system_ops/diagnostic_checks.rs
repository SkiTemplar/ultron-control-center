//! Comprobaciones por `errorId` de la pestaña Diagnostics (`diagnostics_run`).
//!
//! Una función por comprobación. Todas son bloqueantes (PATH, sockets, git,
//! recorrido de disco): el comando las ejecuta en el pool bloqueante. Ninguna
//! entra en pánico ni devuelve `Err`: el fallo va en `details`.

use std::path::{Path, PathBuf};

use super::diagnostics_native::DiagnosticCheckResult;

/// Ejecuta la comprobación registrada para `error_id`.
pub(super) fn run_check(error_id: &str) -> DiagnosticCheckResult {
    match error_id {
        "claude-login-expired" => check_binary_on_path(
            "claude",
            "fail",
            "Instala Claude Code: npm install -g @anthropic-ai/claude-code",
        ),
        "ai-router-no-keys" => check_ai_keys(),
        "node-not-found" => {
            check_binary_on_path("node", "fail", "Descarga Node.js de https://nodejs.org")
        }
        "qdrant-binary-missing" => check_qdrant_binary(),
        "network-unreachable" => check_network(),
        "port-1420-in-use" => check_port_1420(),
        "gh-cli-missing" => check_binary_on_path(
            "gh",
            "warn",
            "Instálalo con: scoop install gh  O  winget install GitHub.cli",
        ),
        "tauri-capabilities-denied" => check_tauri_capabilities(),
        "plugins-out-of-date" => check_plugin_cache(),
        "hooks-misconfigured" => check_hooks_section(),
        "ultron-disk-usage" => check_disk_usage(),
        "projects-json-missing" => check_projects_json(),
        "git-uncommitted-cockpit" => check_cockpit_uncommitted(),
        other => result(
            "unknown",
            format!("No hay ninguna comprobación registrada en el backend para el id «{other}»."),
            None,
        ),
    }
}

fn result(status: &str, details: String, fix: Option<&str>) -> DiagnosticCheckResult {
    DiagnosticCheckResult {
        status: status.into(),
        details,
        suggested_fix: fix.map(str::to_string),
    }
}

fn ultron_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron"))
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

// ---------------------------------------------------------------------------
// Binarios y claves
// ---------------------------------------------------------------------------

fn check_binary_on_path(name: &str, missing_status: &str, fix: &str) -> DiagnosticCheckResult {
    match which::which(name) {
        Ok(p) => result("ok", format!("{name} encontrado en {}", p.display()), None),
        Err(_) => result(
            missing_status,
            format!("{name} no está en el PATH."),
            Some(fix),
        ),
    }
}

fn check_ai_keys() -> DiagnosticCheckResult {
    const KEYS: [&str; 5] = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
        "DEEPSEEK_API_KEY",
    ];
    let usable =
        |v: String| !v.trim().is_empty() && !v.contains("your-key") && !v.starts_with("xxx");
    let has_any = KEYS
        .iter()
        .any(|k| std::env::var(k).map(usable).unwrap_or(false));
    if has_any {
        let msg = "Hay al menos una API key de un proveedor de IA configurada.";
        return result("ok", msg.into(), None);
    }
    result(
        "warn",
        "No se han detectado API keys de proveedores en la nube en el entorno.".into(),
        Some("Configura ANTHROPIC_API_KEY (o GROQ/GEMINI/OPENAI) en Ajustes > Claves API."),
    )
}

fn check_qdrant_binary() -> DiagnosticCheckResult {
    let found = which::which("qdrant").is_ok()
        || ultron_dir().is_some_and(|u| u.join("qdrant.exe").exists());
    if found {
        return result("ok", "Binario de qdrant encontrado.".into(), None);
    }
    result(
        "warn",
        "qdrant no está en el PATH ni en ~/.ultron/".into(),
        Some("Descárgalo de https://github.com/qdrant/qdrant/releases y deja qdrant.exe en ~/.ultron/"),
    )
}

// ---------------------------------------------------------------------------
// Red y sistema
// ---------------------------------------------------------------------------

fn check_network() -> DiagnosticCheckResult {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([1, 1, 1, 1], 443));
    match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
        Ok(_) => result(
            "ok",
            "1.1.1.1:443 accesible: la red parece estar bien.".into(),
            None,
        ),
        Err(e) => result(
            "fail",
            format!("No se llega a 1.1.1.1:443: {e}"),
            Some(
                "Prueba a vaciar la caché DNS (ipconfig /flushdns) o a renovar la concesión de IP.",
            ),
        ),
    }
}

fn check_port_1420() -> DiagnosticCheckResult {
    match std::net::TcpListener::bind("127.0.0.1:1420") {
        Ok(_) => result("ok", "El puerto 1420 está libre.".into(), None),
        Err(_) => result(
            "warn",
            "El puerto 1420 ya está en uso.".into(),
            Some("Puede que haya otra instancia de Control Center abierta. Abre el Administrador de tareas y finaliza el proceso duplicado."),
        ),
    }
}

fn check_tauri_capabilities() -> DiagnosticCheckResult {
    let cap_path = std::env::current_exe().ok().and_then(|e| {
        e.parent()
            .map(|p| p.join("..").join("capabilities").join("default.json"))
    });
    // Desde dentro no se puede saber si un permiso está bloqueado: solo se
    // confirma que el fichero existe y es JSON válido.
    let intact = cap_path.and_then(|p| read_json(&p)).is_some();
    let (status, detail) = if intact {
        ("ok", "capabilities/default.json existe y es válido.")
    } else {
        (
            "unknown",
            "capabilities/default.json no existe o no se puede leer.",
        )
    };
    result(
        status,
        detail.into(),
        Some("Revisa en src-tauri/capabilities/default.json si faltan scopes de shell o fs."),
    )
}

// ---------------------------------------------------------------------------
// Plugins y hooks
// ---------------------------------------------------------------------------

fn check_plugin_cache() -> DiagnosticCheckResult {
    let cache_exists =
        dirs::home_dir().is_some_and(|h| h.join(".claude/plugins/cache/ecc").exists());
    if cache_exists {
        return result(
            "ok",
            "Caché del plugin ECC encontrada en ~/.claude/plugins/cache/ecc/.".into(),
            None,
        );
    }
    result(
        "warn",
        "No se encuentra la caché del plugin ECC en ~/.claude/plugins/cache/ecc/.".into(),
        Some("Ejecuta /plugin install ecc@ecc en una sesión de Claude Code."),
    )
}

fn check_hooks_section() -> DiagnosticCheckResult {
    let configured = dirs::home_dir()
        .and_then(|h| read_json(&h.join(".claude").join("settings.json")))
        .is_some_and(|v| v.get("hooks").is_some());
    if configured {
        return result(
            "ok",
            "~/.claude/settings.json tiene una sección `hooks`.".into(),
            None,
        );
    }
    result(
        "warn",
        "No hay sección `hooks` en ~/.claude/settings.json.".into(),
        Some("Añade hooks PostToolUse o Stop desde Biblioteca > Hooks o editando ~/.claude/settings.json."),
    )
}

// ---------------------------------------------------------------------------
// Almacenamiento
// ---------------------------------------------------------------------------

/// Carpetas que no cuentan en el uso de disco: artefactos y entornos
/// regenerables (`target/` llegó a ser el 80 % de `~/.ultron`), el historial
/// de git y las copias de trabajo de los subagentes (`.claude/worktrees/`).
const DISK_SKIP_DIRS: [&str; 5] = ["target", "node_modules", ".venv", ".git", "worktrees"];

/// Umbral del aviso, sin contar `DISK_SKIP_DIRS`. Medido el 2026-10-23: ~2,4 GB,
/// de los que 1,2 GB eran `.tmp/`; el aviso señala eso y no `target/`.
const DISK_WARN_MB: u64 = 2_048;

const MB: u64 = 1024 * 1024;

fn is_skipped_dir(name: &str) -> bool {
    DISK_SKIP_DIRS.contains(&name)
}

/// Bytes de un árbol sin seguir enlaces ni entrar en `DISK_SKIP_DIRS`. Una
/// entrada ilegible se salta: un permiso denegado no tumba la comprobación.
fn tree_bytes(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !is_skipped_dir(&entry.file_name().to_string_lossy()) {
                    pending.push(entry.path());
                }
            } else if kind.is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

/// Tamaño de cada hijo directo de `root` (sin `DISK_SKIP_DIRS`), de mayor a
/// menor.
pub(super) fn disk_usage_by_child(root: &Path) -> Vec<(String, u64)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut sizes: Vec<(String, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = entry.file_type().ok()?;
            let bytes = if kind.is_dir() && !is_skipped_dir(&name) {
                tree_bytes(&entry.path())
            } else if kind.is_file() {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            } else {
                return None;
            };
            Some((name, bytes))
        })
        .collect();
    sizes.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
    sizes
}

fn check_disk_usage() -> DiagnosticCheckResult {
    let Some(root) = ultron_dir() else {
        return result(
            "unknown",
            "No se puede resolver la carpeta personal.".into(),
            None,
        );
    };
    disk_usage_result(&disk_usage_by_child(&root))
}

pub(super) fn disk_usage_result(children: &[(String, u64)]) -> DiagnosticCheckResult {
    let total_mb = children.iter().map(|(_, b)| b).sum::<u64>() / MB;
    let top: Vec<String> = children
        .iter()
        .take(3)
        .map(|(name, b)| format!("{name} ({} MB)", b / MB))
        .collect();
    let details = format!(
        "~/.ultron ocupa {total_mb} MB sin contar target/, node_modules/, .venv/, .git ni worktrees. \
         Lo que más ocupa: {}.",
        top.join(", ")
    );
    if total_mb <= DISK_WARN_MB {
        return result("ok", details, None);
    }
    result(
        "warn",
        details,
        Some("Revisa esas carpetas (logs, sesiones o diagnósticos antiguos). Los artefactos de compilación no cuentan aquí: se liberan con cargo clean en control-center/src-tauri."),
    )
}

fn check_projects_json() -> DiagnosticCheckResult {
    let ok = ultron_dir()
        .and_then(|u| read_json(&u.join("cockpit").join("projects.json")))
        .is_some();
    if ok {
        return result(
            "ok",
            "projects.json existe y es un JSON válido.".into(),
            None,
        );
    }
    result(
        "fail",
        "~/.ultron/cockpit/projects.json falta o está corrupto.".into(),
        Some("Abre ~/.ultron/cockpit/ y revisa o vuelve a crear projects.json."),
    )
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

fn check_cockpit_uncommitted() -> DiagnosticCheckResult {
    let Some(cockpit) = ultron_dir().map(|u| u.join("cockpit")) else {
        return result(
            "unknown",
            "No se puede resolver la carpeta personal.".into(),
            None,
        );
    };
    // `-- .` limita el estado a cockpit/: sin él, git lista los cambios de
    // todo el monorepo aunque `-C` apunte a la subcarpeta.
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&cockpit)
        .args(["status", "--porcelain", "--", "."])
        .output();
    let changes = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => {
            let msg = "No se pudo ejecutar git status en ~/.ultron/cockpit/.";
            return result("unknown", msg.into(), None);
        }
    };
    let n = changes.lines().filter(|l| !l.trim().is_empty()).count();
    if n == 0 {
        let msg = "No hay cambios sin commit en ~/.ultron/cockpit/.";
        return result("ok", msg.into(), None);
    }
    result(
        "warn",
        format!("{n} cambio(s) sin commit en ~/.ultron/cockpit/."),
        Some("Abre una terminal en ~/.ultron/ y ejecuta: git add -A && git commit -m 'chore: save cockpit state'"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_tree(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("ultron-diag-disk-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("cockpit/logs")).unwrap();
        std::fs::create_dir_all(root.join("control-center/src-tauri/target/debug")).unwrap();
        std::fs::create_dir_all(root.join("control-center/node_modules/x")).unwrap();
        std::fs::write(root.join("cockpit/logs/a.log"), vec![0u8; 3_000]).unwrap();
        std::fs::write(root.join("control-center/src.rs"), vec![0u8; 500]).unwrap();
        std::fs::write(
            root.join("control-center/src-tauri/target/debug/big.exe"),
            vec![0u8; 50_000],
        )
        .unwrap();
        std::fs::write(
            root.join("control-center/node_modules/x/i.js"),
            vec![0u8; 40_000],
        )
        .unwrap();
        std::fs::write(root.join("top.txt"), vec![0u8; 10]).unwrap();
        root
    }

    #[test]
    fn el_uso_de_disco_no_cuenta_target_ni_node_modules() {
        let root = temp_tree("skip");
        let sizes = disk_usage_by_child(&root);
        let get = |n: &str| sizes.iter().find(|(k, _)| k == n).map(|(_, b)| *b);
        assert_eq!(get("cockpit"), Some(3_000));
        // Caso negativo: con target/ y node_modules/ serían 90 500 bytes.
        assert_eq!(get("control-center"), Some(500));
        assert_eq!(get("top.txt"), Some(10));
        assert_eq!(sizes[0].0, "cockpit", "ordenado de mayor a menor");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn aviso_de_disco_nombra_lo_que_mas_ocupa() {
        let big = vec![("logs".to_string(), (DISK_WARN_MB + 1) * MB)];
        let r = disk_usage_result(&big);
        assert_eq!(r.status, "warn");
        assert!(r.details.contains("logs ("), "{}", r.details);
        assert!(!r.suggested_fix.unwrap().contains("%TEMP%"));

        let small = vec![("cockpit".to_string(), 10 * MB)];
        let ok = disk_usage_result(&small);
        assert_eq!(ok.status, "ok");
        assert!(ok.suggested_fix.is_none());
    }

    #[test]
    fn id_desconocido_es_unknown_y_no_falla() {
        let r = run_check("no-existe");
        assert_eq!(r.status, "unknown");
        assert!(r.details.contains("no-existe"));
    }
}
