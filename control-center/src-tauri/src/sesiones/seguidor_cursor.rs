// sesiones/seguidor_cursor.rs — Cursor incremental sobre un JSONL con modo
// de puesta al día (sesiones largas, CONTRATO-v3 §7).
//
// Un cursor en puesta al día recuerda el EOF que había al abrirlo: las líneas
// hasta ese punto son historia (el frontend las pide paginando
// `sesiones_history`) y el seguidor solo las usa para el estado de parseo;
// las posteriores son vivas. Si el fichero encoge o se sustituye (cambia su
// fecha de creación), el cursor se reabre en puesta al día y la lectura lo
// marca como `reiniciado` para que el seguidor emita `sesiones://reset`.

use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::Value;

use crate::sesiones::transcript::ParseState;

/// Lectura máxima por fichero y tick con líneas vivas.
const MAX_READ: u64 = 8 * 1024 * 1024;
/// Lectura máxima por tick en puesta al día (no emite nada: solo parsea).
const MAX_READ_PUESTA: u64 = 32 * 1024 * 1024;

/// Resultado de una lectura.
#[derive(Debug, Default, PartialEq)]
pub struct Lectura {
    pub lineas: Vec<Value>,
    /// Todas las líneas del lote son anteriores al EOF de la apertura.
    pub historicas: bool,
    /// El fichero encogió o se sustituyó: el cursor se reabrió.
    pub reiniciado: bool,
}

/// Cursor incremental sobre un JSONL.
pub struct Cursor {
    pub path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// EOF al abrir en puesta al día, mientras no se alcance.
    hasta: Option<u64>,
    creado: Option<SystemTime>,
    pub state: ParseState,
}

fn creado(m: &Metadata) -> Option<SystemTime> {
    m.created().ok()
}

impl Cursor {
    /// Cursor que trata todo el contenido como nuevo (fichero recién creado).
    pub fn new(path: PathBuf) -> Self {
        Self::abrir(path, false)
    }

    /// Cursor en puesta al día: lo que ya hay en el fichero es historia.
    pub fn al_dia(path: PathBuf) -> Self {
        Self::abrir(path, true)
    }

    /// true mientras no se alcance el EOF que había al abrir.
    pub fn en_puesta_al_dia(&self) -> bool {
        self.hasta.is_some()
    }

    fn abrir(path: PathBuf, puesta_al_dia: bool) -> Self {
        let meta = std::fs::metadata(&path).ok();
        let len = meta.as_ref().map_or(0, Metadata::len);
        Self {
            path,
            offset: 0,
            partial: Vec::new(),
            hasta: (puesta_al_dia && len > 0).then_some(len),
            creado: meta.as_ref().and_then(creado),
            state: ParseState::default(),
        }
    }

    fn sustituido(&self, m: &Metadata) -> bool {
        let len = m.len();
        len < self.offset
            || self.hasta.is_some_and(|h| len < h)
            || (self.creado.is_some() && creado(m) != self.creado)
    }

    /// Líneas completas nuevas desde la última lectura.
    pub fn leer(&mut self) -> Lectura {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return Lectura::default();
        };
        let reiniciado = self.sustituido(&meta);
        if reiniciado {
            *self = Cursor::al_dia(self.path.clone());
        }
        let mut l = self.leer_bloque(meta.len());
        l.reiniciado = reiniciado;
        l
    }

    fn leer_bloque(&mut self, len: u64) -> Lectura {
        let historicas = self.hasta.is_some_and(|h| self.offset < h);
        let tope = match self.hasta {
            Some(h) if historicas => (h - self.offset).min(MAX_READ_PUESTA),
            _ => MAX_READ,
        };
        if len <= self.offset {
            return Lectura::default();
        }
        let Some(buf) = self.leer_bytes((len - self.offset).min(tope)) else {
            return Lectura::default();
        };
        self.offset += buf.len() as u64;
        if self.hasta.is_some_and(|h| self.offset >= h) {
            self.hasta = None;
        }
        Lectura {
            lineas: self.lineas_completas(&buf),
            historicas,
            reiniciado: false,
        }
    }

    fn leer_bytes(&self, want: u64) -> Option<Vec<u8>> {
        let mut f = File::open(&self.path).ok()?;
        f.seek(SeekFrom::Start(self.offset)).ok()?;
        let mut buf = Vec::new();
        f.take(want).read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    fn lineas_completas(&mut self, buf: &[u8]) -> Vec<Value> {
        self.partial.extend_from_slice(buf);
        let Some(last_nl) = self.partial.iter().rposition(|b| *b == b'\n') else {
            return Vec::new();
        };
        let rest = self.partial.split_off(last_nl + 1);
        let complete = std::mem::replace(&mut self.partial, rest);
        String::from_utf8_lossy(&complete)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn cursor_lee_solo_lineas_completas_e_incrementales() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        let mut f = File::create(&p).expect("crear");
        write!(f, "{{\"a\":1}}\n{{\"a\":").expect("escribir");
        f.flush().expect("flush");
        let mut c = Cursor::new(p.clone());
        let first = c.leer();
        assert_eq!(first.lineas.len(), 1, "la línea a medias espera");
        assert!(!first.historicas);
        writeln!(f, "2}}").expect("escribir");
        f.flush().expect("flush");
        assert_eq!(c.leer().lineas, vec![json!({"a": 2})]);
        assert!(c.leer().lineas.is_empty(), "sin cambios, sin líneas");
    }

    #[test]
    fn en_puesta_al_dia_lo_previo_es_historia_y_lo_nuevo_vivo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        let mut f = File::create(&p).expect("crear");
        write!(f, "{{\"a\":1}}\n{{\"a\":2}}\n{{\"a\":").expect("escribir");
        f.flush().expect("flush");
        let mut c = Cursor::al_dia(p.clone());
        assert!(c.en_puesta_al_dia());
        let h = c.leer();
        assert!(h.historicas);
        assert_eq!(h.lineas.len(), 2);
        assert!(!c.en_puesta_al_dia(), "EOF de la apertura alcanzado");
        writeln!(f, "3}}\n{{\"a\":4}}").expect("escribir");
        f.flush().expect("flush");
        let v = c.leer();
        assert!(
            !v.historicas,
            "la línea a medias al abrir se completó después"
        );
        assert_eq!(v.lineas, vec![json!({"a": 3}), json!({"a": 4})]);
    }

    #[test]
    fn si_el_fichero_encoge_se_reabre_en_puesta_al_dia() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{\"a\":2}\n").expect("escribir");
        let mut c = Cursor::new(p.clone());
        assert_eq!(c.leer().lineas.len(), 2);
        std::fs::write(&p, "{\"b\":1}\n").expect("reescribir");
        let l = c.leer();
        assert!(l.reiniciado && l.historicas, "nada se reemite como nuevo");
        assert_eq!(l.lineas, vec![json!({"b": 1})]);
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .expect("abrir");
        writeln!(f, "{{\"b\":2}}").expect("escribir");
        let l = c.leer();
        assert!(!l.reiniciado && !l.historicas);
        assert_eq!(l.lineas, vec![json!({"b": 2})]);
    }
}
