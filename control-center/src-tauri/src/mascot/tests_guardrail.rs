// Tests del guardarraíl de Pupus (guardrail.rs y guardrail_revert.rs). Todo
// corre sobre una carpeta temporal: nunca se toca la carpeta de usuario real.

use super::*;
use std::fs;
use tempfile::TempDir;

fn sandbox() -> (TempDir, Roots) {
    let dir = TempDir::new().unwrap();
    let roots = Roots {
        home: dir.path().join("home"),
        documents: Some(dir.path().join("docs")),
    };
    fs::create_dir_all(roots.home.join(".claude/hooks")).unwrap();
    fs::create_dir_all(roots.documents.clone().unwrap().join("WindowsPowerShell")).unwrap();
    fs::write(roots.home.join(".claude/settings.json"), b"{\"hooks\":{}}").unwrap();
    fs::write(roots.home.join(".claude/hooks/ok.js"), b"// legitimo").unwrap();
    (dir, roots)
}

fn quarantined_files(roots: &Roots) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(&roots.home.join(QUARANTINE_DIR), &mut out);
    out
}

#[test]
fn un_turno_sin_cambios_no_avisa_ni_crea_cuarentena() {
    let (_d, roots) = sandbox();
    let guard = Guard::start_at(roots.clone());
    // Caso negativo: escribir FUERA de la lista protegida no es asunto suyo.
    fs::write(roots.home.join("notas.txt"), b"x").unwrap();
    assert_eq!(guard.finish(), None);
    assert!(
        roots.home.join("notas.txt").exists(),
        "no toca lo no protegido"
    );
    assert!(!roots.home.join(QUARANTINE_DIR).exists());
}

#[test]
fn una_modificacion_se_restaura_y_lo_escrito_queda_en_cuarentena() {
    let (_d, roots) = sandbox();
    let settings = roots.home.join(".claude/settings.json");
    let guard = Guard::start_at(roots.clone());
    fs::write(&settings, b"{\"hooks\":{\"SessionStart\":\"evil\"}}").unwrap();
    let notice = guard.finish().expect("tiene que avisar");
    assert_eq!(fs::read(&settings).unwrap(), b"{\"hooks\":{}}");
    assert!(
        notice.contains("~/.claude/settings.json: modificado → restaurado"),
        "{notice}"
    );
    let q = quarantined_files(&roots);
    assert_eq!(q.len(), 1, "{q:?}");
    assert_eq!(
        fs::read(&q[0]).unwrap(),
        b"{\"hooks\":{\"SessionStart\":\"evil\"}}"
    );
}

#[test]
fn un_hook_creado_se_borra_y_un_fichero_borrado_vuelve() {
    let (_d, roots) = sandbox();
    let guard = Guard::start_at(roots.clone());
    let evil = roots.home.join(".claude/hooks/nuevo/persistencia.js");
    fs::create_dir_all(evil.parent().unwrap()).unwrap();
    fs::write(&evil, b"require('child_process')").unwrap();
    fs::remove_file(roots.home.join(".claude/hooks/ok.js")).unwrap();
    let notice = guard.finish().expect("tiene que avisar");
    assert!(!evil.exists(), "el hook nuevo se va");
    assert!(
        !evil.parent().unwrap().exists(),
        "y su carpeta vacía también"
    );
    assert_eq!(
        fs::read(roots.home.join(".claude/hooks/ok.js")).unwrap(),
        b"// legitimo"
    );
    assert!(notice.contains("creado → borrado"), "{notice}");
    assert!(notice.contains("ok.js: borrado → restaurado"), "{notice}");
    assert_eq!(
        quarantined_files(&roots).len(),
        1,
        "solo lo creado se copia"
    );
}

#[test]
fn en_documentos_solo_se_vigilan_los_perfiles_de_powershell() {
    let (_d, roots) = sandbox();
    let ps = roots.documents.clone().unwrap().join("WindowsPowerShell");
    let guard = Guard::start_at(roots.clone());
    fs::write(ps.join("Microsoft.PowerShell_profile.ps1"), b"iex x").unwrap();
    fs::write(ps.join("notas.txt"), b"mio").unwrap();
    let notice = guard.finish().expect("el perfil nuevo avisa");
    assert!(!ps.join("Microsoft.PowerShell_profile.ps1").exists());
    // Caso negativo: un fichero cualquiera en esa carpeta no se toca.
    assert!(ps.join("notas.txt").exists());
    assert!(!notice.contains("notas.txt"), "{notice}");
}

#[test]
fn un_fichero_grande_se_detecta_y_se_copia_pero_no_se_restaura() {
    let (_d, roots) = sandbox();
    let big = roots.home.join(".claude/hooks/grande.bin");
    fs::write(&big, vec![1u8; (MAX_FILE_BYTES + 1) as usize]).unwrap();
    let guard = Guard::start_at(roots.clone());
    fs::write(&big, vec![2u8; (MAX_FILE_BYTES + 7) as usize]).unwrap();
    let notice = guard.finish().expect("tiene que avisar");
    assert!(notice.contains("NO revertido"), "{notice}");
    assert_eq!(
        fs::read(&big).unwrap()[0],
        2,
        "sin copia previa no se restaura"
    );
    assert_eq!(quarantined_files(&roots).len(), 1);
}

#[test]
fn claude_json_solo_cuenta_si_cambian_mcp_hooks_o_permisos() {
    let (_d, roots) = sandbox();
    let cj = roots.home.join(".claude.json");
    fs::write(
        &cj,
        br#"{"numStartups":1,"mcpServers":{},"projects":{"a":{"x":1}}}"#,
    )
    .unwrap();
    // Caso negativo: lo que reescribe cualquier sesión no se revierte.
    let guard = Guard::start_at(roots.clone());
    let benign = br#"{"numStartups":2,"mcpServers":{},"projects":{"a":{"x":2},"b":{}}}"#;
    fs::write(&cj, benign).unwrap();
    assert_eq!(guard.finish(), None);
    assert_eq!(fs::read(&cj).unwrap(), benign);
    // Un MCP nuevo dentro de un proyecto sí se revierte.
    let guard = Guard::start_at(roots.clone());
    let evil = br#"{"numStartups":2,"mcpServers":{},"projects":{"a":{"mcpServers":{"x":{"command":"evil"}}}}}"#;
    fs::write(&cj, evil).unwrap();
    assert!(guard.finish().is_some());
    assert_eq!(fs::read(&cj).unwrap(), benign);
}

#[test]
fn sin_carpeta_de_usuario_el_aviso_dice_que_no_reviso_nada() {
    let guard = Guard {
        roots: None,
        before: None,
    };
    let notice = guard.finish().expect("no puede callar");
    assert!(notice.contains("inactivo"), "{notice}");
}

#[test]
fn la_cuarentena_cae_fuera_de_las_rutas_protegidas() {
    let (_d, roots) = sandbox();
    let q = roots.home.join(QUARANTINE_DIR);
    for t in targets(&roots) {
        let p = match t {
            Target::File(p) | Target::Dir(p, _) => p,
        };
        assert!(
            !q.starts_with(&p),
            "la cuarentena no puede vigilarse a sí misma: {p:?}"
        );
    }
}

#[test]
fn un_hook_de_mod_o_un_script_inyectados_se_revierten() {
    let (_d, roots) = sandbox();
    for dir in [
        ".ultron/mods/m/hooks",
        ".ultron/scripts",
        ".claude/skills/s",
        ".claude/plugins/cache/p",
    ] {
        fs::create_dir_all(roots.home.join(dir)).unwrap();
    }
    let guard = Guard::start_at(roots.clone());
    let evil = [
        ".ultron/mods/m/hooks/hooks.json",
        ".ultron/scripts/persistir.mjs",
        ".claude/skills/s/SKILL.md",
        ".claude/plugins/cache/p/hooks.json",
        ".codex/AGENTS.md",
        ".gemini/GEMINI.md",
    ];
    fs::create_dir_all(roots.home.join(".codex")).unwrap();
    fs::create_dir_all(roots.home.join(".gemini")).unwrap();
    for f in evil {
        fs::write(roots.home.join(f), b"evil").unwrap();
    }
    let notice = guard.finish().expect("tiene que avisar");
    for f in evil {
        assert!(!roots.home.join(f).exists(), "{f} sigue ahí");
        assert!(notice.contains(f), "{f} no aparece en {notice}");
    }
    // Caso negativo: lo que no se carga como código no se vigila.
    fs::create_dir_all(roots.home.join(".claude/skills/_disabled/x")).unwrap();
    fs::create_dir_all(roots.home.join(".claude/plugins/marketplaces/y")).unwrap();
    let guard = Guard::start_at(roots.clone());
    fs::write(roots.home.join(".claude/skills/_disabled/x/SKILL.md"), b"x").unwrap();
    fs::write(roots.home.join(".claude/plugins/marketplaces/y/z"), b"x").unwrap();
    assert_eq!(guard.finish(), None);
}

#[test]
fn las_carpetas_grandes_no_dejan_sin_presupuesto_a_las_criticas() {
    let (_d, roots) = sandbox();
    let list = targets(&roots);
    let pos = |needle: &str| {
        list.iter()
            .position(|t| {
                let p = match t {
                    Target::File(p) | Target::Dir(p, _) => p,
                };
                p.to_string_lossy().replace('\\', "/").contains(needle)
            })
            .unwrap_or_else(|| panic!("{needle} no está en la lista"))
    };
    for bulk in BULK_DIRS {
        for critical in [
            ".ssh",
            "Programs/Startup",
            "WindowsPowerShell",
            ".claude/hooks",
        ] {
            assert!(
                pos(critical) < pos(bulk),
                "{critical} debe ir antes que {bulk}"
            );
        }
    }
}

/// Paridad con el freno del chat (chat_gate/patterns.rs): lo que uno considera
/// sensible, el otro también. Las excepciones llevan su motivo.
#[test]
fn el_guardarrail_y_el_freno_vigilan_las_mismas_rutas() {
    use crate::mascot::chat_gate::{is_sensitive_path, sensitive_paths};
    // Todo lo que el guardarraíl vigila, el freno lo pregunta.
    let rel = HOME_FILES.iter().chain(&HOME_DIRS).chain(&BULK_DIRS);
    for r in rel {
        let path = format!("C:/Users/u/{r}/x");
        let file = format!("C:/Users/u/{r}");
        assert!(
            is_sensitive_path(&path) || is_sensitive_path(&file),
            "el freno no pregunta por {r}"
        );
    }
    // Rutas del freno que el guardarraíl no puede cubrir enteras.
    const NOT_IN_HOME_LIST: [&str; 14] = [
        "/start menu/programs/startup", // Cubierta con su ruta completa.
        "/microsoft/windows/start menu/",
        "shell:startup",
        "shell:common startup",
        "currentversion/run", // Registro, no un fichero.
        "/system32/tasks",    // Fuera de la carpeta de usuario.
        "/windows/tasks/",
        "/windowspowershell/", // PS_PROFILE_DIRS, bajo Documentos.
        "/documents/powershell/",
        "profile.ps1",
        "$profile",
        "/.git/hooks/", // De cada repo; el sandbox de Codex lo protege (sin medir).
        "/.git/config",
        "/.zprofile", // Sin uso en esta plataforma; `.zshrc` sí va.
    ];
    // `.claude`, `.codex` y `.gemini` enteros cambian solos en cada sesión
    // (transcripts, caché, sqlite): se vigila lo que da ejecución.
    const PARTIAL: [&str; 3] = ["/.claude/", "/.codex/", "/.gemini/"];
    let covered: Vec<String> = HOME_FILES
        .iter()
        .chain(&HOME_DIRS)
        .chain(&BULK_DIRS)
        .map(|r| format!("/{r}/"))
        .collect();
    for s in sensitive_paths() {
        if NOT_IN_HOME_LIST.contains(s) || PARTIAL.contains(s) {
            continue;
        }
        let needle = format!("{}/", s.trim_end_matches('/'));
        assert!(
            covered.iter().any(|c| c.contains(&needle)),
            "el guardarraíl no vigila {s}"
        );
    }
}

/// El caso del hallazgo: A escribe en una ruta protegida, B hace su foto, A
/// revierte y B restauraría la versión de A si se solaparan.
#[test]
fn dos_turnos_solapados_no_reponen_lo_inyectado() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (_d, roots) = sandbox();
    let settings = roots.home.join(".claude/settings.json");
    let original = fs::read(&settings).unwrap();
    let (wrote_tx, wrote_rx) = mpsc::channel();
    let (roots_a, settings_a) = (roots.clone(), settings.clone());
    let a = std::thread::spawn(move || {
        serialized_turn(
            || Guard::start_at(roots_a),
            || {
                fs::write(&settings_a, b"{\"hooks\":\"evil\"}").unwrap();
                wrote_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(300));
            },
        )
    });
    wrote_rx.recv().unwrap();
    let roots_b = roots.clone();
    let b = std::thread::spawn(move || {
        serialized_turn(
            || Guard::start_at(roots_b),
            || std::thread::sleep(Duration::from_millis(600)),
        )
    });
    let (_, notice_a) = a.join().unwrap();
    let (_, notice_b) = b.join().unwrap();
    assert!(notice_a.is_some(), "A revierte");
    assert_eq!(notice_b, None, "B no ve nada que restaurar: {notice_b:?}");
    assert_eq!(
        fs::read(&settings).unwrap(),
        original,
        "lo inyectado no vuelve"
    );
}
