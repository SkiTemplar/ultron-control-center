// JSON en disco del router: lectura, escritura atómica y actualización bajo
// un cerrojo de fichero.
//
// `metrics.json` lo reescriben a la vez la GUI (varios hilos con `route()`) y
// el sidecar `ultron-memory capture`, uno por cada Stop hook. Hasta el
// 2026-10-23 cada escritor hacía su leer-modificar-escribir sin cerrojo y con
// el mismo `metrics.json.tmp`: dos escrituras intercaladas perdían
// actualizaciones (contadores diarios, cooldowns) o dejaban el JSON truncado,
// y la siguiente lectura fallida arrancaba de `RouterMetrics::default()` y
// pisaba el historial.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", path.display(), e))
}

/// Contador del proceso para que dos escrituras del mismo proceso (dos hilos)
/// tampoco compartan el temporal.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Temporal único por proceso y escritura, junto al destino (mismo volumen,
/// para que el `rename` sea atómico).
fn unique_tmp_path(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "router".to_string());
    path.with_file_name(format!("{name}.{}.{seq}.tmp", std::process::id()))
}

/// Escribe `value` en `path` de forma atómica: temporal único y `rename`.
/// Un lector concurrente ve el fichero viejo o el nuevo, nunca uno a medias.
pub(crate) fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize {}: {}", path.display(), e))?;
    let tmp = unique_tmp_path(path);
    if let Err(e) = fs::write(&tmp, &body) {
        // El temporal a medias no sirve para nada: se borra y se informa del
        // fallo de escritura, que es el que importa.
        let _ = fs::remove_file(&tmp);
        return Err(format!("write {}: {}", tmp.display(), e));
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename to {}: {}", path.display(), e)
    })
}

/// Cerrojo exclusivo entre procesos sobre `<path>.lock`. Se suelta al soltar
/// el `File` devuelto. El cerrojo va en un fichero aparte porque el destino
/// se sustituye por `rename` en cada escritura.
fn lock_exclusive(path: &Path) -> Result<File, String> {
    let lock_path = path.with_extension("json.lock");
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {}", parent.display(), e))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("open {}: {}", lock_path.display(), e))?;
    file.lock()
        .map_err(|e| format!("lock {}: {}", lock_path.display(), e))?;
    Ok(file)
}

/// Lee `path` (o `T::default()` si no existe), aplica `mutate` y lo escribe
/// de forma atómica, todo bajo el cerrojo de fichero: dos procesos o dos
/// hilos no pueden perder la actualización del otro.
///
/// Un fichero que no parsea NO se pisa con el valor por defecto: se aparta a
/// `<path>.corrupt-<pid>-<ts>` para poder inspeccionarlo, se registra el
/// incidente y se continúa desde cero (si no, el router dejaría de registrar
/// métricas para siempre).
pub(crate) fn update_json_locked<T, F>(path: &PathBuf, mutate: F) -> Result<(), String>
where
    T: serde::de::DeserializeOwned + Serialize + Default,
    F: FnOnce(&mut T),
{
    let _lock = lock_exclusive(path)?;
    let mut value: T = read_or_quarantine(path)?;
    mutate(&mut value);
    write_json(path, &value)
}

fn read_or_quarantine<T>(path: &PathBuf) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    match serde_json::from_slice(&bytes) {
        Ok(v) => Ok(v),
        Err(parse_err) => {
            let aside = path.with_extension(format!(
                "json.corrupt-{}-{}",
                std::process::id(),
                chrono::Utc::now().format("%Y%m%dT%H%M%S")
            ));
            fs::rename(path, &aside).map_err(|e| {
                format!(
                    "{} no parsea ({parse_err}) y no se ha podido apartar a {}: {e}",
                    path.display(),
                    aside.display()
                )
            })?;
            tracing::warn!(
                path = %path.display(),
                aside = %aside.display(),
                error = %parse_err,
                "metricas del router corruptas: se apartan y se empieza de cero"
            );
            Ok(T::default())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default, Serialize, serde::Deserialize)]
    struct Counter {
        n: u64,
        #[serde(default)]
        extra: HashMap<String, u64>,
    }

    /// Caso negativo del hallazgo router-4: con el leer-modificar-escribir sin
    /// cerrojo, 8 hilos x 50 incrementos pierden actualizaciones. Con el
    /// cerrojo el total es exacto y no queda ningún temporal suelto.
    #[test]
    fn concurrent_updates_lose_nothing_and_leave_no_tmp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("metrics.json");
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let p = path.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        update_json_locked(&p, |c: &mut Counter| c.n += 1).expect("update");
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().expect("join");
        }
        let c: Counter = read_json(&path).expect("read");
        assert_eq!(c.n, 400, "se han perdido actualizaciones concurrentes");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temporales sin limpiar: {leftovers:?}"
        );
    }

    /// Un JSON roto no se pisa con el valor por defecto en silencio: se
    /// aparta, y el contenido original sigue disponible para inspeccionarlo.
    #[test]
    fn corrupt_file_is_quarantined_not_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("metrics.json");
        fs::write(&path, b"{\"n\": 7, \"extra\": {").expect("seed");
        update_json_locked(&path, |c: &mut Counter| c.n += 1).expect("update");
        let c: Counter = read_json(&path).expect("read");
        assert_eq!(c.n, 1);
        let aside: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(aside.len(), 1, "el fichero roto debe quedar apartado");
        let original = fs::read(aside[0].path()).expect("aside");
        assert_eq!(original, b"{\"n\": 7, \"extra\": {");
    }

    /// Dos escrituras seguidas del mismo proceso usan temporales distintos.
    #[test]
    fn tmp_paths_are_unique_per_write() {
        let p = PathBuf::from("metrics.json");
        assert_ne!(unique_tmp_path(&p), unique_tmp_path(&p));
    }
}
