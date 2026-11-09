use std::path::Path;
use std::process::Command;

/// Ejecuta `git <args>` en el directorio del crate y devuelve su stdout si
/// termina bien. `None` si git no está disponible (build desde un tarball).
fn git(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
}

/// SHA corto de HEAD o "unknown".
fn head_sha() -> String {
    git(&["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// "true" si `control-center/` (crate Rust y frontend que la app embebe) tiene
/// cambios sin commitear, ficheros nuevos sin trackear incluidos; "false" si
/// está limpio; "unknown" sin git. Los ignorados (finance.rs, Finance.tsx) no
/// cuentan: son locales a propósito y no cambian el SHA.
fn tree_dirty() -> &'static str {
    // --no-optional-locks: que `status` no reescriba el índice, que es uno de
    // los disparadores de este script (si no, se re-ejecutaría en cada build).
    match git(&["--no-optional-locks", "status", "--porcelain", "--", ".."]) {
        Some(out) if out.trim().is_empty() => "false",
        Some(_) => "true",
        None => "unknown",
    }
}

/// Re-ejecutar el build script cuando cambie el commit o el árbol, para no
/// embeber un sello viejo. `--git-path` resuelve también en un worktree, donde
/// `.git` es un fichero y no un directorio.
fn rerun_triggers() {
    let git_path =
        |name: &str| git(&["rev-parse", "--git-path", name]).map(|p| p.trim().to_string());
    let mut paths: Vec<String> = ["HEAD", "index", "packed-refs"]
        .iter()
        .filter_map(|n| git_path(n))
        .collect();
    let head_ref = git_path("HEAD")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|h| h.strip_prefix("ref: ").map(|r| r.trim().to_string()));
    if let Some(p) = head_ref.and_then(|r| git_path(&r)) {
        paths.push(p);
    }
    // Directorios: cargo los recorre y compara el mtime más reciente, así que
    // editar un fuente reevalúa `dirty` sin tocar git.
    paths.extend(["build.rs", "Cargo.toml", "Cargo.lock", "src", "../src"].map(String::from));
    // Una ruta inexistente haría que cargo re-ejecutase el script en cada build.
    for p in paths.iter().filter(|p| Path::new(p).exists()) {
        println!("cargo:rerun-if-changed={p}");
    }
}

fn main() {
    // cat7.8 + K1: sello de compilación para verificar exe<->commit sin depender
    // del mtime (un `touch` lo falsea). `ULTRON_GIT_DIRTY` evita que un binario
    // compilado con cambios sin commitear se presente como el SHA de HEAD.
    println!("cargo:rustc-env=ULTRON_GIT_SHA={}", head_sha());
    println!("cargo:rustc-env=ULTRON_GIT_DIRTY={}", tree_dirty());
    rerun_triggers();

    tauri_build::build()
}
