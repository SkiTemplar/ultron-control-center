// Tests de la tarjeta de `Workflow`: journal, meta del script, actividad,
// fusión con el JSON final y seguidor sobre un directorio temporal.
// Fixtures anonimizados en `fixtures/workflows/`.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use super::actividad::Actividad;
use super::meta::parse_meta;
use super::seguidor::{agent_id_valido, en_cache, olvidar, run_vivo, scan, Workflows};
use super::*;

const FIX: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/sesiones/fixtures/workflows/"
);

fn fixture(n: &str) -> String {
    std::fs::read_to_string(format!("{FIX}{n}")).expect("fixture")
}

fn journal_de(n: &str) -> Journal {
    let mut j = Journal::default();
    for l in fixture(n).lines() {
        if let Ok(v) = serde_json::from_str::<Value>(l) {
            j.aplicar(&v);
        }
    }
    j
}

fn componer_con(j: &Journal, final_json: Option<&Value>, viva: bool) -> WorkflowRun {
    let (act, metas) = (HashMap::new(), HashMap::new());
    componer(&Fuentes {
        run_id: "wf_test-001",
        journal: j,
        meta: None,
        final_json,
        actividad: &act,
        metas: &metas,
        inicio_ms: Some(1),
        sesion_viva: viva,
    })
}

fn agente<'a>(r: &'a WorkflowRun, label: &str) -> &'a WorkflowAgent {
    r.agents.iter().find(|a| a.label == label).expect("agente")
}

#[test]
fn el_journal_completo_da_fases_resultados_y_agentes_abiertos() {
    let r = componer_con(&journal_de("journal-completo.jsonl"), None, true);
    assert_eq!(r.status, WorkflowStatus::Running);
    assert_eq!(r.name, "wf_test-001", "sin meta ni final: el runId");
    assert_eq!(agente(&r, "diag:uno").status, WfAgentStatus::Done);
    assert_eq!(
        agente(&r, "diag:uno").result_preview.as_deref(),
        Some("Hallazgo uno")
    );
    let dos = agente(&r, "diag:dos")
        .result_preview
        .clone()
        .unwrap_or_default();
    assert!(
        dos.contains("\"ok\":true"),
        "objeto en JSON compacto: {dos}"
    );
    assert_eq!(agente(&r, "impl:tres").status, WfAgentStatus::Running);
    let fases: Vec<_> = r
        .phases
        .iter()
        .map(|f| (f.title.as_str(), f.total, f.done, f.running))
        .collect();
    assert_eq!(fases, vec![("Diagnose", 2, 2, 0), ("Implement", 1, 0, 1)]);
}

#[test]
fn un_reintento_reutiliza_la_clave_y_sube_el_intento() {
    let j = journal_de("journal-reintento.jsonl");
    assert_eq!(
        j.intentos.len(),
        2,
        "una fila por clave; la desconocida no crea fila"
    );
    let r = componer_con(&j, None, true);
    let m = agente(&r, "impl:motores");
    assert_eq!((m.agent_id.as_str(), m.attempt), ("r1c", 3));
    assert_eq!(m.status, WfAgentStatus::Failed);
    assert_eq!(
        m.result_preview, None,
        "el result tardío del intento viejo no cuenta"
    );
    assert_eq!(agente(&r, "review").phase, "Sin fase");
    assert_eq!(agente(&r, "review").status, WfAgentStatus::Running);
}

#[test]
fn sin_proceso_y_sin_final_los_abiertos_quedan_parados() {
    let r = componer_con(&journal_de("journal-completo.jsonl"), None, false);
    assert_eq!(r.status, WorkflowStatus::Stopped);
    assert_eq!(agente(&r, "impl:tres").status, WfAgentStatus::Stopped);
    assert_eq!(agente(&r, "diag:uno").status, WfAgentStatus::Done);
}

#[test]
fn el_final_completed_aporta_totales_fases_y_datos_por_agente() {
    let fin: Value = serde_json::from_str(&fixture("final-completed.json")).expect("json");
    let r = componer_con(&journal_de("journal-completo.jsonl"), Some(&fin), true);
    assert_eq!(r.status, WorkflowStatus::Completed);
    assert_eq!(
        (r.name.as_str(), r.description.as_str()),
        ("demo-final", "Resumen del run")
    );
    assert_eq!(
        (r.started_at, r.ended_at),
        (Some(1_700_000_000_000), Some(1_700_000_090_000))
    );
    assert_eq!(
        (r.total_tokens, r.total_tool_calls),
        (Some(12345), Some(42))
    );
    assert!(r
        .result_preview
        .as_deref()
        .is_some_and(|s| s.contains("todo bien")));
    let tres = agente(&r, "impl:tres");
    assert_eq!(
        tres.status,
        WfAgentStatus::Done,
        "abierto en el journal, done en el final"
    );
    assert_eq!(
        (tres.context_tokens, tres.tool_calls, tres.duration_ms),
        (Some(5000), Some(7), Some(30000))
    );
    assert_eq!(r.phases[0].detail.as_deref(), Some("lectura"));
}

#[test]
fn el_final_killed_deja_el_error_en_una_linea_y_los_abiertos_parados() {
    let fin: Value = serde_json::from_str(&fixture("final-killed.json")).expect("json");
    let r = componer_con(&journal_de("journal-completo.jsonl"), Some(&fin), true);
    assert_eq!(r.status, WorkflowStatus::Killed);
    assert_eq!(r.error.as_deref(), Some("Error: Workflow aborted"));
    assert_eq!(r.result_preview, None, "\"null\" no es un resultado");
    let tres = agente(&r, "impl:tres");
    assert_eq!((tres.status, tres.attempt), (WfAgentStatus::Stopped, 2));
    assert_eq!(agente(&r, "diag:dos").status, WfAgentStatus::Cached);
}

#[test]
fn un_final_mas_viejo_que_el_journal_no_cuenta() {
    assert!(final_vigente(10_000, 10_000));
    assert!(final_vigente(9_000, 10_000), "margen de 2 s");
    assert!(
        !final_vigente(5_000, 10_000),
        "reanudado: el JSON es del run anterior"
    );
}

#[test]
fn el_meta_multilinea_se_lee_sin_evaluar_js() {
    let m = parse_meta(&fixture("script-meta-multilinea.js")).expect("meta");
    assert_eq!(m.name.as_deref(), Some("demo-multilinea"));
    assert_eq!(
        m.description.as_deref(),
        Some("Descripción con \"comillas\" y acentos: fusión")
    );
    let titulos: Vec<_> = m.phases.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(
        titulos,
        vec!["Diagnose", "Implement", "Review"],
        "ni la comentada ni la de fuera"
    );
    assert_eq!(m.phases[0].1.as_deref(), Some("lectura y diseño"));
}

#[test]
fn el_meta_en_linea_salta_expresiones_y_spread() {
    let m = parse_meta(&fixture("script-meta-enlinea.js")).expect("meta");
    assert_eq!(m.name.as_deref(), Some("demo-enlinea"));
    let fases: Vec<_> = m
        .phases
        .iter()
        .map(|(t, d)| (t.as_str(), d.as_deref()))
        .collect();
    assert_eq!(fases, vec![("Cerrar", Some("fin")), ("Publicar", None)]);
}

#[test]
fn sin_meta_exportado_no_hay_meta() {
    assert_eq!(parse_meta(&fixture("script-sin-meta.js")), None);
    assert_eq!(parse_meta("export const meta = cargar()"), None);
}

#[test]
fn la_actividad_toma_el_ultimo_uso_de_cada_mensaje() {
    let mut a = Actividad::default();
    for l in fixture("agent-stream.jsonl").lines() {
        a.feed(&serde_json::from_str(l).expect("línea"));
    }
    assert_eq!(
        a.contexto,
        Some(2 + 1000 + 100 + 7832),
        "no el 8 de la primera línea"
    );
    assert_eq!(a.llamadas(), 1, "el mismo tool_use repetido cuenta una vez");
    assert_eq!(
        a.ultima.as_deref(),
        Some("Bash: cargo test --lib workflows")
    );
    let (p, u) = (a.primero_ms.expect("primero"), a.ultimo_ms.expect("último"));
    assert_eq!(u - p, 60_000);
}

fn escribir(p: &Path, s: &str) {
    std::fs::create_dir_all(p.parent().expect("padre")).expect("dir");
    std::fs::write(p, s).expect("escribir");
}

fn anadir(p: &Path, s: &str) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(p)
        .expect("abrir");
    f.write_all(s.as_bytes()).expect("añadir");
}

#[test]
fn el_seguidor_emite_al_crecer_y_no_reemite_sin_cambios() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ses = tmp.path();
    let run = ses.join("subagents/workflows/wf_test-001");
    let journal = run.join("journal.jsonl");
    escribir(&journal, "{\"type\":\"launched\"}\n");
    escribir(
        &run.join("agent-aaa111.jsonl"),
        &fixture("agent-stream.jsonl"),
    );
    escribir(&ses.join("subagents/workflows/no-es-run/journal.jsonl"), "");
    escribir(
        &ses.join("workflows/scripts/demo-wf_test-001.js"),
        &fixture("script-meta-multilinea.js"),
    );
    let proceso = Some(SystemTime::now() - Duration::from_secs(60));
    let mut w = Workflows::default();
    let t0 = Instant::now();
    let r = w.seguir(ses, proceso, t0);
    assert_eq!(r.len(), 1, "solo los directorios wf_*");
    assert_eq!(
        (r[0].name.as_str(), r[0].phases.len()),
        ("demo-multilinea", 3)
    );
    assert!(
        w.seguir(ses, proceso, t0 + Duration::from_secs(1))
            .is_empty(),
        "sin cambios"
    );
    anadir(&journal, "{\"type\":\"started\",\"key\":\"v2:k1\",\"agentId\":\"aaa111\",\"label\":\"diag:uno\",\"phase\":\"Diagnose\"}\n");
    let r = w.seguir(ses, proceso, t0 + Duration::from_secs(2));
    assert_eq!(r.len(), 1);
    let a = &r[0].agents[0];
    assert_eq!((a.status, a.tool_calls), (WfAgentStatus::Running, Some(1)));
    escribir(
        &ses.join("workflows/wf_test-001.json"),
        &fixture("final-completed.json"),
    );
    let r = w.seguir(ses, proceso, t0 + Duration::from_secs(3));
    assert_eq!(r[0].status, WorkflowStatus::Completed);
    assert_eq!(w.todos().len(), 1);
}

#[test]
fn scan_reconstruye_desde_disco_y_sin_directorio_no_hay_runs() {
    let tmp = tempfile::tempdir().expect("tempdir");
    assert!(scan(tmp.path(), None).is_empty(), "sin subagents/workflows");
    let run = tmp.path().join("subagents/workflows/wf_test-001");
    escribir(
        &run.join("journal.jsonl"),
        &fixture("journal-completo.jsonl"),
    );
    let r = scan(tmp.path(), None);
    assert_eq!(r.len(), 1);
    assert_eq!(
        r[0].status,
        WorkflowStatus::Stopped,
        "sin proceso ni final: parado"
    );
    assert_eq!(r[0].agents.len(), 3);
}

#[test]
fn un_run_de_un_proceso_anterior_no_cuenta_como_vivo() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let j = tmp.path().join("journal.jsonl");
    escribir(&j, "{}\n");
    let antes = SystemTime::now() - Duration::from_secs(60);
    assert!(run_vivo(&j, Some(antes)), "lanzado por el proceso actual");
    let despues = SystemTime::now() + Duration::from_secs(60);
    assert!(
        !run_vivo(&j, Some(despues)),
        "el proceso arrancó después del último cambio"
    );
    assert!(!run_vivo(&j, None), "sesión cerrada");
}

/// Comprobación manual contra runs reales:
/// `ULTRON_WF_SESION=<slug>/<sid> cargo test --lib runs_reales -- --ignored --nocapture`.
#[test]
#[ignore = "lee runs reales del disco del usuario"]
fn runs_reales_coinciden_con_su_json_final() {
    let Ok(d) = std::env::var("ULTRON_WF_SESION") else {
        return;
    };
    let dir = Path::new(&d);
    for r in scan(dir, Some(SystemTime::UNIX_EPOCH)) {
        let fin = std::fs::read_to_string(dir.join(format!("workflows/{}.json", r.run_id)))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let esperado = fin
            .as_ref()
            .and_then(|v| v.get("status")?.as_str().map(str::to_string));
        eprintln!(
            "{} {:?} esperado={esperado:?} agentes={} fases={}",
            r.run_id,
            r.status,
            r.agents.len(),
            r.phases.len()
        );
        if r.status != WorkflowStatus::Running {
            let st = serde_json::to_value(r.status).expect("estado");
            assert_eq!(st.as_str(), esperado.as_deref(), "{}", r.run_id);
        }
    }
}

#[test]
fn un_agent_id_con_separadores_no_sale_del_directorio_del_run() {
    assert!(agent_id_valido("aaa111"));
    assert!(agent_id_valido("a_b-C9"));
    for malo in ["", "../x", "x/y", r"x\y", "a.b", "a b", "ñ"] {
        assert!(!agent_id_valido(malo), "{malo:?} debe rechazarse");
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let ses = tmp.path();
    let run = ses.join("subagents/workflows/wf_test-001");
    std::fs::create_dir_all(run.join("agent-x")).expect("dir");
    let fuera = ses.join("subagents/workflows/evil.jsonl");
    escribir(&fuera, &fixture("agent-stream.jsonl"));
    escribir(
        &run.join("agent-aaa111.jsonl"),
        &fixture("agent-stream.jsonl"),
    );
    let mut j = String::from("{\"type\":\"launched\"}\n");
    for id in ["x/../../evil", "aaa111"] {
        j.push_str(&format!(
            "{{\"type\":\"started\",\"key\":\"k-{n}\",\"agentId\":\"{id}\",\"label\":\"l{n}\"}}\n",
            n = id.len()
        ));
    }
    let journal = run.join("journal.jsonl");
    escribir(&journal, "");
    let proceso = Some(SystemTime::now() - Duration::from_secs(60));
    let mut w = Workflows::default();
    let t0 = Instant::now();
    w.seguir(ses, proceso, t0);
    anadir(&journal, &j);
    let r = w.seguir(ses, proceso, t0 + Duration::from_secs(1));
    let malo = r[0].agents.iter().find(|a| a.agent_id.contains(".."));
    let bueno = r[0].agents.iter().find(|a| a.agent_id == "aaa111");
    assert_eq!(malo.expect("malo").tool_calls, None, "no lee fuera del run");
    assert_eq!(bueno.expect("bueno").tool_calls, Some(1));
}

/// Un run cuyo directorio desaparece deja de seguirse y la foto en caché se
/// vuelve a guardar sin él, aunque ningún otro run haya cambiado.
#[test]
fn un_run_cuyo_directorio_desaparece_se_retira_de_la_foto() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let ses = tmp.path();
    let base = ses.join("subagents/workflows");
    for run in ["wf_test-001", "wf_test-002"] {
        escribir(
            &base.join(run).join("journal.jsonl"),
            "{\"type\":\"launched\"}
",
        );
    }
    let id = format!("wf-retirado-{}", uuid::Uuid::new_v4());
    let proceso = Some(SystemTime::now() - Duration::from_secs(60));
    let mut w = Workflows::default();
    let t0 = Instant::now();
    assert_eq!(w.seguir_y_guardar(&id, ses, proceso, t0).len(), 2);
    assert_eq!(en_cache(&id).map(|v| v.len()), Some(2));

    std::fs::remove_dir_all(base.join("wf_test-002")).expect("borrar run");
    let r = w.seguir_y_guardar(&id, ses, proceso, t0 + Duration::from_secs(1));
    assert!(r.is_empty(), "nada que emitir");
    let ids = |v: Vec<WorkflowRun>| v.into_iter().map(|r| r.run_id).collect::<Vec<_>>();
    assert_eq!(ids(w.todos()), vec!["wf_test-001"]);
    assert_eq!(ids(en_cache(&id).expect("foto")), vec!["wf_test-001"]);
    olvidar(&id);
}
