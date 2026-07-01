use std::process::Command;

fn main() {
    // cat7.8: embebe el SHA corto de HEAD en build time para verificar exe<->commit
    // sin depender del mtime (un `touch` lo falsea). Sin dependencias nuevas.
    // Fallback "unknown" si git no esta disponible (p.ej. build desde tarball sin .git).
    let sha = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=ULTRON_GIT_SHA={sha}");

    // Re-ejecutar el build script cuando cambie el commit checked-out para no
    // embeber un SHA stale: HEAD (cambio de rama/checkout) y el ref al que apunta
    // (nuevo commit en la misma rama). Rutas relativas al crate root (.git del monorepo).
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../../.git/HEAD") {
        if let Some(ref_path) = head.strip_prefix("ref: ").map(str::trim) {
            println!("cargo:rerun-if-changed=../../.git/{ref_path}");
        }
    }

    tauri_build::build()
}
