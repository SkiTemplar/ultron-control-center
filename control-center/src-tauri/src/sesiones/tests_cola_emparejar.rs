// sesiones/tests_cola_emparejar.rs — Emparejado de los envíos de la cola con
// lo que la CLI guarda en el transcript (pegados envueltos, fallidos por
// timeout, prompts sin pareja) y G3 con la caja igual al envío en vuelo.
// Comparte el escritor espía y los ayudantes de `tests_cola.rs`.

use super::tests::{ctx, estado, item, Espia, T0};
use super::*;

/// Claude Code 2.1.296 guarda en el transcript un pegado largo envuelto en
/// `<pasted_content id="…">…</pasted_content id="…">`. Sin quitar el
/// envoltorio, el envío se quedaba en `sending`, la reconciliación lo pasaba
/// a `failed` («La CLI no confirmó el envío») y el usuario lo reenviaba.
#[test]
fn el_pegado_envuelto_por_la_cli_empareja_su_envio() {
    let c = Colas::default();
    let w = Espia::default();
    let texto = "pues lo de MCP:\n❯ /mcp\n  ⎿  Failed to reconnect\n\nfin";
    c.encolar("s", item("a", texto), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    let transcript =
        format!("\n\n<pasted_content id=\"2218\">\n{texto}\n</pasted_content id=\"2218\">\n");
    assert!(
        c.entregado("s", &transcript, "u1", false, T0).is_some(),
        "el mensaje del transcript empareja el envío"
    );
    assert_eq!(estado(&c, "a"), vec![QueueState::Delivered]);
    // Caso negativo: otro texto envuelto no empareja.
    c.encolar("s", item("b", "otro texto"), T0).expect("b");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    let ajeno = "<pasted_content id=\"1\">\nnada que ver\n</pasted_content id=\"1\">";
    assert!(c.entregado("s", ajeno, "u2", false, T0).is_none());
}

/// Un envío dado por no confirmado (`failed`) cuyo mensaje aparece después en
/// el transcript se empareja: sin esto quedaba un Reintentar que lo duplicaba.
#[test]
fn un_fallido_por_timeout_empareja_con_su_mensaje_tardio() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "hola"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0);
    assert_eq!(estado(&c, "a"), vec![QueueState::Failed]);
    // Caso negativo: un mensaje con otro texto no lo empareja.
    assert!(c.entregado("s", "adiós", "u0", false, T0).is_none());
    let par = c.entregado("s", "hola", "u1", false, T0).expect("par");
    assert_eq!(par.client_id, "a");
    let l = c.lista("s", T0);
    assert_eq!(l[0].state, QueueState::Delivered);
    assert_eq!(l[0].error, None, "sin el error de no confirmado");
}

/// Un `sending` vivo con el mismo texto gana al `failed` antiguo.
#[test]
fn un_envio_vivo_gana_al_fallido_con_el_mismo_texto() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "hola"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0);
    c.encolar("s", item("b", "hola"), T0).expect("b");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    let par = c.entregado("s", "hola", "u1", false, T0).expect("par");
    assert_eq!(par.client_id, "b");
    assert_eq!(estado(&c, "a"), vec![QueueState::Failed]);
}

/// Un `sending` escrito antes de un prompt del transcript que no emparejó
/// por texto pero lo contiene (la CLI le añadió algo) se da por entregado con
/// ese mensaje al resolver los huérfanos.
#[test]
fn un_sending_seguido_de_un_prompt_sin_pareja_se_entrega_por_orden() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "texto original"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    assert!(c
        .entregado("s", "texto original [Image #1]", "u9", false, T0 + 100)
        .is_none());
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0 + 20_000);
    let l = c.lista("s", T0 + 20_000);
    assert_eq!(l[0].state, QueueState::Delivered);
    assert_eq!(l[0].message_uuid.as_deref(), Some("u9"));
}

/// Caso negativo: un prompt sin pareja que no se parece al envío (escrito a
/// mano en la TUI) no lo confirma; el envío queda en `failed`.
#[test]
fn un_prompt_sin_pareja_ajeno_al_envio_no_lo_entrega() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "A"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    assert!(c.entregado("s", "B", "u9", false, T0 + 100).is_none());
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0 + 20_000);
    let l = c.lista("s", T0 + 20_000);
    assert_eq!(l[0].state, QueueState::Failed);
    assert_eq!(l[0].message_uuid, None);
}

/// Un prompt sin pareja que solo comparte el principio con el envío puede
/// ser otro escrito a mano en la TUI (una plantilla): no lo entrega ni le
/// asocia su `uuid`. Queda en `failed` con el aviso de que pudo llegar
/// transformado, para que el Reintentar pida confirmación.
#[test]
fn un_prompt_sin_pareja_con_el_mismo_principio_no_lo_entrega() {
    let c = Colas::default();
    let w = Espia::default();
    let largo = "revisa el módulo de la cola y dime qué falla en el emparejado";
    c.encolar("s", item("a", largo), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    let a_mano = "revisa el módulo de la cola y dime qué tal está el drenaje";
    assert!(c.entregado("s", a_mano, "u9", false, T0 + 100).is_none());
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0 + 20_000);
    let l = c.lista("s", T0 + 20_000);
    assert_eq!(l[0].state, QueueState::Failed);
    assert_eq!(l[0].message_uuid, None);
    let error = l[0].error.as_deref().unwrap_or_default();
    assert!(error.contains("no confirmó el envío"), "{error}");
    assert!(error.contains(super::AVISO_TRANSFORMADO), "{error}");
}

/// Caso negativo del anterior: sin ningún prompt parecido, el motivo no
/// lleva el aviso de transformación.
#[test]
fn un_huerfano_sin_indicio_falla_sin_el_aviso_de_transformacion() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "texto original"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0 + 20_000);
    let l = c.lista("s", T0 + 20_000);
    assert_eq!(l[0].error.as_deref(), Some("La CLI no confirmó el envío"));
}

/// Caso negativo: un mensaje cuyo `uuid` ya está emparejado (la CLI reemite
/// el de un `!comando` con su salida) no cuenta como prompt sin pareja.
#[test]
fn un_uuid_ya_emparejado_no_cuenta_como_prompt_sin_pareja() {
    let c = Colas::default();
    let w = Espia::default();
    c.encolar("s", item("a", "uno"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0)
        .expect("drenar");
    c.entregado("s", "uno", "u1", false, T0 + 100).expect("par");
    c.encolar("s", item("b", "dos"), T0).expect("b");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0 + 500)
        .expect("drenar");
    assert!(c
        .entregado("s", "dos y más", "u1", false, T0 + 600)
        .is_none());
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0 + 20_000);
    assert_eq!(estado(&c, "b"), vec![QueueState::Failed]);
}

/// Caso negativo: un prompt sin pareja anterior al envío no lo confirma.
#[test]
fn un_prompt_sin_pareja_anterior_al_envio_no_lo_entrega() {
    let c = Colas::default();
    let w = Espia::default();
    assert!(c
        .entregado("s", "escrito a mano", "u0", false, T0)
        .is_none());
    c.encolar("s", item("a", "texto original"), T0).expect("a");
    c.drenar("s", ctx(SessionStatus::Idle), &w, T0 + 500)
        .expect("drenar");
    c.resolver_huerfanos("s", "La CLI no confirmó el envío", T0 + 20_000);
    assert_eq!(estado(&c, "a"), vec![QueueState::Failed]);
}

/// Escritor que, como G3, vacía la caja de la TUI y la devuelve a la cola
/// antes de escribir; la caja tiene el mismo texto que el envío.
struct EspiaG3<'a> {
    c: &'a Colas,
    espia: Espia,
}

impl Escritor for EspiaG3<'_> {
    fn escribir(&self, id: &str, envio: &Envio) -> Result<(), String> {
        self.c
            .recuperar(id, &envio.texto, Some(&envio.client_id), T0);
        self.espia.escribir(id, envio)
    }
}

#[test]
fn g3_con_la_caja_igual_no_reencola_el_envio_en_vuelo() {
    let c = Colas::default();
    let w = EspiaG3 {
        c: &c,
        espia: Espia::default(),
    };
    let r = c
        .enviar(
            "s",
            item("a", "mismo texto"),
            SendMode::Auto,
            ctx(SessionStatus::Idle),
            &w,
            T0,
        )
        .expect("enviar");
    assert_eq!(r.disposition, SendDisposition::Written);
    assert_eq!(estado(&c, "a"), vec![QueueState::Sending]);
    assert_eq!(c.lista("s", T0).len(), 1, "no entra un elemento de la CLI");
    assert_eq!(c.drenar("s", ctx(SessionStatus::Idle), &w, T0), Ok(None));
    assert_eq!(w.espia.textos(), vec!["mismo texto"], "se escribe una vez");
}
