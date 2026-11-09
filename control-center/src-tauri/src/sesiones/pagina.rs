// sesiones/pagina.rs — Historial paginado (`sesiones_history`, CONTRATO-v3
// §7).
//
// Un transcript de días pesa 50-200 MB: nunca viaja entero por IPC. Cada
// llamada devuelve los últimos `limit` mensajes anteriores a `beforeUuid`;
// el inicio retrocede hasta el prompt que abre su turno (como mucho otros
// `limit` mensajes) para no partirlo. El parseo se guarda en una caché de
// `CACHE_ENTRADAS` ficheros con clave (ruta, agente, tamaño, mtime): las
// páginas siguientes de un fichero que no ha cambiado no lo vuelven a parsear
// (un transcript de 76 MB tardaba 0,5 s por página). La caché no es
// residente: un hilo suelta cada parseo tras `CACHE_INACTIVIDAD` sin uso y
// termina al vaciarla, y la suma de tamaños no pasa de `CACHE_TOPE_BYTES`.
//
// Además del número de mensajes, la página tiene un tope de peso en JSON
// (`PRESUPUESTO_BYTES`): las capturas de pantalla de los `tool_result` viajan
// en base64 (~250 KB cada una) y 400 mensajes con decenas de capturas pesan
// 9 MB. Con el tope, la página trae menos mensajes y `hasMore` queda en
// `true`; el retroceso hasta el prompt tampoco lo supera. Un único mensaje
// más pesado que el tope viaja igualmente (la página nunca queda vacía).

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use super::transcript;
use super::types::{ChatMessage, MessageKind};

/// Mensajes por página si el cliente no dice otra cosa.
pub const LIMITE_POR_DEFECTO: usize = 400;
/// Tope de `limit` (también el retroceso máximo para no partir un turno).
pub const LIMITE_MAXIMO: usize = 2_000;
/// Error de `beforeUuid` que no existe: el cliente recarga desde el final.
pub const CURSOR_PERDIDO: &str = "history_cursor_gone";
/// Peso máximo de los mensajes de una página, en bytes de JSON.
pub const PRESUPUESTO_BYTES: usize = 2_000_000;
/// Transcripts parseados que se conservan (cada uno puede ocupar decenas de MB).
const CACHE_ENTRADAS: usize = 2;
/// Sin uso durante este tiempo, el parseo se suelta (la GUI vuelve a su RAM
/// de reposo; la página siguiente reparsea).
const CACHE_INACTIVIDAD: Duration = Duration::from_secs(90);
/// Suma máxima de tamaños de transcript en caché; uno mayor no se guarda.
const CACHE_TOPE_BYTES: u64 = 128 * 1024 * 1024;

/// Página del historial (camelCase en el cable).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub messages: Vec<ChatMessage>,
    /// Quedan mensajes antes del primero de la página.
    pub has_more: bool,
}

/// `limit` del cliente recortado a [1, `LIMITE_MAXIMO`].
pub fn limite(limit: Option<usize>) -> usize {
    limit.unwrap_or(LIMITE_POR_DEFECTO).clamp(1, LIMITE_MAXIMO)
}

/// Mensaje que abre un turno: prompt de la persona no absorbido a mitad de
/// turno.
fn abre_turno(m: &ChatMessage) -> bool {
    m.kind == MessageKind::Prompt && !m.queued
}

/// Contador de bytes para medir el JSON sin construirlo.
struct Contador(usize);

impl io::Write for Contador {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Bytes del mensaje serializado (más la coma del array).
fn peso(m: &ChatMessage) -> usize {
    let mut c = Contador(1);
    if let Err(e) = serde_json::to_writer(&mut c, m) {
        tracing::debug!(error = %e, "mensaje no serializable al medir la página");
    }
    c.0
}

/// Inicio por número y por peso: (índice, bytes usados). Al menos un mensaje
/// si hay alguno.
fn inicio_por_cuenta_y_peso(
    msgs: &[ChatMessage],
    limit: usize,
    presupuesto: usize,
) -> (usize, usize) {
    let fin = msgs.len();
    let tope = fin.saturating_sub(limit);
    let (mut inicio, mut usado) = (fin, 0usize);
    while inicio > tope {
        let p = peso(&msgs[inicio - 1]);
        if inicio < fin && usado + p > presupuesto {
            break;
        }
        usado += p;
        inicio -= 1;
    }
    (inicio, usado)
}

/// Índice del primer mensaje de la página que termina en `msgs.len()`.
fn inicio_de_pagina(msgs: &[ChatMessage], limit: usize, presupuesto: usize) -> usize {
    let (inicio, mut usado) = inicio_por_cuenta_y_peso(msgs, limit, presupuesto);
    if inicio == 0 || abre_turno(&msgs[inicio]) {
        return inicio;
    }
    let tope = inicio.saturating_sub(limit);
    for i in (tope..inicio).rev() {
        usado += peso(&msgs[i]);
        if usado > presupuesto {
            return inicio;
        }
        if abre_turno(&msgs[i]) {
            return i;
        }
    }
    // El principio del transcript también es frontera de turno.
    if tope == 0 {
        0
    } else {
        inicio
    }
}

/// Página de `msgs` (ya parseados) antes de `antes_de`. Solo la usan los
/// tests: `leer` pagina sobre el parseo prestado de la caché.
#[cfg(test)]
pub fn paginar(
    msgs: Vec<ChatMessage>,
    antes_de: Option<&str>,
    limit: usize,
) -> Result<HistoryPage, String> {
    paginar_con(msgs, antes_de, limit, PRESUPUESTO_BYTES)
}

/// `paginar` con un tope de peso explícito.
#[cfg(test)]
pub fn paginar_con(
    msgs: Vec<ChatMessage>,
    antes_de: Option<&str>,
    limit: usize,
    presupuesto: usize,
) -> Result<HistoryPage, String> {
    paginar_ref(&msgs, antes_de, limit, presupuesto)
}

/// Página sobre mensajes prestados: solo se copian los de la página.
pub(super) fn paginar_ref(
    msgs: &[ChatMessage],
    antes_de: Option<&str>,
    limit: usize,
    presupuesto: usize,
) -> Result<HistoryPage, String> {
    let fin = match antes_de {
        None => msgs.len(),
        Some(u) => msgs
            .iter()
            .position(|m| !u.is_empty() && m.uuid == u)
            .ok_or_else(|| CURSOR_PERDIDO.to_string())?,
    };
    let previos = &msgs[..fin];
    let inicio = inicio_de_pagina(previos, limit, presupuesto);
    Ok(HistoryPage {
        messages: previos[inicio..].to_vec(),
        has_more: inicio > 0,
    })
}

/// Identidad de una versión del fichero: si cambia el tamaño o la fecha de
/// modificación, el parseo guardado ya no vale.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Clave {
    ruta: PathBuf,
    agente: Option<String>,
    tamano: u64,
    mtime: Option<SystemTime>,
}

fn clave_de(path: &Path, agent_id: Option<&str>) -> io::Result<Clave> {
    let meta = std::fs::metadata(path)?;
    Ok(Clave {
        ruta: path.to_path_buf(),
        agente: agent_id.map(str::to_string),
        tamano: meta.len(),
        mtime: meta.modified().ok(),
    })
}

type Parseo = Arc<Vec<ChatMessage>>;

/// Parseo guardado y su último uso.
struct Entrada {
    clave: Clave,
    msgs: Parseo,
    uso: Instant,
}

/// LRU pequeña de transcripts parseados (la más reciente al final). Las
/// entradas se sueltan tras `CACHE_INACTIVIDAD` sin uso y la suma de tamaños
/// no pasa de `CACHE_TOPE_BYTES`: la GUI no retiene decenas de MB de capturas
/// en base64 por una sesión que ya nadie pagina.
#[derive(Default)]
struct CacheParseo {
    entradas: VecDeque<Entrada>,
    /// Hay un hilo de limpieza vivo (se lee y escribe bajo el cerrojo).
    limpiador: bool,
}

impl CacheParseo {
    fn tomar(&mut self, clave: &Clave, ahora: Instant) -> Option<Parseo> {
        self.purgar(ahora);
        let i = self.entradas.iter().position(|e| &e.clave == clave)?;
        let vieja = self.entradas.remove(i)?;
        let msgs = Arc::clone(&vieja.msgs);
        self.entradas.push_back(Entrada {
            uso: ahora,
            ..vieja
        });
        Some(msgs)
    }

    /// Guarda el parseo; `true` si hace falta lanzar el hilo de limpieza.
    fn guardar(&mut self, clave: Clave, msgs: Parseo, ahora: Instant) -> bool {
        // Una versión anterior del mismo fichero ya no sirve: se suelta.
        self.entradas
            .retain(|e| e.clave.ruta != clave.ruta || e.clave.agente != clave.agente);
        if clave.tamano > CACHE_TOPE_BYTES {
            return false;
        }
        self.entradas.push_back(Entrada {
            clave,
            msgs,
            uso: ahora,
        });
        while self.entradas.len() > CACHE_ENTRADAS || self.bytes() > CACHE_TOPE_BYTES {
            self.entradas.pop_front();
        }
        let lanzar = !self.limpiador;
        self.limpiador = true;
        lanzar
    }

    fn purgar(&mut self, ahora: Instant) {
        self.entradas
            .retain(|e| ahora.saturating_duration_since(e.uso) < CACHE_INACTIVIDAD);
    }

    fn bytes(&self) -> u64 {
        self.entradas.iter().map(|e| e.clave.tamano).sum()
    }

    /// Una pasada del limpiador; `false` cuando ya no queda nada que vigilar
    /// (el hilo termina y el próximo `guardar` lanza otro).
    fn paso_limpieza(&mut self, ahora: Instant) -> bool {
        self.purgar(ahora);
        self.limpiador = !self.entradas.is_empty();
        self.limpiador
    }
}

/// Parseo del transcript, de la caché si el fichero no ha cambiado.
/// `lanzar_limpiador` se llama cuando la caché pasa a tener entradas sin hilo
/// de limpieza; devuelve `false` si no pudo lanzarlo.
fn parseo_cacheado<F, L>(
    cache: &Mutex<CacheParseo>,
    clave: Clave,
    parse: F,
    lanzar_limpiador: L,
) -> io::Result<Parseo>
where
    F: FnOnce() -> io::Result<Vec<ChatMessage>>,
    L: FnOnce() -> bool,
{
    let ahora = Instant::now();
    if let Some(msgs) = cache.lock().ok().and_then(|mut c| c.tomar(&clave, ahora)) {
        return Ok(msgs);
    }
    // Se parsea sin el cerrojo: otra sesión no espera a este fichero.
    let msgs = Arc::new(parse()?);
    let lanzar = cache
        .lock()
        .map(|mut c| c.guardar(clave, Arc::clone(&msgs), Instant::now()))
        .unwrap_or(false);
    if lanzar && !lanzar_limpiador() {
        // Sin limpiador no se retiene nada: mejor reparsear que no soltar.
        if let Ok(mut c) = cache.lock() {
            c.entradas.clear();
            c.limpiador = false;
        }
    }
    Ok(msgs)
}

fn cache_global() -> &'static Mutex<CacheParseo> {
    static CACHE: OnceLock<Mutex<CacheParseo>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CacheParseo::default()))
}

/// Hilo que purga la caché global por inactividad y termina al vaciarla.
fn lanzar_limpiador_global() -> bool {
    let lanzado = std::thread::Builder::new()
        .name("sesiones-pagina-cache".into())
        .spawn(|| loop {
            std::thread::sleep(CACHE_INACTIVIDAD / 3);
            let seguir = cache_global()
                .lock()
                .map(|mut c| c.paso_limpieza(Instant::now()))
                .unwrap_or(false);
            if !seguir {
                return;
            }
        });
    match lanzado {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(error = %e, "no se pudo lanzar la limpieza de la caché del historial");
            false
        }
    }
}

/// Página del transcript `path` (subagente si `agent_id`). Sin fichero, la
/// página está vacía; con un cursor, el cursor ya no existe.
pub fn leer(
    path: Option<&Path>,
    agent_id: Option<&str>,
    antes_de: Option<&str>,
    limit: Option<usize>,
) -> Result<HistoryPage, String> {
    let Some(path) = path.filter(|p| p.is_file()) else {
        return match antes_de {
            Some(_) => Err(CURSOR_PERDIDO.to_string()),
            None => Ok(HistoryPage {
                messages: Vec::new(),
                has_more: false,
            }),
        };
    };
    let msgs = clave_de(path, agent_id)
        .and_then(|clave| {
            parseo_cacheado(
                cache_global(),
                clave,
                || transcript::parse_fichero(path, agent_id),
                lanzar_limpiador_global,
            )
        })
        .map_err(|e| format!("no se pudo leer el transcript: {e}"))?;
    paginar_ref(&msgs, antes_de, limite(limit), PRESUPUESTO_BYTES)
}

#[cfg(test)]
#[path = "tests_pagina.rs"]
mod tests;

#[cfg(test)]
mod tests_cache {
    use super::*;
    use std::cell::Cell;
    use std::io::Write;

    fn linea(uuid: &str, texto: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"2026-10-13T00:00:00Z","message":{{"role":"user","content":"{texto}"}}}}"#
        )
    }

    fn escribir(path: &Path, lineas: &[String]) {
        std::fs::write(path, lineas.join("\n") + "\n").expect("escribir");
    }

    fn contar<'a>(
        n: &'a Cell<usize>,
        path: &'a Path,
    ) -> impl FnOnce() -> io::Result<Vec<ChatMessage>> + 'a {
        move || {
            n.set(n.get() + 1);
            transcript::parse_fichero(path, None)
        }
    }

    #[test]
    fn dos_paginas_del_mismo_fichero_parsean_una_vez() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        escribir(&path, &[linea("a", "uno"), linea("b", "dos")]);
        let cache = Mutex::new(CacheParseo::default());
        let n = Cell::new(0);
        for _ in 0..2 {
            let clave = clave_de(&path, None).expect("clave");
            parseo_cacheado(&cache, clave, contar(&n, &path), || true).expect("parseo");
        }
        assert_eq!(n.get(), 1);
    }

    #[test]
    fn una_linea_nueva_invalida_la_cache() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        escribir(&path, &[linea("a", "uno")]);
        let cache = Mutex::new(CacheParseo::default());
        let n = Cell::new(0);
        let clave = clave_de(&path, None).expect("clave");
        parseo_cacheado(&cache, clave, contar(&n, &path), || true).expect("parseo");
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("abrir");
        writeln!(f, "{}", linea("b", "dos")).expect("añadir");
        drop(f);
        let clave = clave_de(&path, None).expect("clave");
        let msgs = parseo_cacheado(&cache, clave, contar(&n, &path), || true).expect("parseo");
        assert_eq!(n.get(), 2);
        assert!(msgs.iter().any(|m| m.uuid == "b"), "falta la línea nueva");
        let entradas = cache.lock().expect("cache").entradas.len();
        assert_eq!(entradas, 1, "la versión vieja no se soltó");
    }

    #[test]
    fn leer_incluye_lo_añadido_tras_una_pagina_cacheada() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        escribir(&path, &[linea("a", "uno")]);
        let p1 = leer(Some(&path), None, None, None).expect("página");
        escribir(&path, &[linea("a", "uno"), linea("b", "dos")]);
        let p2 = leer(Some(&path), None, None, None).expect("página");
        assert_eq!(p1.messages.len() + 1, p2.messages.len());
    }

    fn clave(nombre: &str, tamano: u64) -> Clave {
        Clave {
            ruta: PathBuf::from(nombre),
            agente: None,
            tamano,
            mtime: None,
        }
    }

    #[test]
    fn la_lru_conserva_solo_las_ultimas_entradas() {
        let mut c = CacheParseo::default();
        let t0 = Instant::now();
        for i in 0..(CACHE_ENTRADAS + 2) {
            c.guardar(clave(&format!("f{i}"), 1), Arc::new(Vec::new()), t0);
        }
        assert_eq!(c.entradas.len(), CACHE_ENTRADAS);
        assert_eq!(c.entradas[0].clave.ruta, PathBuf::from("f2"));
    }

    #[test]
    fn un_parseo_sin_uso_se_suelta_y_uno_reciente_no() {
        let mut c = CacheParseo::default();
        let t0 = Instant::now();
        c.guardar(clave("a", 1), Arc::new(Vec::new()), t0);
        let pronto = t0 + Duration::from_secs(10);
        assert!(
            c.tomar(&clave("a", 1), pronto).is_some(),
            "soltó uno reciente"
        );
        let tarde = pronto + CACHE_INACTIVIDAD + Duration::from_secs(1);
        assert!(
            c.tomar(&clave("a", 1), tarde).is_none(),
            "retuvo uno inactivo"
        );
        assert!(c.entradas.is_empty());
    }

    #[test]
    fn el_tope_de_bytes_no_guarda_un_transcript_enorme() {
        let mut c = CacheParseo::default();
        let t0 = Instant::now();
        c.guardar(
            clave("a", CACHE_TOPE_BYTES / 2 + 1),
            Arc::new(Vec::new()),
            t0,
        );
        c.guardar(
            clave("b", CACHE_TOPE_BYTES / 2 + 1),
            Arc::new(Vec::new()),
            t0,
        );
        assert_eq!(c.entradas.len(), 1, "dos parseos superan el tope juntos");
        assert_eq!(c.entradas[0].clave.ruta, PathBuf::from("b"));
        c.guardar(clave("c", CACHE_TOPE_BYTES + 1), Arc::new(Vec::new()), t0);
        assert!(c
            .entradas
            .iter()
            .all(|e| e.clave.ruta != std::path::Path::new("c")));
    }

    #[test]
    fn el_limpiador_se_lanza_una_vez_y_termina_al_vaciar() {
        let mut c = CacheParseo::default();
        let t0 = Instant::now();
        assert!(c.guardar(clave("a", 1), Arc::new(Vec::new()), t0));
        assert!(
            !c.guardar(clave("b", 1), Arc::new(Vec::new()), t0),
            "dos limpiadores"
        );
        assert!(
            c.paso_limpieza(t0 + Duration::from_secs(1)),
            "paró con entradas vivas"
        );
        let tarde = t0 + CACHE_INACTIVIDAD + Duration::from_secs(1);
        assert!(!c.paso_limpieza(tarde));
        assert!(c.entradas.is_empty());
        assert!(
            c.guardar(clave("c", 1), Arc::new(Vec::new()), tarde),
            "no relanza"
        );
    }

    #[test]
    fn sin_limpiador_no_se_retiene_el_parseo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.jsonl");
        escribir(&path, &[linea("a", "uno")]);
        let cache = Mutex::new(CacheParseo::default());
        let n = Cell::new(0);
        let clave = clave_de(&path, None).expect("clave");
        parseo_cacheado(&cache, clave, contar(&n, &path), || false).expect("parseo");
        let c = cache.lock().expect("cache");
        assert!(c.entradas.is_empty() && !c.limpiador);
    }
}
