// sesiones/tests_cola.rs — Cola única por sesión con un escritor espía
// (contrato de estabilidad, §5.2, AC-10, AC-23).

use std::sync::Mutex;

use super::emparejar::AVISO_POPALL;
use super::*;
use crate::sesiones::transcript::clases::OpCola;

pub(super) const T0: Ms = 1_700_000_000_000;

#[derive(Default)]
pub(super) struct Espia {
    escritos: Mutex<Vec<Envio>>,
    falla: Option<String>,
}

impl Escritor for Espia {
    fn escribir(&self, _id: &str, envio: &Envio) -> Result<(), String> {
        if let Some(e) = &self.falla {
            return Err(e.clone());
        }
        self.escritos.lock().expect("espía").push(envio.clone());
        Ok(())
    }
}

impl Espia {
    pub(super) fn textos(&self) -> Vec<String> {
        self.escritos
            .lock()
            .expect("espía")
            .iter()
            .map(|e| e.texto.clone())
            .collect()
    }
}

pub(super) fn ctx(status: SessionStatus) -> Contexto {
    Contexto {
        status,
        screen: ScreenState::Prompt,
        protocolo: 0,
        terminal: false,
        limite: false,
    }
}

pub(super) fn item(id: &str, text: &str) -> QueueItemInput {
    QueueItemInput {
        client_id: id.into(),
        text: text.into(),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Prompt,
    }
}

pub(super) fn estado(c: &Colas, id: &str) -> Vec<QueueState> {
    c.lista("s", T0)
        .iter()
        .filter(|i| i.client_id == id)
        .map(|i| i.state)
        .collect()
}

#[test]
fn dos_en_cola_e_idle_sale_uno_por_turno() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    c.encolar("s", item("b", "dos"), T0).expect("b");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("a".into()))
    );
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(None),
        "uno en vuelo"
    );
    assert_eq!(w.textos(), vec!["uno"]);
    c.entregado("s", "uno", "u1", false, T0)
        .expect("emparejado");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("b".into()))
    );
    assert_eq!(w.textos(), vec!["uno", "dos"]);
}

#[test]
fn trabajando_no_escribe_nada() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    assert_eq!(c.drenar("s", ctx(SessionStatus::Working), &w, T0), Ok(None));
    let mut sin_prompt = ctx(SessionStatus::Idle);
    sin_prompt.screen = ScreenState::Dialog;
    assert_eq!(c.drenar("s", sin_prompt, &w, T0), Ok(None));
    let mut con_terminal = ctx(SessionStatus::Idle);
    con_terminal.terminal = true;
    assert_eq!(c.drenar("s", con_terminal, &w, T0), Ok(None));
    assert!(w.textos().is_empty());
}

/// En el límite de uso ni drena ni sale un envío automático: entra en la cola.
/// «Enviar ya» sigue escribiendo (decide el usuario).
#[test]
fn con_el_limite_no_drena_y_lo_nuevo_se_encola() {
    let c = Colas::default();
    let w = Espia::default();
    let mut limite = ctx(SessionStatus::Idle);
    limite.limite = true;
    c.encolar("s", item("a", "uno"), T0).expect("a");
    assert_eq!(c.drenar("s", limite, &w, T0), Ok(None));
    let r = c
        .enviar("s", item("b", "dos"), SendMode::Auto, limite, &w, T0)
        .expect("b");
    assert!(w.textos().is_empty(), "nada contra el aviso");
    assert_eq!(r.disposition, SendDisposition::Queued);
    c.enviar_ya("s", Some("a"), limite, &w, T0)
        .expect("enviar ya");
    assert_eq!(w.textos(), ["uno"]);
}

/// Caso negativo: sin límite, la misma cola drena.
#[test]
fn sin_el_limite_la_misma_cola_drena() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    let r = c.drenar("s", ctx(SessionStatus::Idle), &w, T0);
    assert_eq!(r, Ok(Some("a".to_string())));
    assert_eq!(w.textos(), ["uno"]);
}

#[test]
fn un_fallo_de_escritura_deja_failed_con_el_error_y_para() {
    let c = Colas::default();
    let w = Espia {
        falla: Some("la sesión terminó".into()),
        ..Espia::default()
    };
    c.encolar("s", item("a", "uno"), T0).expect("a");
    c.encolar("s", item("b", "dos"), T0).expect("b");
    let r = c.drenar("s", ctx(SessionStatus::Idle), &w, T0);
    assert_eq!(r, Err("la sesión terminó".into()));
    let l = c.lista("s", T0);
    assert_eq!(l[0].state, QueueState::Failed);
    assert_eq!(l[0].error.as_deref(), Some("la sesión terminó"));
    assert_eq!(
        l[1].state,
        QueueState::Queued,
        "el siguiente no sale en el mismo drenaje"
    );
    let l = c.reintentar("s", "a", T0).expect("reintentar");
    assert_eq!(
        (l[0].client_id.as_str(), l[0].state),
        ("a", QueueState::Queued)
    );
}

#[test]
fn dos_ventanas_alta_y_baja_un_solo_estado() {
    let c = Colas::default();
    c.encolar("s", item("a", "uno"), T0).expect("ventana 1");
    let l = c.encolar("s", item("a", "uno"), T0).expect("ventana 2");
    assert_eq!(l.len(), 1, "idempotente por clientId");
    c.quitar("s", "a", T0).expect("ventana 1 borra");
    assert!(c.quitar("s", "a", T0).expect("ventana 2 borra").is_empty());
}

#[test]
fn enviar_dos_veces_el_mismo_client_id_escribe_una() {
    let c = Colas::default();
    let w = Espia::default();
    let i = ctx(SessionStatus::Idle);
    let a = c
        .enviar("s", item("a", "hola"), SendMode::Auto, i, &w, T0)
        .expect("1");
    let b = c
        .enviar("s", item("a", "hola"), SendMode::Auto, i, &w, T0)
        .expect("2");
    assert_eq!(a.disposition, SendDisposition::Written);
    assert_eq!(b.disposition, SendDisposition::Written);
    assert_eq!(w.textos().len(), 1);
}

#[test]
fn auto_con_un_envio_en_vuelo_encola() {
    let c = Colas::default();
    let w = Espia::default();
    let i = ctx(SessionStatus::Idle);
    c.enviar("s", item("a", "uno"), SendMode::Auto, i, &w, T0)
        .expect("a");
    let b = c
        .enviar("s", item("b", "dos"), SendMode::Auto, i, &w, T0)
        .expect("b");
    assert_eq!(b.disposition, SendDisposition::Queued);
    let ocupado = c
        .enviar(
            "s",
            item("c", "tres"),
            SendMode::Auto,
            ctx(SessionStatus::Waiting),
            &w,
            T0,
        )
        .expect("c");
    assert_eq!(
        ocupado.disposition,
        SendDisposition::Queued,
        "waiting = ocupado"
    );
    assert_eq!(w.textos(), vec!["uno"]);
}

#[test]
fn now_escribe_a_mitad_de_turno_pero_no_en_un_dialogo() {
    let c = Colas::default();
    let w = Espia::default();
    let r = c.enviar(
        "s",
        item("a", "ya"),
        SendMode::Now,
        ctx(SessionStatus::Working),
        &w,
        T0,
    );
    assert_eq!(r.map(|o| o.disposition), Ok(SendDisposition::Written));
    let mut d = ctx(SessionStatus::Working);
    d.screen = ScreenState::Dialog;
    assert!(c
        .enviar("s", item("b", "no"), SendMode::Now, d, &w, T0)
        .is_err());
    let fuera = c.enviar(
        "s",
        item("c", "x"),
        SendMode::Auto,
        ctx(SessionStatus::Exited),
        &w,
        T0,
    );
    assert_eq!(fuera, Err("la sesión terminó".into()));
}

#[test]
fn el_escritor_falla_y_el_envio_queda_failed() {
    let c = Colas::default();
    let w = Espia {
        falla: Some("pty cerrado".into()),
        ..Espia::default()
    };
    let r = c.enviar(
        "s",
        item("a", "hola"),
        SendMode::Auto,
        ctx(SessionStatus::Idle),
        &w,
        T0,
    );
    assert_eq!(r, Err("pty cerrado".into()));
    assert_eq!(estado(&c, "a"), vec![QueueState::Failed]);
}

#[test]
fn absorbido_a_mitad_de_turno_con_su_uuid() {
    let c = Colas::default();
    let w = Espia::default();
    c.enviar(
        "s",
        item("a", "cambia  el\ncolor"),
        SendMode::Now,
        ctx(SessionStatus::Working),
        &w,
        T0,
    )
    .expect("a");
    assert_eq!(c.resumen("s").sin_evidencia, 1);
    c.op_cli("s", &OpCola::Enqueue("cambia el color".into()), T0);
    assert_eq!(estado(&c, "a"), vec![QueueState::CliQueued]);
    assert_eq!(c.resumen("s").en_cola_cli, 1);
    c.op_cli("s", &OpCola::Remove("cambia el color".into()), T0);
    let e = c
        .entregado("s", "cambia el color", "q1", true, T0)
        .expect("par");
    assert_eq!(e.client_id, "a");
    let l = c.lista("s", T0);
    assert_eq!(
        (l[0].state, l[0].message_uuid.as_deref()),
        (QueueState::Absorbed, Some("q1"))
    );
    assert_eq!(c.resumen("s"), ResumenTickets::default());
}

#[test]
fn pop_all_devuelve_a_la_cola_una_sola_vez() {
    let c = Colas::default();
    let w = Espia::default();
    c.enviar(
        "s",
        item("a", "uno"),
        SendMode::Now,
        ctx(SessionStatus::Working),
        &w,
        T0,
    )
    .expect("a");
    c.op_cli("s", &OpCola::Enqueue("uno".into()), T0);
    let aviso = c.op_cli("s", &OpCola::PopAll("uno".into()), T0);
    assert_eq!(aviso, Some(AVISO_POPALL));
    c.op_cli("s", &OpCola::PopAll("uno".into()), T0);
    let l = c.lista("s", T0);
    assert_eq!(l.len(), 1, "sin duplicar");
    assert_eq!(l[0].state, QueueState::Queued);
}

#[test]
fn texto_escrito_en_la_terminal_entra_como_cli_y_las_tareas_no() {
    let c = Colas::default();
    c.op_cli("s", &OpCola::Enqueue("escrito a mano".into()), T0);
    c.op_cli("s", &OpCola::Enqueue("<task-notification>x".into()), T0);
    let l = c.lista("s", T0);
    assert_eq!(l.len(), 1);
    assert_eq!(
        (l[0].origin, l[0].state),
        (QueueOrigin::Cli, QueueState::CliQueued)
    );
    assert!(c
        .editar("s", &l[0].client_id, QueueItemPatch::default(), T0)
        .is_err());
}

#[test]
fn recuperar_la_entrada_reencola_o_crea_al_principio() {
    let c = Colas::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    c.recuperar("s", "texto de la caja", None, T0);
    let l = c.lista("s", T0);
    assert_eq!(
        (l[0].origin, l[0].text.as_str()),
        (QueueOrigin::Cli, "texto de la caja")
    );
    assert_eq!(l[1].client_id, "a");
}

/// M3: el texto recuperado de la caja que no es ningún envío pendiente (un
/// borrador del usuario) no lo pidió enviar nadie: no se drena solo. Entra
/// en `failed` con su aviso, una sola vez, y sale con Reintentar.
#[test]
fn recuperado_no_se_drena_solo() {
    let c = Colas::default();
    let w = Espia::default();
    c.recuperar("s", "borrador a medias", None, T0);
    c.recuperar("s", "borrador a medias", None, T0);
    let l = c.lista("s", T0);
    assert_eq!(l.len(), 1, "no se duplica: {l:?}");
    assert_eq!(l[0].state, QueueState::Failed);
    assert_eq!(l[0].error.as_deref(), Some(emparejar::AVISO_RECUPERADO));
    assert!(!c.hay_en_cola("s"), "el reintento por tick no lo ve");
    assert_eq!(c.drenar("s", ctx(SessionStatus::Idle), &w, T0), Ok(None));
    assert!(
        w.textos().is_empty(),
        "nada escrito sin que el usuario lo pida"
    );
    let cid = l[0].client_id.clone();
    c.reintentar("s", &cid, T0).expect("reintentar");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some(cid))
    );
    assert_eq!(w.textos(), vec!["borrador a medias"]);
}

#[test]
fn entregados_salen_de_la_instantanea_a_los_30_s() {
    let c = Colas::default();
    let w = Espia::default();
    c.enviar(
        "s",
        item("a", "uno"),
        SendMode::Auto,
        ctx(SessionStatus::Idle),
        &w,
        T0,
    )
    .expect("a");
    c.entregado("s", "uno", "u1", false, T0).expect("par");
    assert_eq!(c.lista("s", T0 + 29_000).len(), 1);
    assert!(c.lista("s", T0 + 30_000).is_empty());
}

#[test]
fn delegar_escribe_el_texto_de_delegacion_y_empareja() {
    let c = Colas::default();
    let w = Espia::default();
    let mut i = item("a", "revisa el log");
    i.delegate = true;
    c.enviar("s", i, SendMode::Auto, ctx(SessionStatus::Idle), &w, T0)
        .expect("a");
    assert!(w.textos()[0].starts_with("Delega esta tarea"));
    assert!(c
        .entregado("s", &texto_delegado("revisa el log"), "u1", false, T0)
        .is_some());
}

#[test]
fn editar_mover_y_fallar_envios() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    c.encolar("s", item("b", "dos"), T0).expect("b");
    let patch = QueueItemPatch {
        text: Some("uno bis".into()),
        attachments: None,
        delegate: Some(true),
    };
    let l = c.editar("s", "a", patch, T0).expect("editar");
    assert_eq!((l[0].text.as_str(), l[0].delegate), ("uno bis", true));
    let l = c.mover("s", "b", 0, T0).expect("mover");
    assert_eq!(l[0].client_id, "b");
    c.enviar_ya("s", Some("b"), ctx(SessionStatus::Working), &w, T0)
        .expect("ya");
    c.fallar_envios("s", "la sesión terminó");
    assert_eq!(estado(&c, "b"), vec![QueueState::Failed]);
    assert_eq!(
        estado(&c, "a"),
        vec![QueueState::Queued],
        "los queued se conservan"
    );
}

#[test]
fn comando_sin_puente_v2_va_por_el_escritor() {
    let c = Colas::default();
    let w = Espia::default();
    let mut i = item("a", "/compact ahora");
    i.kind = QueueItemKind::Command;
    let mut v2 = ctx(SessionStatus::Idle);
    v2.protocolo = 2;
    c.enviar("s-sin-buzon", i, SendMode::Auto, v2, &w, T0)
        .expect("comando");
    assert_eq!(
        w.textos(),
        vec!["/compact ahora"],
        "buzón sin hello: reserva por PTY"
    );
}

#[test]
fn clear_en_vuelo_se_entrega_con_el_comando_del_puente_y_libera_la_cola() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("clr", "/clear"), T0).expect("clear");
    c.encolar("s", item("g", "gamma"), T0).expect("gamma");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("clr".into()))
    );
    assert!(
        !c.comando_entregado("s", "compact", T0),
        "otro comando no empareja"
    );
    assert_eq!(c.resumen("s").sin_evidencia, 1);
    assert!(c.comando_entregado("s", "clear", T0));
    assert_eq!(estado(&c, "clr"), vec![QueueState::Delivered]);
    assert_eq!(c.resumen("s").sin_evidencia, 0, "ya no bloquea el idle");
    assert!(!c.comando_entregado("s", "clear", T0), "idempotente");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("g".into()))
    );
}

#[test]
fn un_prompt_en_vuelo_no_se_toma_por_comando() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("p", "clear the cache"), T0).expect("p");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    assert!(!c.comando_entregado("s", "clear", T0));
    assert_eq!(estado(&c, "p"), vec![QueueState::Sending]);
}

#[test]
fn clear_en_la_cola_nativa_de_la_cli_tambien_se_entrega() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("clr", "/clear"), T0).expect("clear");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.prompt_entrado("s", "/clear", true, T0);
    assert_eq!(estado(&c, "clr"), vec![QueueState::CliQueued]);
    assert_eq!(c.resumen("s").en_cola_cli, 1);
    assert!(c.comando_entregado("s", "clear", T0));
    assert_eq!(c.resumen("s").en_cola_cli, 0);
}

#[test]
fn resolver_huerfanos_libera_la_cola_y_no_toca_lo_encolado() {
    let c = Colas::default();
    let w = Espia::default();
    for (id, texto) in [("a", "uno"), ("b", "dos")] {
        c.enviar(
            "s",
            item(id, texto),
            SendMode::Now,
            ctx(SessionStatus::Working),
            &w,
            T0,
        )
        .expect("enviar");
    }
    c.op_cli("s", &OpCola::Enqueue("uno".into()), T0);
    c.encolar("s", item("c", "tres"), T0).expect("c");
    assert_eq!(
        c.resumen("s"),
        ResumenTickets {
            sin_evidencia: 1,
            en_cola_cli: 1,
            en_cola_ultron: 1
        }
    );
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
            .expect("drenar"),
        None,
        "un sending huérfano bloquea el drenaje (caso negativo)"
    );
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0);
    assert_eq!(estado(&c, "a"), vec![QueueState::Delivered]);
    assert_eq!(estado(&c, "b"), vec![QueueState::Failed]);
    assert_eq!(
        estado(&c, "c"),
        vec![QueueState::Queued],
        "lo encolado se conserva"
    );
    assert_eq!(
        c.resumen("s"),
        ResumenTickets {
            en_cola_ultron: 1,
            ..ResumenTickets::default()
        }
    );
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
            .expect("drenar"),
        Some("c".into())
    );
}

/// Interrumpir con un envío en la cola nativa: el `popAll` lo devuelve a la
/// cola y la recuperación lee el mismo texto en la caja. Antes se creaba un
/// elemento de la CLI además del original y el drenaje escribía los dos.
#[test]
fn interrumpir_con_un_envio_en_la_cola_nativa_no_lo_duplica() {
    let c = Colas::default();
    let w = Espia::default();
    let trabajando = ctx(SessionStatus::Working);
    c.enviar(
        "s",
        item("a", "haz esto luego"),
        SendMode::Now,
        trabajando,
        &w,
        T0,
    )
    .expect("enviar");
    c.op_cli("s", &OpCola::Enqueue("haz esto luego".into()), T0);
    c.op_cli("s", &OpCola::PopAll("haz esto luego".into()), T0);
    c.recuperar("s", "haz esto luego", None, T0);
    let l = c.lista("s", T0);
    assert_eq!(l.len(), 1, "un solo elemento");
    assert_eq!(
        (l[0].client_id.as_str(), l[0].state),
        ("a", QueueState::Queued)
    );
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("a".into()))
    );
    c.entregado("s", "haz esto luego", "u1", false, T0)
        .expect("par");
    assert_eq!(c.drenar("s", ctx(SessionStatus::Idle), &w, T0), Ok(None));
    assert_eq!(
        w.textos().len(),
        2,
        "el envío inicial y el drenaje, nada más"
    );
}

/// Dos envíos en la cola nativa de la TUI (`cliQueued`).
fn dos_en_la_cola_nativa(c: &Colas, w: &Espia) {
    for (id, t) in [("a", "uno"), ("b", "dos")] {
        c.enviar(
            "s",
            item(id, t),
            SendMode::Now,
            ctx(SessionStatus::Working),
            w,
            T0,
        )
        .expect("enviar");
        c.op_cli("s", &OpCola::Enqueue(t.into()), T0);
    }
}

/// La caja con los envíos de la cola nativa juntos (el `popAll` los devuelve
/// en un solo texto) no crea un elemento nuevo; vuelven a `queued` en orden.
#[test]
fn recuperar_la_concatenacion_de_la_cola_nativa_no_crea_nada() {
    let c = Colas::default();
    let w = Espia::default();
    dos_en_la_cola_nativa(&c, &w);
    c.recuperar("s", "uno\ndos", None, T0);
    let l = c.lista("s", T0);
    let ids: Vec<&str> = l.iter().map(|i| i.client_id.as_str()).collect();
    assert_eq!(ids, vec!["a", "b"]);
    assert_eq!(estado(&c, "a"), vec![QueueState::Queued]);
    c.recuperar("s", "tres", None, T0);
    let l = c.lista("s", T0);
    assert_eq!((l.len(), l[0].origin), (3, QueueOrigin::Cli));
}

/// Caso negativo: un `queued` de la app nunca estuvo en la caja. «ok» en la
/// cola y «ok, mira el fichero» en la caja son dos elementos.
#[test]
fn recuperar_un_texto_que_contiene_un_queued_crea_el_de_la_cli() {
    let c = Colas::default();
    c.encolar("s", item("a", "ok"), T0).expect("a");
    c.recuperar("s", "ok, mira el fichero", None, T0);
    let l = c.lista("s", T0);
    assert_eq!(l.len(), 2);
    assert_eq!(
        (l[0].origin, l[0].text.as_str()),
        (QueueOrigin::Cli, "ok, mira el fichero")
    );
}

/// Caso negativo: tampoco basta con que la caja contenga un `cliQueued`.
#[test]
fn recuperar_un_texto_que_contiene_un_cli_queued_crea_el_de_la_cli() {
    let c = Colas::default();
    let w = Espia::default();
    dos_en_la_cola_nativa(&c, &w);
    c.recuperar("s", "¿uno está bien?", None, T0);
    assert_eq!(c.lista("s", T0).len(), 3);
}

/// El `popAll` aplica la misma regla: la concatenación exacta de la cola
/// nativa no crea nada y un texto que solo la contiene, sí.
#[test]
fn pop_all_solo_da_por_cubierta_la_concatenacion_exacta() {
    let c = Colas::default();
    let w = Espia::default();
    dos_en_la_cola_nativa(&c, &w);
    c.op_cli("s", &OpCola::PopAll("uno\ndos".into()), T0);
    assert_eq!(c.lista("s", T0).len(), 2);
    let c = Colas::default();
    dos_en_la_cola_nativa(&c, &w);
    c.op_cli("s", &OpCola::PopAll("uno, mira el fichero".into()), T0);
    let l = c.lista("s", T0);
    assert_eq!((l.len(), l[2].origin), (3, QueueOrigin::Cli));
    // La recuperación de esa misma caja no lo duplica: el `popAll` lo dejó
    // marcado como devuelto.
    c.recuperar("s", "uno, mira el fichero", None, T0);
    assert_eq!(c.lista("s", T0).len(), 3);
}

/// G3 sobre el primero de dos devueltos por un `popAll`: la caja trae los
/// dos juntos y el primero se está reescribiendo. No entra ningún elemento
/// de la CLI y cada texto se escribe una sola vez en el drenaje.
#[test]
fn g3_sobre_el_primero_de_dos_devueltos_no_duplica() {
    let c = Colas::default();
    let w = Espia::default();
    dos_en_la_cola_nativa(&c, &w);
    c.op_cli("s", &OpCola::PopAll("uno\ndos".into()), T0);
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("a".into()))
    );
    c.recuperar("s", "uno\ndos", Some("a"), T0);
    let l = c.lista("s", T0);
    assert_eq!(l.len(), 2, "sin elemento nuevo de la CLI: {l:?}");
    assert!(l.iter().all(|i| i.origin == QueueOrigin::Ultron));
    assert_eq!(estado(&c, "a"), vec![QueueState::Sending]);
    assert_eq!(estado(&c, "b"), vec![QueueState::Queued]);
    c.entregado("s", "uno", "u1", false, T0).expect("par");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("b".into()))
    );
    c.entregado("s", "dos", "u2", false, T0).expect("par");
    assert_eq!(c.drenar("s", ctx(SessionStatus::Idle), &w, T0), Ok(None));
    assert_eq!(w.textos(), vec!["uno", "dos", "uno", "dos"]);
}

/// Caso negativo: si la caja trae algo que no es un tramo con el envío en
/// vuelo, sigue entrando como elemento nuevo de la CLI.
#[test]
fn g3_con_una_caja_ajena_al_envio_en_vuelo_crea_el_de_la_cli() {
    let c = Colas::default();
    let w = Espia::default();
    dos_en_la_cola_nativa(&c, &w);
    c.op_cli("s", &OpCola::PopAll("uno\ndos".into()), T0);
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.recuperar("s", "uno\ntres", Some("a"), T0);
    let l = c.lista("s", T0);
    assert_eq!((l.len(), l[0].origin), (3, QueueOrigin::Cli));
}

/// Un `cliQueued` vivía en la memoria del proceso: si sale, pasa a `failed`
/// (con Reintentar) y no a `delivered` por `resolver_huerfanos`.
#[test]
fn cli_queued_falla_si_el_proceso_sale_o_se_reinicia() {
    for reinicio in [false, true] {
        let c = Colas::default();
        let w = Espia::default();
        dos_en_la_cola_nativa(&c, &w);
        c.encolar("s", item("q", "tres"), T0).expect("q");
        if reinicio {
            c.fallar_cola_cli("s", "reinicio");
        } else {
            c.fallar_envios("s", "la sesión terminó");
        }
        c.resolver_huerfanos("s", "sin confirmar", T0);
        assert_eq!(estado(&c, "a"), vec![QueueState::Failed], "{reinicio}");
        assert_eq!(estado(&c, "b"), vec![QueueState::Failed], "{reinicio}");
        assert_eq!(estado(&c, "q"), vec![QueueState::Queued], "{reinicio}");
    }
}

/// Caso negativo: el reinicio no toca los `sending`, que siguen esperando
/// evidencia del transcript.
#[test]
fn el_reinicio_no_falla_los_sending() {
    let c = Colas::default();
    let w = Espia::default();
    c.enviar(
        "s",
        item("a", "uno"),
        SendMode::Now,
        ctx(SessionStatus::Working),
        &w,
        T0,
    )
    .expect("enviar");
    c.fallar_cola_cli("s", "reinicio");
    assert_eq!(estado(&c, "a"), vec![QueueState::Sending]);
}

/// Carrera entre `enviar` y el drenaje: el segundo hilo que llega a escribir
/// el mismo elemento ya lo encuentra en `sending` y no lo despacha.
#[test]
fn escribir_dos_veces_el_mismo_elemento_lo_despacha_una_vez() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    assert_eq!(
        c.drenar("s", ctx(SessionStatus::Idle), &w, T0),
        Ok(Some("a".into()))
    );
    c.escribir("s", "a", 0, &w, T0).expect("segundo hilo");
    assert_eq!(w.textos(), vec!["uno"]);
    assert_eq!(estado(&c, "a"), vec![QueueState::Sending]);
}

/// Caso negativo: un `failed` reintentado vuelve a `queued` y sí se escribe.
#[test]
fn un_fallido_reintentado_se_vuelve_a_escribir() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.fallar_envios("s", "la sesión terminó");
    c.reintentar("s", "a", T0).expect("reintentar");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    assert_eq!(w.textos(), vec!["uno", "uno"]);
}

/// Una cola envenenada se informa como error al persistir, no como vacía
/// (la persistencia reescribiría `abiertas.json` sin los mensajes).
#[test]
fn la_cola_envenenada_es_un_error_al_persistir() {
    let c = Colas::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    assert_eq!(c.lista_o_error("s", T0).map(|l| l.len()), Ok(1));
    c.envenenar();
    assert!(c.lista_o_error("s", T0).is_err());
}
