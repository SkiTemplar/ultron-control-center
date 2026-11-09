// sesiones/tests_comando_run.rs — `sesiones_run_command` sobre todo el
// catálogo con un escritor espía (§2.2, §8.4, AC-1, AC-2, AC-3, AC-22).

use std::sync::Mutex;

use super::*;
use crate::sesiones::catalogo::meta::{BUILTIN_META, MOD_META};
use crate::sesiones::catalogo::NOTA_NO_CATALOGADO;
use crate::sesiones::types::CommandInfoLive;

const T0: Ms = 1_700_000_000_000;

#[derive(Default)]
struct Espia(Mutex<Vec<String>>);

impl Escritor for Espia {
    fn escribir(&self, _id: &str, envio: &Envio) -> Result<(), String> {
        self.0.lock().expect("espía").push(envio.texto.clone());
        Ok(())
    }
}

impl Espia {
    fn textos(&self) -> Vec<String> {
        self.0.lock().expect("espía").clone()
    }
}

/// H3: `/effort <nivel>` escrito se conserva; sin nivel o en cola se avisa; y
/// un nivel inventado o un comando distinto no tocan la configuración.
#[test]
fn effort_escrito_decide_que_se_conserva() {
    let w = CommandDisposition::Written;
    assert_eq!(
        effort_escrito("effort", " high ", w),
        EffortEscrito::Conservar("high".into())
    );
    assert_eq!(
        effort_escrito("/effort", "max", CommandDisposition::Menu),
        EffortEscrito::Conservar("max".into())
    );
    assert_eq!(
        effort_escrito("effort", "", CommandDisposition::Menu),
        EffortEscrito::Avisar
    );
    assert_eq!(effort_escrito("effort", "turbo", w), EffortEscrito::Avisar);
    assert_eq!(
        effort_escrito("effort", "high", CommandDisposition::Queued),
        EffortEscrito::Avisar,
        "en cola aún no se ha aplicado"
    );
    assert_eq!(effort_escrito("model", "high", w), EffortEscrito::Nada);
    assert_eq!(
        effort_escrito("effort", "high", CommandDisposition::Unsupported),
        EffortEscrito::Nada
    );
}

fn ctx(status: SessionStatus, screen: ScreenState) -> Contexto {
    Contexto {
        status,
        screen,
        protocolo: 0,
        terminal: false,
        limite: false,
    }
}

fn libre() -> Contexto {
    ctx(SessionStatus::Idle, ScreenState::Prompt)
}

/// Lista viva con todos los integrados, todos los comandos de mods de
/// ULTRON y un plugin del marketplace.
fn viva() -> Vec<CommandDef> {
    let item = |name: &str, source: &str, plugin: Option<&str>| CommandInfoLive {
        name: name.into(),
        description: String::new(),
        source: source.into(),
        plugin: plugin.map(str::to_string),
        immediate: None,
    };
    let mut v: Vec<CommandInfoLive> = BUILTIN_META
        .iter()
        .map(|m| item(m.nombre, "builtin", None))
        .collect();
    v.extend(MOD_META.iter().map(|m| item(m.nombre, "plugin", m.plugin)));
    v.push(item("codex:rescue", "plugin", Some("codex")));
    catalogo::fusionar_viva(&v)
}

fn correr(
    cmd: &str,
    args: &str,
    c: Contexto,
    cat: &[CommandDef],
    es_viva: bool,
    w: &Espia,
) -> Result<CommandOutcome, String> {
    let id = format!("run-{}", uuid::Uuid::new_v4());
    let p = Peticion {
        id: &id,
        command: cmd,
        args,
        client_id: "c1",
        ctx: c,
        catalogo: cat,
        viva: es_viva,
    };
    ejecutar_con(&p, w, T0)
}

#[test]
fn ningun_unsupported_llega_al_pty_y_nunca_hay_panel_ni_terminal() {
    let cat = viva();
    let w = Espia::default();
    let mut esperados = 0;
    for d in &cat {
        let o = correr(&d.name, "", libre(), &cat, true, &w).expect(&d.name);
        assert!(
            !matches!(
                o.disposition,
                CommandDisposition::Panel | CommandDisposition::Terminal
            ),
            "/{} no puede abrir panel ni terminal",
            d.name
        );
        if d.kind == CommandKind::Unsupported {
            assert_eq!(
                o.disposition,
                CommandDisposition::Unsupported,
                "/{}",
                d.name
            );
            assert!(
                o.note.as_deref().is_some_and(|n| !n.is_empty()),
                "/{} sin nota",
                d.name
            );
        } else {
            esperados += 1;
        }
    }
    let escritos = w.textos();
    assert_eq!(
        escritos.len(),
        esperados,
        "solo escriben las clases ejecutables"
    );
    for d in cat.iter().filter(|d| d.kind == CommandKind::Unsupported) {
        assert!(
            !escritos.contains(&format!("/{}", d.name)),
            "/{} escrito",
            d.name
        );
    }
}

#[test]
fn config_es_menu_y_con_argumentos_es_local() {
    let cat = viva();
    let w = Espia::default();
    let o = correr("config", "", libre(), &cat, true, &w).expect("config");
    assert_eq!(o.disposition, CommandDisposition::Menu);
    let o = correr("config", "theme=dark", libre(), &cat, true, &w).expect("k=v");
    assert_eq!(o.disposition, CommandDisposition::Written);
    assert_eq!(w.textos(), vec!["/config", "/config theme=dark"]);
}

#[test]
fn skills_tasks_e_import_segun_argumentos() {
    let cat = viva();
    let w = Espia::default();
    for c in ["skills", "tasks", "import"] {
        let o = correr(c, "", libre(), &cat, true, &w).expect(c);
        assert_eq!(o.disposition, CommandDisposition::Menu, "/{c}");
    }
    let o = correr("import", "--dry-run", libre(), &cat, true, &w).expect("import");
    assert_eq!(o.disposition, CommandDisposition::Written);
}

#[test]
fn desconocido_con_y_sin_lista_viva() {
    let cat = viva();
    let w = Espia::default();
    let err = correr("nada-de-nada", "", libre(), &cat, true, &w).expect_err("con lista viva");
    assert!(err.starts_with("Comando desconocido"), "{err}");
    let solo_integrados: Vec<CommandDef> = cat
        .iter()
        .filter(|d| d.source == "builtin")
        .cloned()
        .collect();
    let o =
        correr("codex:rescue", "x", libre(), &solo_integrados, false, &w).expect("sin lista viva");
    assert_eq!(o.note.as_deref(), Some(NOTA_NO_CATALOGADO));
    assert_eq!(w.textos(), vec!["/codex:rescue x"]);
    let o = correr("codex:rescue", "y", libre(), &cat, true, &w).expect("plugin vivo");
    assert_eq!(o.disposition, CommandDisposition::Written);
}

#[test]
fn ocupada_inmediato_al_pty_y_el_resto_a_la_cola() {
    let cat = viva();
    let w = Espia::default();
    let ocupada = ctx(SessionStatus::Working, ScreenState::Busy);
    let o = correr("model", "claude-opus-5-5", ocupada, &cat, true, &w).expect("model");
    assert_eq!(o.disposition, CommandDisposition::Written);
    let o = correr("compact", "", ocupada, &cat, true, &w).expect("compact");
    assert_eq!(o.disposition, CommandDisposition::Queued);
    let esperando = ctx(SessionStatus::Waiting, ScreenState::Dialog);
    let o = correr("status", "", esperando, &cat, true, &w).expect("status");
    assert_eq!(
        o.disposition,
        CommandDisposition::Queued,
        "en waiting nunca se escribe"
    );
    assert_eq!(w.textos(), vec!["/model claude-opus-5-5"]);
    let fuera = correr(
        "cost",
        "",
        ctx(SessionStatus::Exited, ScreenState::Unknown),
        &cat,
        true,
        &w,
    );
    assert_eq!(fuera, Err("la sesión terminó".into()));
}

#[test]
fn con_puente_v2_en_reposo_los_locales_van_al_buzon_y_si_falla_al_pty() {
    let cat = viva();
    let w = Espia::default();
    let mut c = libre();
    c.protocolo = 2;
    assert_eq!(decidir(CommandKind::Local, false, &c), Ruta::Buzon);
    let o = correr("cost", "", c, &cat, true, &w).expect("cost");
    assert_eq!(
        o.disposition,
        CommandDisposition::Menu,
        "/cost es alias de /usage (menú)"
    );
    let o = correr("compact", "", c, &cat, true, &w).expect("compact");
    assert_eq!(o.disposition, CommandDisposition::Written);
    assert!(
        w.textos().contains(&"/compact".to_string()),
        "buzón sin hello: reserva por el PTY"
    );
}
