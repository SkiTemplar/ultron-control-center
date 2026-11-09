// Título de la sesión desde el transcript: el resumen de Claude Code
// (`ai-title`) pisa al del primer prompt y nunca a uno puesto a mano.

use std::io::Write;

use super::*;
use crate::sesiones::transcript::ParseState;

const RESUMEN: &str = "Arreglo del login con OAuth";

fn alta(titulo: OrigenTitulo, title: &str) -> String {
    let id = format!("titulo-{}", uuid::Uuid::new_v4());
    let mut s = registro::sesion_de_prueba(&id);
    s.titulo = titulo;
    s.info.title = title.to_string();
    registro::insert(s).expect("alta");
    id
}

fn estado(id: &str) -> (OrigenTitulo, String) {
    registro::read(id, |s| (s.titulo, s.info.title.clone())).expect("sesión")
}

fn prompt(texto: &str) -> ChatMessage {
    let v = json!({"type": "user", "uuid": "u1", "timestamp": "t", "message": {"role": "user", "content": texto}});
    parse_value(&v, None, &mut ParseState::default()).expect("prompt")
}

fn linea_ia(t: &str) -> String {
    json!({"type": "ai-title", "aiTitle": t, "sessionId": "s"}).to_string()
}

#[test]
fn el_resumen_pisa_al_prompt_y_no_a_un_nombre_puesto_a_mano() {
    let id = alta(OrigenTitulo::Provisional, "Nueva sesión");
    maybe_title(&id, &prompt("arregla el login que falla con oauth"));
    assert_eq!(
        estado(&id),
        (
            OrigenTitulo::Prompt,
            "arregla el login que falla con oauth".into()
        )
    );
    titulo_de_ia(&id, RESUMEN);
    assert_eq!(estado(&id), (OrigenTitulo::Ia, RESUMEN.into()));
    maybe_title(&id, &prompt("otro prompt"));
    assert_eq!(
        estado(&id).1,
        RESUMEN,
        "un prompt posterior no pisa el resumen"
    );
    // Caso negativo: renombrada a mano, el resumen ya no entra.
    crate::sesiones::gestor::rename(&id, "Login").expect("rename");
    titulo_de_ia(&id, "Otro resumen");
    assert_eq!(estado(&id), (OrigenTitulo::Manual, "Login".into()));
    registro::remove(&id);
}

#[test]
fn una_sesion_guardada_por_la_version_anterior_se_resuelve_con_su_primer_prompt() {
    let auto = alta(OrigenTitulo::Legado, "arregla el login");
    maybe_title(&auto, &prompt("arregla el login"));
    titulo_de_ia(&auto, RESUMEN);
    assert_eq!(estado(&auto), (OrigenTitulo::Ia, RESUMEN.into()));
    // Caso negativo: un título distinto del prompt se puso a mano.
    let manual = alta(OrigenTitulo::Legado, "Login");
    maybe_title(&manual, &prompt("arregla el login"));
    titulo_de_ia(&manual, RESUMEN);
    assert_eq!(estado(&manual), (OrigenTitulo::Manual, "Login".into()));
    registro::remove(&auto);
    registro::remove(&manual);
}

/// De extremo a extremo: una sesión reanudada toma el resumen de la historia
/// del transcript en la primera vuelta del seguidor.
#[test]
fn una_reanudada_toma_el_resumen_de_su_transcript() {
    let dir = tempfile::tempdir().expect("tempdir");
    let id = alta(OrigenTitulo::Provisional, "Reanudada 1234abcd");
    let t = objetivo(
        &id,
        transcript(dir.path(), "arregla el login", Some(RESUMEN)),
    );
    follow_one(&t, &mut Follow::nuevo());
    assert_eq!(estado(&id), (OrigenTitulo::Ia, RESUMEN.into()));
    registro::remove(&id);
}

/// Hallazgo de Codex (2026-10-23): tras `/clear`, el resumen de la
/// conversación anterior no debe quedarse si la nueva aún no tiene el suyo;
/// manda su primer prompt. Un nombre puesto a mano sobrevive al cambio.
#[test]
fn otra_conversacion_sin_resumen_toma_su_primer_prompt_y_respeta_el_manual() {
    let dir = tempfile::tempdir().expect("tempdir");
    let primera = transcript(dir.path(), "arregla el login", Some(RESUMEN));
    let segunda = transcript(dir.path(), "prepara la release", None);
    let auto = alta(OrigenTitulo::Provisional, "Nueva sesión");
    let manual = alta(OrigenTitulo::Manual, "Login");
    for (id, esperado) in [
        (
            &auto,
            (OrigenTitulo::Prompt, "prepara la release".to_string()),
        ),
        (&manual, (OrigenTitulo::Manual, "Login".to_string())),
    ] {
        let mut f = Follow::nuevo();
        follow_one(&objetivo(id, primera.clone()), &mut f);
        follow_one(&objetivo(id, segunda.clone()), &mut f);
        assert_eq!(estado(id), esperado);
        registro::remove(id);
    }
}

/// Transcript con un prompt y, si se pide, su resumen (repetido, como lo
/// escribe Claude Code).
fn transcript(dir: &std::path::Path, texto: &str, resumen: Option<&str>) -> std::path::PathBuf {
    let p = dir.join(format!("{}.jsonl", uuid::Uuid::new_v4()));
    let mut f = std::fs::File::create(&p).expect("crear");
    let pr = json!({"type": "user", "uuid": "u0", "timestamp": "t", "message": {"role": "user", "content": texto}});
    writeln!(f, "{pr}").expect("escribir");
    for _ in 0..2 {
        if let Some(r) = resumen {
            writeln!(f, "{}", linea_ia(r)).expect("escribir");
        }
    }
    p
}

fn objetivo(id: &str, p: std::path::PathBuf) -> FollowTarget {
    FollowTarget {
        id: id.to_string(),
        claude_session_id: p.file_stem().map(|s| s.to_string_lossy().into_owned()),
        slug_dir: p.parent().expect("dir").to_path_buf(),
        transcript: Some(p),
        sid_confirmed: true,
    }
}
