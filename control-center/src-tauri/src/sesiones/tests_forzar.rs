// sesiones/tests_forzar.rs — «Interrumpir y enviar» (§3.4) y el alta al
// principio de la cola con un entorno falso: qué se escribe, en qué orden y
// qué queda en cola cuando la interrupción no para el turno.

use std::cell::{Cell, RefCell};
use std::sync::Mutex;
use std::time::Duration;

use super::*;
use crate::sesiones::cola::Envio;
use crate::sesiones::types::{QueueItemKind, SendMode};

const T0: Ms = 1_700_000_000_000;
const ID: &str = "s";

#[derive(Default)]
struct Espia {
    escritos: Mutex<Vec<Envio>>,
}

impl Escritor for Espia {
    fn escribir(&self, _id: &str, envio: &Envio) -> Result<(), String> {
        self.escritos.lock().expect("espía").push(envio.clone());
        Ok(())
    }
}

impl Espia {
    fn textos(&self) -> Vec<String> {
        let v = self.escritos.lock().expect("espía");
        v.iter().map(|e| e.texto.clone()).collect()
    }
}

/// Qué hace la interrupción falsa con la cola y la sesión.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Interrupcion {
    /// Para el turno y la CLI devuelve su cola nativa a la caja (popAll).
    ParaConPopAll,
    /// Claude sigue trabajando (`sigueTrabajando`).
    NoPara,
    /// Otra interrupción de la sesión (un Esc) ya estaba en curso; al acabar
    /// paró el turno (`true`) o no.
    OtraEnCurso(bool),
    /// Un Esc terminó hace menos de 1,5 s y la pantalla sigue ocupada:
    /// `accion_reservada` con `ComprobarPantalla` no escribe y responde
    /// `ok: false` con el único paso `antirrebote`.
    Antirrebote,
}

struct Falso {
    colas: Colas,
    ctx: Cell<Contexto>,
    espia: Arc<Espia>,
    modo: Interrupcion,
    interrupciones: Cell<usize>,
    devuelto: RefCell<Option<String>>,
    /// Esperas que la máquina sigue en `waiting` tras parar el turno (la
    /// señal de pantalla llega tarde).
    waiting_tras_parar: Cell<usize>,
    pausa: Cell<bool>,
    dormidas: Cell<usize>,
}

fn ctx(status: SessionStatus, screen: ScreenState) -> Contexto {
    Contexto {
        status,
        screen,
        protocolo: 2,
        terminal: false,
        limite: false,
    }
}

impl Falso {
    fn nuevo(status: SessionStatus, screen: ScreenState, modo: Interrupcion) -> Self {
        Self {
            colas: Colas::default(),
            ctx: Cell::new(ctx(status, screen)),
            espia: Arc::new(Espia::default()),
            modo,
            interrupciones: Cell::new(0),
            devuelto: RefCell::new(None),
            waiting_tras_parar: Cell::new(0),
            pausa: Cell::new(false),
            dormidas: Cell::new(0),
        }
    }

    /// Efecto de un turno parado: popAll, cola en pausa y la máquina a
    /// `idle` (o aún en `waiting` si la señal llega tarde).
    fn parar(&self) {
        if let Some(t) = self.devuelto.borrow().as_deref() {
            self.colas.recuperar(ID, t, None, T0);
        }
        self.pausa.set(true);
        let status = if self.waiting_tras_parar.get() > 0 {
            SessionStatus::Waiting
        } else {
            SessionStatus::Idle
        };
        self.ctx.set(ctx(status, ScreenState::Prompt));
    }

    /// Mensaje ya escrito en la cola nativa de la CLI (Ctrl+Enter).
    fn en_cola_nativa(&self, client_id: &str, texto: &str) {
        let w = self.espia.clone();
        self.colas
            .enviar(
                ID,
                input(client_id, texto),
                SendMode::Now,
                self.ctx.get(),
                &*w,
                T0,
            )
            .expect("envío a la cola nativa");
        *self.devuelto.borrow_mut() = Some(texto.to_string());
    }

    fn estados(&self) -> Vec<(String, QueueState)> {
        self.colas
            .lista(ID, T0)
            .into_iter()
            .map(|i| (i.client_id, i.state))
            .collect()
    }
}

impl EntornoForzar for Falso {
    fn id(&self) -> &str {
        ID
    }
    fn colas(&self) -> &Colas {
        &self.colas
    }
    fn contexto(&self) -> Contexto {
        self.ctx.get()
    }
    fn escritor(&self) -> Arc<dyn Escritor> {
        self.espia.clone()
    }
    fn interrumpir(&self) -> Resultado {
        self.interrupciones.set(self.interrupciones.get() + 1);
        match self.modo {
            Interrupcion::NoPara => {
                return Resultado {
                    ok: false,
                    steps: vec!["esc".into(), "sigueTrabajando".into()],
                }
            }
            Interrupcion::OtraEnCurso(_) => {
                return Resultado {
                    ok: false,
                    steps: vec![EN_CURSO.into()],
                }
            }
            Interrupcion::Antirrebote => {
                return Resultado {
                    ok: false,
                    steps: vec!["antirrebote".into()],
                }
            }
            Interrupcion::ParaConPopAll => self.parar(),
        }
        Resultado {
            ok: true,
            steps: vec!["turn.abort".into(), "entradaRecuperada".into()],
        }
    }
    fn ahora(&self) -> Ms {
        T0
    }
    fn dormir(&self, _d: Duration) {
        self.dormidas.set(self.dormidas.get() + 1);
        let n = self.waiting_tras_parar.get();
        if n > 0 && self.ctx.get().status == SessionStatus::Waiting {
            self.waiting_tras_parar.set(n - 1);
            if n == 1 {
                self.ctx.set(ctx(SessionStatus::Idle, ScreenState::Prompt));
            }
        }
    }
    fn esperar_otra_interrupcion(&self) -> bool {
        let paro = self.modo == Interrupcion::OtraEnCurso(true);
        if paro {
            self.parar();
        }
        paro
    }
    fn cola_en_pausa(&self) -> bool {
        self.pausa.get()
    }
}

fn input(client_id: &str, texto: &str) -> QueueItemInput {
    QueueItemInput {
        client_id: client_id.into(),
        text: texto.into(),
        attachments: Vec::new(),
        delegate: false,
        kind: QueueItemKind::Prompt,
    }
}

#[test]
fn interrumpe_y_escribe_solo_el_nuevo_por_delante_de_lo_devuelto() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::ParaConPopAll,
    );
    f.en_cola_nativa("previo", "lo que estaba en la cola nativa");
    let r = interrumpir_y_enviar(&f, input("nuevo", "para y haz esto")).expect("resultado");
    assert!(r.interrupted && r.sent);
    assert_eq!(r.item.client_id, "nuevo");
    assert_eq!(r.item.state, QueueState::Sending);
    assert!(r.steps.contains(&"turn.abort".to_string()));
    assert_eq!(r.steps.last().map(String::as_str), Some("enviado"));
    // Tras la interrupción solo sale el nuevo; lo devuelto espera en cola.
    assert_eq!(
        f.espia.textos(),
        vec!["lo que estaba en la cola nativa", "para y haz esto"]
    );
    assert_eq!(
        f.estados(),
        vec![
            ("previo".to_string(), QueueState::Queued),
            ("nuevo".to_string(), QueueState::Sending),
        ]
    );
}

#[test]
fn si_la_interrupcion_falla_no_escribe_y_el_mensaje_queda_el_primero() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::NoPara,
    );
    f.colas
        .encolar(ID, input("viejo", "uno que ya esperaba"), T0)
        .expect("alta");
    let r = interrumpir_y_enviar(&f, input("nuevo", "para y haz esto")).expect("resultado");
    assert!(!r.interrupted && !r.sent);
    assert_eq!(r.item.state, QueueState::Queued);
    assert!(r.steps.contains(&"sigueTrabajando".to_string()));
    assert!(f.espia.textos().is_empty(), "nada escrito");
    assert_eq!(
        f.estados(),
        vec![
            ("nuevo".to_string(), QueueState::Queued),
            ("viejo".to_string(), QueueState::Queued),
        ]
    );
}

#[test]
fn con_un_dialogo_o_la_sesion_terminada_es_err_sin_escribir_ni_encolar() {
    for (status, screen) in [
        (SessionStatus::Waiting, ScreenState::Dialog),
        (SessionStatus::Working, ScreenState::Trust),
        (SessionStatus::Exited, ScreenState::Unknown),
        (SessionStatus::Starting, ScreenState::Unknown),
    ] {
        let f = Falso::nuevo(status, screen, Interrupcion::ParaConPopAll);
        let r = interrumpir_y_enviar(&f, input("nuevo", "x"));
        assert!(r.is_err(), "{status:?} {screen:?}");
        assert_eq!(f.interrupciones.get(), 0);
        assert!(f.espia.textos().is_empty());
        assert!(f.estados().is_empty(), "no queda nada en cola");
    }
}

#[test]
fn con_la_sesion_libre_es_un_envio_inmediato_sin_interrumpir() {
    let f = Falso::nuevo(
        SessionStatus::Idle,
        ScreenState::Prompt,
        Interrupcion::ParaConPopAll,
    );
    f.colas
        .encolar(ID, input("pausado", "en pausa tras abortar"), T0)
        .expect("alta");
    let r = interrumpir_y_enviar(&f, input("nuevo", "ya")).expect("resultado");
    assert!(!r.interrupted && r.sent);
    assert_eq!(f.interrupciones.get(), 0);
    assert!(r.steps.contains(&"sinTurno".to_string()));
    assert_eq!(
        f.espia.textos(),
        vec!["ya"],
        "solo el nuevo, no la cola en pausa"
    );
}

#[test]
fn repetir_el_mismo_client_id_no_interrumpe_ni_escribe_otra_vez() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::ParaConPopAll,
    );
    interrumpir_y_enviar(&f, input("nuevo", "ya")).expect("primero");
    f.ctx.set(ctx(SessionStatus::Working, ScreenState::Busy));
    let r = interrumpir_y_enviar(&f, input("nuevo", "ya")).expect("repetido");
    assert_eq!(r.steps, vec!["yaEnviado"]);
    assert_eq!(f.interrupciones.get(), 1);
    assert_eq!(f.espia.textos(), vec!["ya"]);
}

#[test]
fn repetir_un_client_id_fallido_lo_reencola_y_no_dice_ya_enviado() {
    let f = Falso::nuevo(
        SessionStatus::Idle,
        ScreenState::Prompt,
        Interrupcion::ParaConPopAll,
    );
    interrumpir_y_enviar(&f, input("nuevo", "ya")).expect("primero");
    f.colas
        .encolar(ID, input("otro", "otro"), T0)
        .expect("alta");
    f.colas.fallar_envios(ID, "envío perdido");
    assert_eq!(
        f.colas.elemento(ID, "nuevo").expect("e").state,
        QueueState::Failed
    );
    let r = interrumpir_y_enviar(&f, input("nuevo", "ya")).expect("repetido");
    assert!(r.sent, "{:?}", r.steps);
    assert_ne!(r.steps, vec!["yaEnviado"]);
    assert_eq!(r.item.state, QueueState::Sending);
    assert_eq!(r.item.error, None);
    assert_eq!(f.espia.textos(), vec!["ya", "ya"], "se escribe otra vez");
}

#[test]
fn encolar_delante_reencola_un_fallido_al_principio() {
    let c = Colas::default();
    let f = Falso::nuevo(
        SessionStatus::Idle,
        ScreenState::Prompt,
        Interrupcion::ParaConPopAll,
    );
    let w = f.espia.clone();
    c.enviar(ID, input("b", "b"), SendMode::Now, f.ctx.get(), &*w, T0)
        .expect("envío");
    c.encolar(ID, input("a", "a"), T0).expect("a");
    c.fallar_envios(ID, "perdido");
    let b = c.encolar_delante(ID, input("b", "b"), T0).expect("b");
    assert_eq!((b.state, b.error), (QueueState::Queued, None));
    let ids: Vec<String> = c.lista(ID, T0).into_iter().map(|i| i.client_id).collect();
    assert_eq!(ids, vec!["b", "a"]);
}

#[test]
fn encolar_delante_va_al_indice_cero_y_es_idempotente() {
    let c = Colas::default();
    c.encolar(ID, input("a", "a"), T0).expect("a");
    let b = c.encolar_delante(ID, input("b", "b"), T0).expect("b");
    assert_eq!(b.state, QueueState::Queued);
    // Repetido con otro texto: no se duplica, no se mueve ni cambia.
    c.mover(ID, "b", 1, T0).expect("mover");
    let otra = c
        .encolar_delante(ID, input("b", "otro texto"), T0)
        .expect("b otra vez");
    assert_eq!(otra.text, "b");
    let ids: Vec<String> = c.lista(ID, T0).into_iter().map(|i| i.client_id).collect();
    assert_eq!(ids, vec!["a", "b"]);
    assert!(c.elemento(ID, "zzz").is_err(), "caso negativo: no existe");
}

#[test]
fn con_otra_interrupcion_en_curso_que_para_espera_y_envia() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::OtraEnCurso(true),
    );
    f.en_cola_nativa("previo", "lo devuelto");
    let r = interrumpir_y_enviar(&f, input("nuevo", "para y haz esto")).expect("resultado");
    assert!(r.interrupted && r.sent, "{:?}", r.steps);
    assert!(r.steps.contains(&EN_CURSO.to_string()));
    assert!(r.steps.contains(&"otraParo".to_string()));
    assert_eq!(f.espia.textos(), vec!["lo devuelto", "para y haz esto"]);
}

#[test]
fn con_otra_interrupcion_que_no_para_y_la_cola_en_pausa_lo_dice() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::OtraEnCurso(false),
    );
    f.pausa.set(true);
    let r = interrumpir_y_enviar(&f, input("nuevo", "x")).expect("resultado");
    assert!(!r.interrupted && !r.sent);
    assert_eq!(r.item.state, QueueState::Queued);
    assert_eq!(r.steps.last().map(String::as_str), Some(COLA_PAUSADA));
    assert!(f.espia.textos().is_empty(), "nada escrito");
}

#[test]
fn sin_pausa_un_fallo_no_marca_cola_pausada() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::NoPara,
    );
    let r = interrumpir_y_enviar(&f, input("nuevo", "x")).expect("resultado");
    assert!(!r.steps.contains(&COLA_PAUSADA.to_string()));
}

#[test]
fn espera_a_que_la_maquina_salga_de_waiting_antes_de_enviar() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::ParaConPopAll,
    );
    f.waiting_tras_parar.set(3);
    let r = interrumpir_y_enviar(&f, input("nuevo", "ya")).expect("resultado");
    assert!(r.interrupted && r.sent, "{:?}", r.steps);
    assert_eq!(f.dormidas.get(), 3);
    assert_eq!(f.espia.textos(), vec!["ya"]);
}

#[test]
fn si_la_maquina_no_sale_de_waiting_el_error_no_escribe() {
    let f = Falso::nuevo(
        SessionStatus::Working,
        ScreenState::Busy,
        Interrupcion::ParaConPopAll,
    );
    // Más esperas que `ESPERA_ESTADO`: se rinde y `enviar_ya` lo rechaza.
    f.waiting_tras_parar.set(1_000);
    let r = interrumpir_y_enviar(&f, input("nuevo", "ya"));
    assert!(r.is_err(), "caso negativo: waiting rechaza la escritura");
    assert_eq!(f.dormidas.get(), 20);
    assert!(f.espia.textos().is_empty());
}

/// «Interrumpir y enviar» antes de 1,5 s desde un Esc, con Claude aún
/// trabajando: no se espera ni se escribe, el mensaje queda el primero y los
/// pasos dicen `antirrebote` (y `colaPausada` con la cola en pausa) para que
/// el composer explique por qué no salió.
#[test]
fn en_el_antirrebote_con_la_pantalla_ocupada_no_escribe_y_lo_dice() {
    for pausa in [false, true] {
        let f = Falso::nuevo(
            SessionStatus::Working,
            ScreenState::Busy,
            Interrupcion::Antirrebote,
        );
        f.pausa.set(pausa);
        let r = interrumpir_y_enviar(&f, input("nuevo", "x")).expect("resultado");
        assert!(!r.interrupted && !r.sent, "{:?}", r.steps);
        assert_eq!(r.item.state, QueueState::Queued);
        let mut esperado = vec!["encoladoDelante".to_string(), "antirrebote".to_string()];
        if pausa {
            esperado.push(COLA_PAUSADA.into());
        }
        assert_eq!(r.steps, esperado);
        assert_eq!(f.interrupciones.get(), 1);
        assert_eq!(f.dormidas.get(), 0, "no espera a otra interrupción");
        assert!(f.espia.textos().is_empty(), "nada escrito");
        assert_eq!(f.estados()[0].0, "nuevo", "el primero de la cola");
    }
}
