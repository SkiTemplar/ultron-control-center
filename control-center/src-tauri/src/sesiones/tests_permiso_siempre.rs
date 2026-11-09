// sesiones/tests_permiso_siempre.rs — «Permitir siempre» con regla real (H6):
// la regla que se anuncia, la escritura en `settings.local.json` y los casos
// en que no se toca nada.

use serde_json::json;

use super::*;
use crate::sesiones::preguntas::{build_payload, Broker};
use crate::sesiones::test_sink::MockSink;
use crate::sesiones::types::{AskAnswer, PermissionDecision};

fn permiso(tool: &str, input: Value) -> Value {
    json!({ "kind": "permission", "tool": tool, "input": input, "summary": "x" })
}

fn ask_de(sesion: &str, ask: &Value) -> PendingAsk {
    let payload = build_payload(sesion, ask).expect("payload");
    PendingAsk {
        ask_id: payload["askId"].as_str().unwrap_or_default().to_string(),
        sesion_id: sesion.to_string(),
        kind: "permission".to_string(),
        created_at: String::new(),
        payload,
        turn_id: None,
    }
}

fn leer(ruta: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(ruta).expect("leer")).expect("json")
}

#[test]
fn regla_concreta_por_herramienta() {
    assert_eq!(
        regla("Bash", &json!({ "command": "cargo test -q" })).as_deref(),
        Some("Bash(cargo test -q)")
    );
    assert_eq!(
        regla("PowerShell", &json!({ "command": "Get-ChildItem C:\\x" })).as_deref(),
        Some("PowerShell(Get-ChildItem C:\\x)")
    );
    assert_eq!(
        regla(
            "WebFetch",
            &json!({ "url": "https://Docs.RS:443/serde/?q=1" })
        )
        .as_deref(),
        Some("WebFetch(domain:docs.rs)")
    );
    assert_eq!(regla("WebSearch", &json!({})).as_deref(), Some("WebSearch"));
    assert_eq!(
        regla("mcp__github__list_issues", &json!({})).as_deref(),
        Some("mcp__github__list_issues")
    );
}

#[test]
fn sin_regla_concreta_y_segura_no_hay_regla() {
    // Compuestos, comodines, varias líneas y paréntesis del formato de regla.
    for cmd in [
        "git add . && git commit",
        "ls *.rs",
        "echo a\necho b",
        "echo $(whoami)",
        "f (x)",
        "  ",
    ] {
        assert_eq!(regla("Bash", &json!({ "command": cmd })), None, "{cmd:?}");
    }
    let largo = "a".repeat(MAX_COMANDO + 1);
    assert_eq!(regla("Bash", &json!({ "command": largo })), None);
    assert_eq!(regla("Bash", &json!({})), None);
    assert_eq!(
        regla("WebFetch", &json!({ "url": "file:///etc/passwd" })),
        None
    );
    assert_eq!(
        regla("WebFetch", &json!({ "url": "http://localhost/x" })),
        None
    );
    // Herramientas de ficheros: el alcance de una regla de ruta no es evidente.
    assert_eq!(regla("Edit", &json!({ "file_path": "C:\\a.rs" })), None);
    assert_eq!(regla("Read", &json!({ "file_path": "C:\\a.rs" })), None);
    assert_eq!(regla("mcp__", &json!({})), None);
    assert_eq!(regla("mcp__srv__x(y)", &json!({})), None);
}

#[test]
fn anunciar_solo_en_permisos_con_regla_y_sin_pisar_el_del_puente() {
    let p = build_payload("s", &permiso("Bash", json!({ "command": "npm test" }))).expect("p");
    assert_eq!(
        p["always"],
        json!({ "rules": ["Bash(npm test)"], "destination": "localSettings" })
    );

    let sin = build_payload("s", &permiso("Edit", json!({ "file_path": "a" }))).expect("p");
    assert!(sin.get("always").is_none(), "sin regla, sin botón");

    let mut del_puente = permiso("Bash", json!({ "command": "ls" }));
    del_puente["always"] = json!({ "rules": ["Bash(ls:*)"], "destination": "session" });
    let p = build_payload("s", &del_puente).expect("p");
    assert_eq!(p["always"]["destination"], "session");

    let pregunta = build_payload("s", &json!({ "kind": "question", "questions": [] })).expect("p");
    assert!(pregunta.get("always").is_none());
}

#[test]
fn anadir_reglas_crea_conserva_y_no_duplica() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ruta = tmp.path().join(".claude").join("settings.local.json");
    let reglas = vec!["Bash(npm test)".to_string()];
    assert_eq!(anadir_reglas(&ruta, &reglas), Ok(1));
    assert_eq!(
        leer(&ruta)["permissions"]["allow"],
        json!(["Bash(npm test)"])
    );
    // La segunda vez no escribe nada.
    assert_eq!(anadir_reglas(&ruta, &reglas), Ok(0));

    std::fs::write(
        &ruta,
        "\u{feff}{\"env\":{\"A\":\"1\"},\"permissions\":{\"allow\":[\"Read\"],\"deny\":[\"Bash(rm:*)\"]}}",
    )
    .expect("escribir");
    assert_eq!(anadir_reglas(&ruta, &reglas), Ok(1));
    let v = leer(&ruta);
    assert_eq!(v["env"]["A"], "1", "el resto del fichero se conserva");
    assert_eq!(v["permissions"]["deny"], json!(["Bash(rm:*)"]));
    assert_eq!(v["permissions"]["allow"], json!(["Read", "Bash(npm test)"]));
    assert!(!tmp
        .path()
        .join(".claude")
        .join("settings.local.json.tmp")
        .exists());
}

#[test]
fn un_settings_danado_o_con_otra_forma_no_se_toca() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ruta = tmp.path().join("settings.local.json");
    let reglas = vec!["WebSearch".to_string()];
    for texto in [
        "{ esto no es json",
        "[1, 2]",
        "{\"permissions\": []}",
        "{\"permissions\": {\"allow\": \"x\"}}",
    ] {
        std::fs::write(&ruta, texto).expect("escribir");
        assert!(anadir_reglas(&ruta, &reglas).is_err(), "{texto}");
        assert_eq!(
            std::fs::read_to_string(&ruta).expect("leer"),
            texto,
            "intacto"
        );
    }
}

#[test]
fn guardar_escribe_en_el_settings_local_del_cwd() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cwd = tmp.path().to_string_lossy().to_string();
    let ask = ask_de(
        "s",
        &permiso("WebFetch", json!({ "url": "https://docs.rs/x" })),
    );
    guardar(&ask, &cwd).expect("guardar");
    let v = leer(&tmp.path().join(".claude").join("settings.local.json"));
    assert_eq!(
        v["permissions"]["allow"],
        json!(["WebFetch(domain:docs.rs)"])
    );
}

#[test]
fn guardar_falla_sin_regla_sin_carpeta_o_con_un_destino_que_nadie_aplica() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cwd = tmp.path().to_string_lossy().to_string();

    let sin_regla = ask_de("s", &permiso("Edit", json!({ "file_path": "a" })));
    assert!(guardar(&sin_regla, &cwd).unwrap_err().contains("Permitir"));

    let con_regla = ask_de("s", &permiso("Bash", json!({ "command": "ls" })));
    let falta = tmp.path().join("no-existe").to_string_lossy().to_string();
    assert!(guardar(&con_regla, &falta)
        .unwrap_err()
        .contains("no existe"));

    // El puente no aplica `session` ni `userSettings`: contestar «siempre»
    // con ellos sería un «Permitir» disfrazado, así que es un error.
    for destino in ["session", "userSettings"] {
        let mut ask = permiso("Bash", json!({ "command": "ls" }));
        ask["always"] = json!({ "rules": ["Bash(ls)"], "destination": destino });
        let err = guardar(&ask_de("s", &ask), &cwd).unwrap_err();
        assert!(err.contains(destino), "{err}");
    }
    assert!(
        !tmp.path().join(".claude").exists(),
        "el backend no escribe nada"
    );
}

#[test]
fn pendiente_solo_devuelve_asks_sin_resolver() {
    let b = Broker::new();
    let sink = MockSink::default();
    let p = b
        .abrir(
            &sink,
            "s1",
            &permiso("Bash", json!({ "command": "ls" })),
            None,
        )
        .expect("abrir");
    let visto = b.pendiente(&p.ask_id).expect("pendiente");
    assert_eq!(visto.payload["always"]["rules"], json!(["Bash(ls)"]));
    let siempre = AskAnswer::Permission {
        decision: PermissionDecision::AllowAlways,
        reason: None,
    };
    b.answer(&sink, &p.ask_id, siempre).expect("answer");
    assert!(b.pendiente(&p.ask_id).is_none());
    assert!(b.pendiente("no-existe").is_none());
}

#[test]
fn validar_regla_acepta_lo_mismo_que_anuncia_el_backend() {
    for r in [
        "Bash(cargo test -q)",
        "PowerShell(Get-ChildItem C:\\x)",
        "WebFetch(domain:docs.rs)",
        "WebSearch",
        "mcp__github__list_issues",
    ] {
        assert_eq!(validar_regla(r), Ok(()), "{r}");
    }
}

#[test]
fn validar_regla_rechaza_reglas_mal_formadas_o_demasiado_amplias() {
    for r in [
        // Demasiado amplias: la herramienta entera, prefijos y comodines.
        "Bash",
        "PowerShell",
        "WebFetch",
        "Edit",
        "Bash(*)",
        "Bash(ls:*)",
        "Bash(git add . && git commit)",
        "WebFetch(domain:*)",
        "WebFetch(domain:localhost)",
        "mcp__github",
        "mcp__github__*",
        // Servidor o herramienta vacíos: Claude Code podría leer el primero
        // como regla de servidor entero.
        "mcp__github__",
        "mcp____list_issues",
        // Etiquetas de dominio vacías: un sufijo suelto no es un host.
        "WebFetch(domain:.com)",
        "WebFetch(domain:com.)",
        "WebFetch(domain:docs..rs)",
        "Read(//**)",
        // Mal formadas.
        "Bash(ls",
        "Bash(ls))",
        "Bash()",
        "Bash( ls)",
        "WebFetch(docs.rs)",
        "WebFetch(domain:Docs.RS)",
        "WebSearch(x)",
        "",
    ] {
        let err = validar_regla(r).expect_err(r);
        assert!(err.contains("regla rechazada"), "{r}: {err}");
    }
}

#[test]
fn guardar_rechaza_la_regla_del_puente_sin_tocar_el_settings() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cwd = tmp.path().to_string_lossy().to_string();
    // Una regla válida junto a una amplia: no se escribe ninguna.
    let mut ask = permiso("Bash", json!({ "command": "ls" }));
    ask["always"] = json!({ "rules": ["Bash(ls)", "Bash"], "destination": "localSettings" });
    let err = guardar(&ask_de("s", &ask), &cwd).unwrap_err();
    assert!(
        err.contains("regla rechazada") && err.contains("«Bash»"),
        "{err}"
    );
    assert!(
        !tmp.path().join(".claude").exists(),
        "una regla rechazada no deja nada escrito"
    );

    // Caso positivo: la regla concreta del puente sí se guarda.
    let mut ask = permiso("Bash", json!({ "command": "ls" }));
    ask["always"] = json!({ "rules": ["Bash(ls)"], "destination": "localSettings" });
    guardar(&ask_de("s", &ask), &cwd).expect("guardar");
    let v = leer(&tmp.path().join(".claude").join("settings.local.json"));
    assert_eq!(v["permissions"]["allow"], json!(["Bash(ls)"]));
}
