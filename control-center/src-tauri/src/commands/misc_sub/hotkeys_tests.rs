// Pruebas de `cambiar_atajo` con un registro de atajos simulado.

use std::cell::RefCell;
use std::collections::BTreeSet;

use super::{cambiar_atajo, RegistroAtajos};

/// Registro en memoria: guarda los atajos registrados y rechaza los de
/// `ocupados` (como si otra aplicación los tuviera).
#[derive(Default)]
struct RegistroFalso {
    registrados: RefCell<BTreeSet<&'static str>>,
    ocupados: BTreeSet<&'static str>,
}

impl RegistroFalso {
    fn con(registrados: &[&'static str]) -> Self {
        Self {
            registrados: RefCell::new(registrados.iter().copied().collect()),
            ocupados: BTreeSet::new(),
        }
    }
    fn activos(&self) -> Vec<&'static str> {
        self.registrados.borrow().iter().copied().collect()
    }
}

impl RegistroAtajos for RegistroFalso {
    type Atajo = &'static str;
    fn registrar(&self, atajo: &'static str) -> Result<(), String> {
        if self.ocupados.contains(atajo) {
            return Err(format!("{atajo} ocupado"));
        }
        self.registrados.borrow_mut().insert(atajo);
        Ok(())
    }
    fn desregistrar(&self, atajo: &'static str) -> Result<(), String> {
        if self.registrados.borrow_mut().remove(atajo) {
            Ok(())
        } else {
            Err(format!("{atajo} no registrado"))
        }
    }
}

#[test]
fn con_guardado_correcto_queda_solo_el_nuevo() {
    let r = RegistroFalso::con(&["ctrl+a"]);
    assert_eq!(
        cambiar_atajo(&r, Some("ctrl+a"), "ctrl+b", || Ok(())),
        Ok(())
    );
    assert_eq!(r.activos(), vec!["ctrl+b"]);
}

#[test]
fn si_falla_el_guardado_se_deshace_el_nuevo_y_vuelve_el_anterior() {
    let r = RegistroFalso::con(&["ctrl+a"]);
    let res = cambiar_atajo(&r, Some("ctrl+a"), "ctrl+b", || Err("disco lleno".into()));
    let err = res.expect_err("el fallo del guardado se propaga");
    assert!(
        err.contains("disco lleno") && err.contains("restored"),
        "{err}"
    );
    assert_eq!(
        r.activos(),
        vec!["ctrl+a"],
        "sin el nuevo y con el anterior"
    );
}

#[test]
fn si_el_nuevo_esta_ocupado_vuelve_el_anterior_y_no_se_guarda() {
    let mut r = RegistroFalso::con(&["ctrl+a"]);
    r.ocupados.insert("ctrl+b");
    let mut guardado = false;
    let res = cambiar_atajo(&r, Some("ctrl+a"), "ctrl+b", || {
        guardado = true;
        Ok(())
    });
    assert!(res.expect_err("ocupado").contains("register failed"));
    assert!(!guardado, "no se persiste un atajo que no se registró");
    assert_eq!(r.activos(), vec!["ctrl+a"]);
}

#[test]
fn un_rollback_que_falla_no_oculta_el_error_del_guardado() {
    // El anterior ya no se puede volver a registrar (otra app lo tomó):
    // el error devuelto sigue siendo el del guardado y no queda el nuevo.
    let mut r = RegistroFalso::con(&["ctrl+a"]);
    r.ocupados.insert("ctrl+a");
    let res = cambiar_atajo(&r, Some("ctrl+a"), "ctrl+b", || Err("sin permisos".into()));
    assert!(res.expect_err("guardado").contains("sin permisos"));
    assert!(r.activos().is_empty());
}

#[test]
fn sin_anterior_un_guardado_fallido_no_deja_nada_registrado() {
    let r = RegistroFalso::default();
    assert!(cambiar_atajo(&r, None, "ctrl+b", || Err("x".into())).is_err());
    assert!(r.activos().is_empty());
}
