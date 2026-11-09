//! Cola de motor hermética: envío, disponibilidad y eventos inyectados.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use super::motor_cola::{Colas, Entorno};
use super::types::{
    QueueItem, QueueItemInput, QueueItemKind, QueueItemPatch, QueueOrigin, QueueState,
};

struct Banco {
    cola: Arc<Colas>,
    libre: Arc<AtomicBool>,
    falla: Arc<AtomicBool>,
    enviados: Arc<Mutex<Vec<String>>>,
    eventos: Arc<Mutex<Vec<Vec<QueueItem>>>>,
}

impl Banco {
    fn nuevo(libre: bool) -> Self {
        let libre = Arc::new(AtomicBool::new(libre));
        let falla = Arc::new(AtomicBool::new(false));
        let enviados = Arc::new(Mutex::new(Vec::new()));
        let eventos = Arc::new(Mutex::new(Vec::new()));
        let (l, f, e, v) = (
            libre.clone(),
            falla.clone(),
            enviados.clone(),
            eventos.clone(),
        );
        let disponibilidad = libre.clone();
        let cola = Colas::nueva(Entorno {
            libre: Arc::new(move |_| disponibilidad.load(Ordering::SeqCst)),
            enviar: Arc::new(move |_, msg| {
                e.lock().unwrap().push(msg.text.to_string());
                if f.load(Ordering::SeqCst) {
                    return Err("fallo simulado".into());
                }
                l.store(false, Ordering::SeqCst);
                Ok(())
            }),
            emitir: Arc::new(move |_, items| v.lock().unwrap().push(items.to_vec())),
            ejecutar: Arc::new(|trabajo| trabajo()),
        });
        Self {
            cola,
            libre,
            falla,
            enviados,
            eventos,
        }
    }

    fn encolar(&self, texto: &str) {
        self.cola.encolar("s", entrada(texto)).unwrap();
    }

    fn terminar(&self) {
        self.libre.store(true, Ordering::SeqCst);
        self.cola.drenar("s");
    }
}

fn entrada(texto: &str) -> QueueItemInput {
    QueueItemInput {
        client_id: texto.into(),
        text: texto.into(),
        attachments: vec![],
        delegate: true,
        kind: QueueItemKind::Command,
    }
}

#[test]
fn ocupada_conserva_y_emite_el_prompt_normalizado() {
    let b = Banco::nuevo(false);
    b.encolar("uno");
    let items = b.cola.lista("s").unwrap();
    assert_eq!(items[0].state, QueueState::Queued);
    assert_eq!(items[0].origin, QueueOrigin::Ultron);
    assert_eq!(items[0].kind, QueueItemKind::Prompt);
    assert!(!items[0].delegate);
    assert_eq!(b.eventos.lock().unwrap().last(), Some(&items));
    b.terminar();
    assert!(b.cola.lista("s").unwrap().is_empty());
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
}

#[test]
fn dos_prompts_salen_en_orden_uno_por_turno() {
    let b = Banco::nuevo(false);
    b.encolar("uno");
    b.encolar("dos");
    b.terminar();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
    assert_eq!(b.cola.lista("s").unwrap()[0].client_id, "dos");
    b.terminar();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno", "dos"]);
    assert!(b.cola.lista("s").unwrap().is_empty());
}

#[test]
fn libre_envia_al_encolar_sin_esperar_otro_cierre() {
    let b = Banco::nuevo(true);
    b.encolar("inmediato");
    assert_eq!(*b.enviados.lock().unwrap(), ["inmediato"]);
    assert!(b.cola.lista("s").unwrap().is_empty());
}

#[test]
fn fallo_detiene_el_drenaje_y_reintentar_reenvia() {
    let b = Banco::nuevo(false);
    b.encolar("uno");
    b.encolar("dos");
    b.falla.store(true, Ordering::SeqCst);
    b.terminar();
    let items = b.cola.lista("s").unwrap();
    assert_eq!(items[0].state, QueueState::Failed);
    assert_eq!(items[0].error.as_deref(), Some("fallo simulado"));
    assert_eq!(items[1].state, QueueState::Queued);
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
    b.falla.store(false, Ordering::SeqCst);
    b.cola.reintentar("s", "uno").unwrap();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno", "uno"]);
    assert_eq!(b.cola.lista("s").unwrap()[0].client_id, "dos");
}

#[test]
fn editar_mover_y_quitar_pendientes() {
    let b = Banco::nuevo(false);
    b.encolar("uno");
    b.encolar("dos");
    b.cola
        .editar(
            "s",
            "dos",
            QueueItemPatch {
                text: Some("editado".into()),
                attachments: Some(vec!["adjunto".into()]),
                delegate: Some(true),
            },
        )
        .unwrap();
    b.cola.mover("s", "dos", 0).unwrap();
    let items = b.cola.lista("s").unwrap();
    assert_eq!(items[0].text, "editado");
    assert_eq!(items[0].attachments, ["adjunto"]);
    assert!(!items[0].delegate);
    b.cola.quitar("s", "dos").unwrap();
    assert_eq!(b.cola.lista("s").unwrap()[0].client_id, "uno");
    assert!(b.cola.reintentar("s", "uno").is_err());
}

#[test]
fn client_id_es_idempotente_incluso_despues_de_aceptar() {
    let b = Banco::nuevo(false);
    b.encolar("uno");
    b.encolar("uno");
    assert_eq!(b.cola.lista("s").unwrap().len(), 1);
    b.terminar();
    b.encolar("uno");
    assert!(b.cola.lista("s").unwrap().is_empty());
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
}

#[test]
fn sending_impide_edicion_y_otro_drenaje() {
    let b = Banco::nuevo(true);
    let pendiente = Arc::new(Mutex::new(None));
    let p = pendiente.clone();
    let cola = Colas::nueva(Entorno {
        libre: Arc::new(|_| true),
        enviar: b.cola.entorno.enviar.clone(),
        emitir: b.cola.entorno.emitir.clone(),
        ejecutar: Arc::new(move |trabajo| *p.lock().unwrap() = Some(trabajo)),
    });
    cola.encolar("s", entrada("uno")).unwrap();
    assert_eq!(cola.lista("s").unwrap()[0].state, QueueState::Sending);
    assert!(cola.editar("s", "uno", QueueItemPatch::default()).is_err());
    assert!(cola.quitar("s", "uno").is_err());
    cola.drenar("s");
    pendiente.lock().unwrap().take().unwrap()();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
}

#[test]
fn enviar_ya_se_desvia_solo_para_motor_y_kill_vacia() {
    use super::{comandos_v2, motor_cola, motor_sesion};
    let dir = tempfile::tempdir().unwrap();
    let s =
        motor_sesion::crear_en("gemini", None, dir.path().to_string_lossy().into(), None).unwrap();
    let msg = motor_sesion::Mensaje {
        text: "ocupado",
        ..Default::default()
    };
    motor_sesion::send_con(&s.id, &msg, &|spec, _, _, _| {
        super::motor::lanzar_para_prueba(spec)
    })
    .unwrap();
    motor_cola::global()
        .encolar(&s.id, entrada("pendiente"))
        .unwrap();
    assert_eq!(
        comandos_v2::validar_envio_ya(&s.id).unwrap_err(),
        "Gemini/OpenCode no admite añadir mensajes a un turno en curso: se envía al terminar"
    );
    assert!(comandos_v2::validar_envio_ya("claude-prueba").is_ok());
    motor_sesion::kill(&s.id).unwrap();
    assert!(motor_cola::global().lista(&s.id).unwrap().is_empty());
}

#[test]
fn cierre_durante_la_aceptacion_no_pierde_el_siguiente_drenaje() {
    let b = Banco::nuevo(false);
    let cola = Colas::nueva(Entorno {
        libre: b.cola.entorno.libre.clone(),
        enviar: Arc::new({
            let enviados = b.enviados.clone();
            move |_, msg| {
                // Simula un turno que termina antes de devolver el envío.
                enviados.lock().unwrap().push(msg.text.into());
                Ok(())
            }
        }),
        emitir: b.cola.entorno.emitir.clone(),
        ejecutar: Arc::new(|trabajo| trabajo()),
    });
    cola.encolar("s", entrada("uno")).unwrap();
    cola.encolar("s", entrada("dos")).unwrap();
    b.libre.store(true, Ordering::SeqCst);
    cola.drenar("s");
    assert_eq!(*b.enviados.lock().unwrap(), ["uno", "dos"]);
    assert!(cola.lista("s").unwrap().is_empty());
}

#[test]
fn olvidar_anula_el_trabajo_pendiente_y_emite_la_cola_vacia() {
    let b = Banco::nuevo(true);
    let pendientes = Arc::new(Mutex::new(Vec::new()));
    let p = pendientes.clone();
    let cola = Colas::nueva(Entorno {
        libre: b.cola.entorno.libre.clone(),
        enviar: b.cola.entorno.enviar.clone(),
        emitir: b.cola.entorno.emitir.clone(),
        ejecutar: Arc::new(move |trabajo| p.lock().unwrap().push(trabajo)),
    });
    cola.encolar("s", entrada("uno")).unwrap();
    cola.olvidar("s");
    assert!(b.eventos.lock().unwrap().last().unwrap().is_empty());
    // Reabrir con el mismo clientId no rehabilita el trabajo de la cola anterior.
    cola.encolar("s", entrada("uno")).unwrap();
    let antiguos = pendientes.lock().unwrap().remove(0);
    antiguos();
    assert!(b.enviados.lock().unwrap().is_empty());
    assert_eq!(cola.lista("s").unwrap()[0].state, QueueState::Sending);
    let nuevo = pendientes.lock().unwrap().remove(0);
    nuevo();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
}

#[test]
fn sesion_ocupada_entre_reserva_y_envio_conserva_el_prompt() {
    let b = Banco::nuevo(true);
    let pendiente = Arc::new(Mutex::new(None));
    let p = pendiente.clone();
    let cola = Colas::nueva(Entorno {
        libre: b.cola.entorno.libre.clone(),
        enviar: b.cola.entorno.enviar.clone(),
        emitir: b.cola.entorno.emitir.clone(),
        ejecutar: Arc::new(move |trabajo| *p.lock().unwrap() = Some(trabajo)),
    });
    cola.encolar("s", entrada("uno")).unwrap();
    b.libre.store(false, Ordering::SeqCst);
    let trabajo = pendiente.lock().unwrap().take().unwrap();
    trabajo();
    let items = cola.lista("s").unwrap();
    assert_eq!(items[0].state, QueueState::Queued);
    assert!(items[0].sent_at.is_none() && items[0].error.is_none());
    assert!(b.enviados.lock().unwrap().is_empty());
    b.libre.store(true, Ordering::SeqCst);
    cola.drenar("s");
    let trabajo = pendiente.lock().unwrap().take().unwrap();
    trabajo();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
}

#[test]
fn liberacion_al_devolver_la_reserva_no_pierde_el_drenaje() {
    use std::sync::atomic::AtomicUsize;
    let b = Banco::nuevo(true);
    let consultas = AtomicUsize::new(0);
    let cola = Colas::nueva(Entorno {
        // La sesión se ocupa al arrancar el trabajo y termina antes de
        // devolver la reserva; su aviso encontró el elemento en sending.
        libre: Arc::new(move |_| consultas.fetch_add(1, Ordering::SeqCst) != 1),
        enviar: b.cola.entorno.enviar.clone(),
        emitir: b.cola.entorno.emitir.clone(),
        ejecutar: Arc::new(|trabajo| trabajo()),
    });
    cola.encolar("s", entrada("uno")).unwrap();
    assert_eq!(*b.enviados.lock().unwrap(), ["uno"]);
    assert!(cola.lista("s").unwrap().is_empty());
}
