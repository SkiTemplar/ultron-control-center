// sesiones/tests_caja.rs — G3: vaciado de la caja de la TUI por el puente o
// con Ctrl+U, espera a que la pantalla lo refleje y pausa del drenaje con la
// caja ocupada.

use std::cell::{Cell, RefCell};

use super::*;

/// Buzón falso: registra las operaciones y responde lo configurado. `texto`
/// en `None` simula un puente que no contesta; `limpia` en false, un
/// `prompt.clear` que vence. `escribe` cambia la caja durante la espera (el
/// usuario sigue tecleando en la terminal adjunta).
struct BuzonFalso<'a> {
    ops: RefCell<Vec<String>>,
    texto: Option<&'static str>,
    limpia: bool,
    escribe: Option<(&'a PantallaFalsa, &'static str)>,
}

impl BuzonFalso<'_> {
    fn con(texto: Option<&'static str>) -> Self {
        Self {
            ops: RefCell::default(),
            texto,
            limpia: true,
            escribe: None,
        }
    }
}

impl BuzonOps for BuzonFalso<'_> {
    fn op(&self, _id: &str, op: buzon::InboxOp) -> Option<OpResult> {
        let es_clear = matches!(op, buzon::InboxOp::PromptClear { .. });
        let nombre = match op {
            buzon::InboxOp::PromptRead { .. } => "prompt.read",
            buzon::InboxOp::PromptClear { .. } => "prompt.clear",
            _ => "otra",
        };
        self.ops.borrow_mut().push(nombre.to_string());
        if let Some((p, nuevo)) = self.escribe {
            *p.texto.borrow_mut() = Some(nuevo.to_string());
        }
        if es_clear && !self.limpia {
            return None;
        }
        let t = self.texto?;
        Some(OpResult {
            ok: true,
            value: Some(serde_json::json!({ "text": t, "cursor": 0 })),
            ..OpResult::default()
        })
    }
}

/// Pantalla falsa: la caja se vacía tras `repintado` lecturas desde que se
/// limpia (por el puente o con Ctrl+U), o nunca si `ctrl_u_inutil`. Con
/// `resto`, el Ctrl+U solo borra una línea y deja ese texto.
struct PantallaFalsa {
    texto: RefCell<Option<String>>,
    limpiada: Cell<bool>,
    repintado: Cell<u32>,
    ctrl_u: Cell<u32>,
    ctrl_u_inutil: bool,
    ctrl_u_rechazado: bool,
    resto: Option<&'static str>,
}

impl PantallaFalsa {
    fn con(texto: &str, repintado: u32) -> Self {
        Self {
            texto: RefCell::new(Some(texto.to_string())),
            limpiada: Cell::new(false),
            repintado: Cell::new(repintado),
            ctrl_u: Cell::new(0),
            ctrl_u_inutil: false,
            ctrl_u_rechazado: false,
            resto: None,
        }
    }
}

impl Pantalla for PantallaFalsa {
    fn entrada(&self) -> Option<String> {
        if self.limpiada.get() {
            if self.repintado.get() == 0 {
                *self.texto.borrow_mut() = None;
            } else {
                self.repintado.set(self.repintado.get() - 1);
            }
        }
        self.texto.borrow().clone()
    }
    fn limpiar_linea(&self) -> Result<(), ErrorEscritura> {
        if self.ctrl_u_rechazado {
            return Err(ErrorEscritura::Terminada);
        }
        self.ctrl_u.set(self.ctrl_u.get() + 1);
        if let Some(r) = self.resto {
            *self.texto.borrow_mut() = Some(r.to_string());
        } else if !self.ctrl_u_inutil {
            self.limpiada.set(true);
        }
        Ok(())
    }
    fn dormir(&self, _d: Duration) {}
}

fn intacta() -> Vaciado {
    Vaciado {
        texto: None,
        vacia: false,
        tolerada: None,
    }
}

#[test]
fn con_puente_lee_y_limpia_la_caja_y_sin_puente_no_hace_nada() {
    let b = BuzonFalso::con(Some("hola"));
    assert_eq!(
        vaciar_caja("s", true, &b),
        Puente {
            leido: Some("hola".into()),
            limpia: true
        }
    );
    assert_eq!(b.ops.borrow().clone(), vec!["prompt.read", "prompt.clear"]);
    let sin = BuzonFalso::con(Some("hola"));
    assert_eq!(vaciar_caja("s", false, &sin), Puente::default());
    assert!(sin.ops.borrow().is_empty());
    let mudo = BuzonFalso::con(None);
    assert_eq!(vaciar_caja("s", true, &mudo), Puente::default());
    assert_eq!(
        mudo.ops.borrow().clone(),
        vec!["prompt.read"],
        "sin lectura no se limpia"
    );
}

/// El fallo del 14-10: el puente limpia, pero la TUI tarda en repintar la caja
/// vacía. Se espera al repintado en vez de reintentar el pegado en el acto.
#[test]
fn espera_a_que_la_pantalla_muestre_la_caja_vacia() {
    let b = BuzonFalso::con(Some("hola"));
    let p = PantallaFalsa::con("hola", 5);
    p.limpiada.set(true); // el puente ya limpió; la pantalla va con retraso
    let v = liberar("s", true, &b, &p);
    assert_eq!(
        v,
        Vaciado {
            texto: Some("hola".into()),
            vacia: true,
            tolerada: None
        }
    );
    assert_eq!(p.ctrl_u.get(), 0, "sin Ctrl+U si el puente basta");
}

/// Sin puente (o con el puente mudo), Ctrl+U y el texto leído de la pantalla
/// vuelve a la cola.
#[test]
fn sin_puente_o_con_el_puente_mudo_vacia_con_ctrl_u() {
    for (v2, b) in [
        (false, BuzonFalso::con(Some("x"))),
        (true, BuzonFalso::con(None)),
    ] {
        let p = PantallaFalsa::con("texto de la caja", 2);
        let v = liberar("s", v2, &b, &p);
        assert_eq!(v.texto.as_deref(), Some("texto de la caja"), "v2={v2}");
        assert!(v.vacia, "v2={v2}");
        assert_eq!(p.ctrl_u.get(), 1, "v2={v2}");
    }
}

/// Caso negativo (M2): si el Ctrl+U no vacía la caja, su texto sigue en
/// ella y no vuelve a la cola (estaría dos veces); el pegado no se reintenta.
#[test]
fn caja_que_no_se_vacia_no_da_paso_al_pegado_ni_reencola() {
    let b = BuzonFalso::con(None);
    let p = PantallaFalsa {
        ctrl_u_inutil: true,
        ..PantallaFalsa::con("línea 1\nlínea 2", 0)
    };
    assert_eq!(liberar("s", true, &b, &p), intacta());
    assert_eq!(p.ctrl_u.get(), 1);
    assert!(ocupada().contains("no se pudo vaciar"));
}

/// El puente dice que limpió pero la pantalla no cambia: un Ctrl+U de remate.
#[test]
fn puente_que_no_repinta_recibe_un_ctrl_u_de_remate() {
    let b = BuzonFalso::con(Some("hola"));
    let p = PantallaFalsa::con("hola", 0);
    let v = liberar("s", true, &b, &p);
    assert!(v.vacia);
    assert_eq!(v.texto.as_deref(), Some("hola"));
    assert_eq!(p.ctrl_u.get(), 1);
}

/// M1: `prompt.read` responde y `prompt.clear` vence. Se conserva el texto
/// exacto del puente (con su sangría), no la lectura de la pantalla, que
/// recorta cada línea.
#[test]
fn lectura_ok_y_limpieza_vencida_conserva_el_texto_del_puente() {
    let exacto = "def f():\n    return 1";
    let b = BuzonFalso {
        limpia: false,
        ..BuzonFalso::con(Some(exacto))
    };
    let p = PantallaFalsa::con("def f():\nreturn 1", 0);
    let v = liberar("s", true, &b, &p);
    assert_eq!(
        v,
        Vaciado {
            texto: Some(exacto.into()),
            vacia: true,
            tolerada: None
        }
    );
    assert_eq!(p.ctrl_u.get(), 1);
}

/// M2: Ctrl+U rechazado por el escritor. Nada salió de la caja: no vuelve
/// nada a la cola y el envío falla con la caja intacta.
#[test]
fn ctrl_u_rechazado_no_reencola() {
    let b = BuzonFalso::con(None);
    let p = PantallaFalsa {
        ctrl_u_rechazado: true,
        ..PantallaFalsa::con("hola", 0)
    };
    assert_eq!(liberar("s", false, &b, &p), intacta());
    let mut recuperados = Vec::new();
    let pausas = Pausas::default();
    let r = despejar("s", false, &b, &p, &pausas, &mut |t| recuperados.push(t));
    assert_eq!(r, Err(ocupada()));
    assert!(recuperados.is_empty(), "{recuperados:?}");
    assert_eq!(p.texto.borrow().as_deref(), Some("hola"));
}

/// H2: la caja cambia mientras el buzón espera (el usuario sigue
/// escribiendo). Sin lectura del puente, a la cola va lo que había justo
/// antes del Ctrl+U, no lo de al principio.
#[test]
fn la_pantalla_se_lee_justo_antes_del_ctrl_u() {
    let p = PantallaFalsa::con("ab", 1);
    let b = BuzonFalso {
        escribe: Some((&p, "abc")),
        ..BuzonFalso::con(None)
    };
    let v = liberar("s", true, &b, &p);
    assert_eq!(v.texto.as_deref(), Some("abc"));
    assert!(v.vacia);
}

/// H2 con el puente: `prompt.read` leyó «ab», `prompt.clear` vence y la caja
/// ya muestra otra cosa. Lo leído está desfasado: no se borra nada.
#[test]
fn caja_cambiada_desde_la_lectura_del_puente_no_se_borra() {
    let p = PantallaFalsa::con("ab", 0);
    let b = BuzonFalso {
        limpia: false,
        escribe: Some((&p, "ab y algo más")),
        ..BuzonFalso::con(Some("ab"))
    };
    assert_eq!(liberar("s", true, &b, &p), intacta());
    assert_eq!(p.ctrl_u.get(), 0);
    assert_eq!(p.texto.borrow().as_deref(), Some("ab y algo más"));
}

/// El puente limpió lo que leyó y en la caja aparece texto nuevo: lo leído
/// vuelve a la cola (ya no está en la caja) y lo nuevo no se toca.
#[test]
fn texto_nuevo_tras_la_limpieza_del_puente_no_se_toca() {
    let p = PantallaFalsa::con("viejo", 0);
    let b = BuzonFalso {
        escribe: Some((&p, "nuevo")),
        ..BuzonFalso::con(Some("viejo"))
    };
    let v = liberar("s", true, &b, &p);
    assert_eq!(
        v,
        Vaciado {
            texto: Some("viejo".into()),
            vacia: false,
            tolerada: None
        }
    );
    assert_eq!(p.ctrl_u.get(), 0);
}

/// H3: solo con la lectura de la pantalla, un pegado plegado, una imagen o
/// una caja al tope de filas no se borran: su contenido real no está en la
/// lectura.
#[test]
fn texto_plegado_o_recortado_no_se_borra() {
    let tope = ["línea"; MAX_FILAS_CAJA].join("\n");
    for caja in [
        "[Pasted text #1 +40 lines]",
        "mira esto [Image #1]",
        tope.as_str(),
    ] {
        let p = PantallaFalsa::con(caja, 0);
        let b = BuzonFalso::con(None);
        assert_eq!(liberar("s", true, &b, &p), intacta(), "{caja}");
        assert_eq!(p.ctrl_u.get(), 0, "{caja}");
    }
}

/// Ctrl+U que solo borra la línea del cursor de una caja de varias: lo que
/// salió solo está en la lectura, que vuelve entera a la cola; la caja sigue
/// ocupada y el pegado no se reintenta.
#[test]
fn ctrl_u_parcial_conserva_lo_borrado() {
    let p = PantallaFalsa {
        resto: Some("línea 1"),
        ..PantallaFalsa::con("línea 1\nlínea 2", 0)
    };
    let v = liberar("s", false, &BuzonFalso::con(None), &p);
    assert_eq!(
        v,
        Vaciado {
            texto: Some("línea 1\nlínea 2".into()),
            vacia: false,
            tolerada: None
        }
    );
}

/// M5: con la caja que no se vacía y la app desatendida, el drenaje
/// automático no reintenta cada tick. Un solo Ctrl+U, nada reencolado;
/// la pausa se levanta cuando la caja cambia o pasado el plazo.
#[test]
fn caja_ocupada_no_reencola_ni_reintenta_en_bucle() {
    let b = BuzonFalso::con(None);
    let p = PantallaFalsa {
        ctrl_u_inutil: true,
        ..PantallaFalsa::con("borrador", 0)
    };
    let pausas = Pausas::default();
    let t0 = Instant::now();
    let mut recuperados = Vec::new();
    let mut intentos = 0;
    let mut tick = |ahora: Instant, recuperados: &mut Vec<String>| {
        if pausas.en_pausa("s", || p.entrada(), ahora) {
            return;
        }
        intentos += 1;
        let r = despejar("s", false, &b, &p, &pausas, &mut |t| recuperados.push(t));
        assert_eq!(r, Err(ocupada()));
    };
    for s in 0..30 {
        tick(t0 + Duration::from_secs(s), &mut recuperados);
    }
    assert_eq!(p.ctrl_u.get(), 1, "un Ctrl+U, no uno por tick");
    assert!(recuperados.is_empty(), "{recuperados:?}");
    *p.texto.borrow_mut() = Some("borrador editado".into());
    tick(t0 + Duration::from_secs(31), &mut recuperados);
    assert_eq!(p.ctrl_u.get(), 2, "la caja cambió: otro intento");
    tick(t0 + Duration::from_secs(32), &mut recuperados);
    tick(
        t0 + REINTENTO_EN_PAUSA + Duration::from_secs(40),
        &mut recuperados,
    );
    assert_eq!(p.ctrl_u.get(), 3, "pasado el plazo, un intento más");
    assert!(recuperados.is_empty());
    assert_eq!(intentos, 3);
}

/// La caja vacía no deja pausa, y un vaciado que sí funciona la levanta.
#[test]
fn sin_caja_no_hay_pausa_y_un_vaciado_bueno_la_levanta() {
    let pausas = Pausas::default();
    let t0 = Instant::now();
    pausas.pausar("s", None, t0);
    assert!(!pausas.en_pausa("s", || None, t0));
    pausas.pausar("s", Some("x".into()), t0);
    assert!(pausas.en_pausa("s", || Some("x".into()), t0));
    let p = PantallaFalsa::con("x", 0);
    let mut recuperados = Vec::new();
    let r = despejar("s", false, &BuzonFalso::con(None), &p, &pausas, &mut |t| {
        recuperados.push(t)
    });
    assert_eq!(r, Ok(None));
    assert_eq!(recuperados, vec!["x".to_string()]);
    assert!(!pausas.en_pausa("s", || Some("x".into()), t0));
}

/// Sugerencia en gris que el clasificador de la pantalla toma por texto.
const PISTA: &str = "Try \"refactor caja.rs\"";

/// El fallo del 19-10: `prompt.read` lee la caja vacía y la pantalla muestra
/// un placeholder. Sin `prompt.clear` ni Ctrl+U, nada vuelve a la cola (no es
/// texto del usuario), sin pausa, y el reintento tolera ese texto.
#[test]
fn puente_vacio_con_texto_en_pantalla_es_falso_positivo() {
    let b = BuzonFalso::con(Some(""));
    let p = PantallaFalsa {
        ctrl_u_inutil: true,
        ..PantallaFalsa::con(PISTA, 0)
    };
    assert_eq!(
        liberar("s", true, &b, &p),
        Vaciado {
            texto: None,
            vacia: true,
            tolerada: Some(PISTA.into())
        }
    );
    assert_eq!(b.ops.borrow().clone(), vec!["prompt.read"], "sin clear");
    assert_eq!(p.ctrl_u.get(), 0, "sin Ctrl+U sobre el placeholder");
    let pausas = Pausas::default();
    pausas.pausar("s", Some(PISTA.into()), Instant::now());
    let mut recuperados = Vec::new();
    let r = despejar("s", true, &b, &p, &pausas, &mut |t| recuperados.push(t));
    assert_eq!(r, Ok(Some(PISTA.to_string())));
    assert!(recuperados.is_empty(), "{recuperados:?}");
    assert!(!pausas.en_pausa("s", || p.entrada(), Instant::now()));
    // Con la pantalla también vacía, reintento normal (sin tolerancia).
    let p = PantallaFalsa::con("", 0);
    *p.texto.borrow_mut() = None;
    let r = despejar("s", true, &b, &p, &pausas, &mut |t| recuperados.push(t));
    assert_eq!(r, Ok(None));
}

/// Carrera del falso positivo: el usuario teclea en la caja mientras el
/// puente contesta `prompt.read` vacío. La pantalla de antes (`PISTA`) y la
/// de después (su texto) no coinciden: ni tolerancia ni Ctrl+U ni nada a la
/// cola; Err `ocupada` con pausa y su texto se queda en la caja.
#[test]
fn puente_vacio_con_la_pantalla_cambiando_entre_lecturas_no_tolera() {
    for despues in ["borrador del usuario", "Try \"refactor caja.rs\"x"] {
        let p = PantallaFalsa::con(PISTA, 0);
        let b = BuzonFalso {
            escribe: Some((&p, despues)),
            ..BuzonFalso::con(Some(""))
        };
        assert_eq!(liberar("s", true, &b, &p), intacta(), "{despues}");
        let pausas = Pausas::default();
        let mut recuperados = Vec::new();
        *p.texto.borrow_mut() = Some(PISTA.into());
        let r = despejar("s", true, &b, &p, &pausas, &mut |t| recuperados.push(t));
        assert_eq!(r, Err(ocupada()), "{despues}");
        assert!(recuperados.is_empty(), "{despues}: {recuperados:?}");
        assert_eq!(p.ctrl_u.get(), 0, "{despues}: sin Ctrl+U");
        assert_eq!(p.entrada().as_deref(), Some(despues), "el texto sigue");
        assert!(pausas.en_pausa("s", || p.entrada(), Instant::now()));
    }
    // Caso positivo de control: la misma pantalla en las dos lecturas.
    let p = PantallaFalsa::con(PISTA, 0);
    let b = BuzonFalso {
        escribe: Some((&p, PISTA)),
        ..BuzonFalso::con(Some(""))
    };
    assert_eq!(liberar("s", true, &b, &p).tolerada.as_deref(), Some(PISTA));
}

/// Solo espacios: el puente tiene autoridad si `prompt.clear` lo confirma;
/// sin lectura (sin puente o mudo), nunca.
#[test]
fn autoridad_del_puente_sobre_la_caja_vacia() {
    let p = |leido: Option<&str>, limpia| Puente {
        leido: leido.map(str::to_string),
        limpia,
    };
    assert!(p(Some(""), false).vacia());
    assert!(p(Some("  \n"), true).vacia());
    assert!(!p(Some("  \n"), false).vacia(), "espacios sin limpiar");
    assert!(!p(Some("hola"), true).vacia());
    assert!(!p(None, false).vacia());
    let b = BuzonFalso::con(Some(" "));
    let pantalla = PantallaFalsa::con(PISTA, 0);
    let v = liberar("s", true, &b, &pantalla);
    assert_eq!(v.tolerada.as_deref(), Some(PISTA));
    assert_eq!(b.ops.borrow().clone(), vec!["prompt.read", "prompt.clear"]);
}

/// Casos negativos del falso positivo: sin puente o con el puente mudo, la
/// pantalla es la única lectura y rige el camino de siempre (Ctrl+U; si no
/// vacía, Err y pausa). Con una lectura no vacía y otro texto en pantalla
/// tras la limpieza, lo leído vuelve a la cola y el envío falla, sin
/// tolerancia.
#[test]
fn sin_lectura_vacia_del_puente_no_hay_tolerancia() {
    for (v2, b) in [
        (false, BuzonFalso::con(Some(""))),
        (true, BuzonFalso::con(None)),
    ] {
        let p = PantallaFalsa {
            ctrl_u_inutil: true,
            ..PantallaFalsa::con(PISTA, 0)
        };
        let pausas = Pausas::default();
        let mut recuperados = Vec::new();
        let r = despejar("s", v2, &b, &p, &pausas, &mut |t| recuperados.push(t));
        assert_eq!(r, Err(ocupada()), "v2={v2}");
        assert!(recuperados.is_empty(), "v2={v2}: {recuperados:?}");
        assert_eq!(p.ctrl_u.get(), 1, "v2={v2}");
        assert!(pausas.en_pausa("s", || p.entrada(), Instant::now()));
    }
    let p = PantallaFalsa::con("hola", 0);
    let b = BuzonFalso {
        escribe: Some((&p, PISTA)),
        ..BuzonFalso::con(Some("hola"))
    };
    let mut recuperados = Vec::new();
    let r = despejar("s", true, &b, &p, &Pausas::default(), &mut |t| {
        recuperados.push(t)
    });
    assert_eq!(r, Err(ocupada()));
    assert_eq!(recuperados, vec!["hola".to_string()]);
    assert_eq!(p.ctrl_u.get(), 0);
}

/// El Enter que no salió: la caja sigue con el texto enviado (o con su
/// pegado plegado). Una caja vacía u otro texto no cuentan.
#[test]
fn enter_sin_salir_reconoce_la_caja_con_el_envio() {
    assert!(enter_sin_salir(Some("hola mundo"), "hola\nmundo"));
    assert!(enter_sin_salir(Some("[Pasted text #1 +40 lines]"), "largo"));
    assert!(!enter_sin_salir(None, "hola"));
    assert!(!enter_sin_salir(Some("otra cosa"), "hola"));
}
