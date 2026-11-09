// Pruebas de la lista de denegación de `read_text_file`.

use std::path::Path;

use super::{project_claude_dirs, read_text_file, secret_file_reason};

#[test]
fn los_ficheros_de_secretos_se_reconocen_sin_distinguir_mayusculas() {
    for ruta in [
        "C:/u/.ultron/.env",
        "C:/u/.ultron/.ENV.local",
        "C:/u/.claude/.credentials.json",
        "C:/u/.ultron/certs/server.key",
        "C:/u/.ultron/certs/ca.PEM",
        "C:/u/.ultron/backup/id_rsa",
        "C:/u/.ultron/backup/id_rsa.pub",
        "C:/u/.ssh/config",
        "C:/u/.ultron/x/.SSH/known_hosts",
    ] {
        assert!(secret_file_reason(Path::new(ruta)).is_some(), "{ruta}");
    }
}

#[test]
fn los_ficheros_normales_no_se_niegan() {
    for ruta in [
        "C:/u/.claude/skills/ultron/SKILL.md",
        "C:/u/.ultron/.env-example.md",
        "C:/u/.ultron/environment.md",
        "C:/u/.ultron/docs/keys.md",
        "C:/u/.ultron/docs/monkey.rs",
        "C:/u/.ultron/ssh/notas.md",
        "C:/u/.ultron/credentials.json.md",
    ] {
        assert_eq!(secret_file_reason(Path::new(ruta)), None, "{ruta}");
    }
}

/// La negación va antes de la comprobación de raíces: un `.env` se rechaza
/// como secreto esté donde esté, y un fichero normal fuera de las raíces
/// sigue cayendo en el error de raíces (caso negativo).
#[test]
fn read_text_file_niega_un_env_con_error_explicito() {
    let d = tempfile::tempdir().expect("tempdir");
    let env = d.path().join(".env");
    std::fs::write(&env, "GROQ_API_KEY=x").expect("env");
    let err = read_text_file(env.to_string_lossy().into_owned()).expect_err("denegado");
    assert!(
        err.contains("read denied") && err.contains("secrets file"),
        "{err}"
    );
    assert!(!err.contains("GROQ_API_KEY"), "no filtra el contenido");

    let normal = d.path().join("notas.md");
    std::fs::write(&normal, "hola").expect("md");
    let err = read_text_file(normal.to_string_lossy().into_owned()).expect_err("fuera");
    assert!(err.contains("outside allowed roots"), "{err}");
}

#[test]
fn de_un_proyecto_solo_se_autoriza_su_carpeta_claude() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let con = tmp.path().join("con");
    std::fs::create_dir_all(con.join(".claude")).expect("carpeta");
    let sin = tmp.path().join("sin");
    std::fs::create_dir_all(&sin).expect("carpeta");
    let (con_str, sin_str) = (con.to_string_lossy(), sin.to_string_lossy());
    let dirs = project_claude_dirs([con_str.as_ref(), sin_str.as_ref(), " "].into_iter());
    assert_eq!(dirs, [con.join(".claude")]);
}
