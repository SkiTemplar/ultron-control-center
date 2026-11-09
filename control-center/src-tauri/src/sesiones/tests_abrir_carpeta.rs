// sesiones/tests_abrir_carpeta.rs — Parseo y validación de `--sesiones` y
// `--sesiones-cwd <ruta>` (entrada «ULTRON Sessions aquí» del Explorador).

use super::*;

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn sin_argumentos_de_sessions_no_hay_peticion() {
    assert_eq!(peticion_de(&args(&["control-center.exe"])), None);
    assert_eq!(
        peticion_de(&args(&["control-center.exe", "--from-autostart"])),
        None
    );
}

#[test]
fn sesiones_solo_pide_la_ventana() {
    assert_eq!(
        peticion_de(&args(&["x.exe", "--sesiones"])),
        Some(Peticion::Ventana)
    );
}

#[test]
fn sesiones_cwd_con_espacio_o_igual() {
    let esperada = Some(Peticion::Carpeta(r"C:\Mis cosas".into()));
    assert_eq!(
        peticion_de(&args(&["x.exe", "--sesiones-cwd", r"C:\Mis cosas"])),
        esperada
    );
    assert_eq!(
        peticion_de(&args(&["x.exe", r"--sesiones-cwd=C:\Mis cosas"])),
        esperada
    );
    // `--sesiones-cwd` manda sobre `--sesiones`, vaya antes o después.
    assert_eq!(
        peticion_de(&args(&[
            "x.exe",
            "--sesiones",
            "--sesiones-cwd",
            r"C:\Mis cosas"
        ])),
        esperada
    );
}

#[test]
fn sesiones_cwd_sin_ruta_es_error_negativo() {
    assert_eq!(
        peticion_de(&args(&["x.exe", "--sesiones-cwd"])),
        Some(Peticion::SinRuta)
    );
    assert_eq!(
        peticion_de(&args(&["x.exe", "--sesiones-cwd", "--from-autostart"])),
        Some(Peticion::SinRuta)
    );
    assert_eq!(
        peticion_de(&args(&["x.exe", "--sesiones-cwd=", "--sesiones"])),
        Some(Peticion::SinRuta)
    );
    assert_eq!(
        peticion_de(&args(&["x.exe", "--sesiones-cwd", "   "])),
        Some(Peticion::SinRuta)
    );
}

#[test]
fn valida_una_carpeta_existente_y_la_canoniza() {
    let d = tempfile::tempdir().expect("tempdir");
    let esperada = sin_prefijo_verbatim(
        &std::fs::canonicalize(d.path())
            .expect("canon")
            .to_string_lossy(),
    );
    let raw = d.path().to_string_lossy().into_owned();
    assert_eq!(validar_carpeta(&raw).as_deref(), Ok(esperada.as_str()));
    assert!(!esperada.starts_with(r"\\?\"));
}

#[cfg(windows)]
#[test]
fn una_comilla_final_es_la_barra_de_una_unidad() {
    // `"C:\"` llega como `C:"`; debe quedar `C:\`.
    let d = tempfile::tempdir().expect("tempdir");
    let raw = format!("{}\"", d.path().to_string_lossy());
    assert!(validar_carpeta(&raw).is_ok(), "{raw}");
    let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    assert_eq!(validar_carpeta(&format!("{sys}\"")), Ok(format!("{sys}\\")));
}

#[test]
fn rechaza_rutas_no_validas_negativo() {
    let d = tempfile::tempdir().expect("tempdir");
    let fichero = d.path().join("a.txt");
    std::fs::write(&fichero, "x").expect("fichero");
    let base = d.path().to_string_lossy().into_owned();
    let casos = [
        String::new(),
        "\"\"".to_string(),
        "relativa".to_string(),
        r".\otra".to_string(),
        format!("{base}{}no-existe", std::path::MAIN_SEPARATOR),
        format!(
            "{base}{}..{}",
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        ),
        fichero.to_string_lossy().into_owned(),
    ];
    for c in casos {
        assert!(validar_carpeta(&c).is_err(), "debía rechazar '{c}'");
    }
}

/// Un UNC se rechaza por el texto: `is_dir` abriría una conexión SMB.
#[test]
fn rechaza_una_ruta_de_red_sin_tocar_el_disco() {
    for c in [r"\\host\s", "//host/s", r#""\\host\s""#, r"\\?\UNC\host\s"] {
        let e = validar_carpeta(c).expect_err(c);
        assert_eq!(e, crate::sesiones::archivos::ERROR_RUTA_DE_RED, "{c}");
    }
}

#[cfg(windows)]
#[test]
fn rechaza_la_ruta_relativa_a_unidad_negativo() {
    // `C:carpeta` es relativa al directorio actual de la unidad.
    assert!(validar_carpeta("C:Windows").is_err());
    assert!(validar_carpeta(r"\Windows").is_err());
}

#[test]
fn quita_el_prefijo_verbatim() {
    assert_eq!(sin_prefijo_verbatim(r"\\?\C:\x"), r"C:\x");
    assert_eq!(sin_prefijo_verbatim(r"\\?\UNC\srv\share"), r"\\srv\share");
    assert_eq!(sin_prefijo_verbatim(r"C:\x"), r"C:\x");
}

#[test]
fn codifica_la_ruta_para_la_url() {
    assert_eq!(
        codificar_url(r"C:\Mis cosas\año&b+c"),
        "C%3A%5CMis%20cosas%5Ca%C3%B1o%26b%2Bc"
    );
    assert_eq!(codificar_url("abc-_.~"), "abc-_.~");
}
