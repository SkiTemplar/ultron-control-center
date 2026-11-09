// sesiones/persistencia_descartes.rs — Sesiones guardadas que no se pudieron
// restaurar por una condición pasajera (carpeta o transcript inaccesibles:
// una unidad aún sin montar, una carpeta de red caída).
//
// Sin esto se perdían para siempre: el escritor reescribe `abiertas.json`
// solo con las restauradas. Se apartan en `abiertas.descartadas.json` (mismo
// formato que `abiertas.json`) y se reintentan en el arranque siguiente; las
// que se restauran salen del fichero y las que vuelven a fallar se quedan.
//
// Propiedad: WP-ESTADO.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::{escribir_atomico, leer, Abierta, Fichero, Lectura, VERSION};

/// Nombre del fichero de descartes, junto a `abiertas.json`.
const NOMBRE: &str = "abiertas.descartadas.json";

/// Ruta del fichero de descartes junto a `abiertas` (la de `abiertas.json`).
pub fn ruta_de(abiertas: &Path) -> PathBuf {
    abiertas.with_file_name(NOMBRE)
}

/// Sesiones apartadas en arranques anteriores. `Err` si el fichero existe y
/// no se pudo leer: entonces no se reescribe (no se pisa lo que no se leyó).
/// Un fichero dañado se aparta a `.bad` como `abiertas.json`.
pub fn leer_apartadas(ruta: &Path) -> Result<Vec<Abierta>, String> {
    match leer(ruta)? {
        Lectura::Vacia => Ok(Vec::new()),
        Lectura::Leida(f) => Ok(f.sesiones),
        Lectura::Apartada { destino, error } => Err(format!(
            "{NOMBRE} estaba dañado ({error}) y se ha apartado como {}",
            destino.display()
        )),
    }
}

/// Las guardadas en `abiertas.json` y, detrás, las apartadas cuyo id no está
/// ya entre ellas.
pub fn unir(guardadas: Vec<Abierta>, apartadas: Vec<Abierta>) -> Vec<Abierta> {
    let ids: HashSet<String> = guardadas.iter().map(|a| a.id.clone()).collect();
    guardadas
        .into_iter()
        .chain(apartadas.into_iter().filter(|a| !ids.contains(&a.id)))
        .collect()
}

/// Reescribe el fichero con `apartadas`; sin ninguna, lo borra.
pub fn guardar(ruta: &Path, apartadas: &[Abierta]) -> Result<(), String> {
    if apartadas.is_empty() {
        return match std::fs::remove_file(ruta) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("no se pudo borrar {}: {e}", ruta.display())),
        };
    }
    let f = Fichero {
        version: VERSION,
        sesiones: apartadas.to_vec(),
    };
    let texto = serde_json::to_string_pretty(&f)
        .map_err(|e| format!("no se pudo serializar {NOMBRE}: {e}"))?;
    escribir_atomico(ruta, &texto)
}
