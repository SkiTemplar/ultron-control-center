// Mascota — entregas del calendario de la uni (cero tokens).
//
// Un hilo («pupus-calendar») descarga el ICS como mucho cada 3 h (1 h tras
// un error) con caché HTTP (calendar_fetch.rs), se queda con las entregas
// de los próximos 60 días y las deja en .tmp/mascot-calendar.json. La
// webview pregunta `mascot_calendar_today` y Pupus lleva un calendario
// diminuto con la asignatura el día anterior y el mismo día. Solo avisa:
// nunca escribe texto académico.
//
// Qué es una entrega: palabras clave en el título o la descripción
// (entrega, vence, examen, due…), una tarea VTODO o una tarea calificable de
// Blackboard. La asignatura sale de cockpit/curso.json (código, nombre o
// palabras clave, course.rs) y, si no, de CATEGORIES o del título. Cada
// entrega con asignatura acaba además en su kanban (calendar_kanban.rs).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::calendar_fetch::{self as fetch, Cache, CachedItem, Download};
use super::course::{self, Subject};
use super::ics::{parse_ics, IcsItem};

const MIN_OK_MS: i64 = 3 * 3600 * 1000;
const MIN_ERR_MS: i64 = 3600 * 1000;
const HORIZON_DAYS: i64 = 60;
const FORCE_MIN: Duration = Duration::from_secs(5 * 60);
const WAKE: Duration = Duration::from_secs(15 * 60);
const FIRST_WAKE: Duration = Duration::from_secs(20);
const MAX_ITEMS: usize = 200;
/// UID de las tareas calificables en el feed de Blackboard.
const BLACKBOARD_GRADABLE: &str = "gradebook2.GradableItem";

const WORDS: &[&str] = &[
    "entrega",
    "entregas",
    "entregar",
    "vence",
    "due",
    "submission",
    "examen",
    "plazo",
    "deadline",
    "cierra",
];
const PHRASES: &[&str] = &[
    "fecha de entrega",
    "debe entregarse",
    "fecha limite",
    "se cierra",
];

static STARTED: AtomicBool = AtomicBool::new(false);
static FETCH_LOCK: Mutex<()> = Mutex::new(());
/// Serializa escribir la caché con cambiar la URL (sección corta).
static SAVE_LOCK: Mutex<()> = Mutex::new(());
static LAST_FORCED: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum When {
    Today,
    Tomorrow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueSoon {
    pub subject: String,
    pub title: String,
    pub due: String,
    pub all_day: bool,
    pub when: When,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarStatus {
    pub configured: bool,
    pub last_fetch: Option<String>,
    pub last_error: Option<String>,
    pub upcoming: u32,
}

// ---------------------------------------------------------------------------
// Reglas (puras)
// ---------------------------------------------------------------------------

/// Minúsculas y sin tildes.
pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            o => o,
        })
        .collect()
}

pub(super) fn has_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric())
        .any(|w| w == word)
}

pub fn is_delivery(item: &IcsItem) -> bool {
    // Una tarea calificable de Blackboard es una entrega aunque su título
    // no lo diga («Anteproyecto», «A1 - Pitch»).
    if item.todo || item.uid.contains(BLACKBOARD_GRADABLE) {
        return true;
    }
    let text = normalize(&format!("{} {}", item.summary, item.description_head));
    WORDS.iter().any(|w| has_word(&text, w)) || PHRASES.iter().any(|p| text.contains(p))
}

fn clip(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    format!(
        "{}…",
        t.chars().take(max - 1).collect::<String>().trim_end()
    )
}

/// Código de la asignatura (curso.json: UID, código, nombre o palabras
/// clave) o, si no, CATEGORIES o el título.
pub fn subject_for(item: &IcsItem, subjects: &[Subject]) -> String {
    let text = normalize(&format!(
        "{} {} {}",
        item.categories, item.summary, item.description_head
    ));
    if let Some(s) = course::find_item(subjects, &item.uid, &text) {
        return s.code.clone();
    }
    let cat = item.categories.split(',').next().unwrap_or("").trim();
    clip(if cat.is_empty() { &item.summary } else { cat }, 18)
}

/// ¿Hoy o mañana? None si ya pasó o faltan dos días o más.
pub fn due_window(now: DateTime<Local>, due: DateTime<Utc>) -> Option<When> {
    if due <= now.with_timezone(&Utc) {
        return None;
    }
    let day = due.with_timezone(&Local).date_naive();
    let today = now.date_naive();
    if day == today {
        Some(When::Today)
    } else if Some(day) == today.succ_opt() {
        Some(When::Tomorrow)
    } else {
        None
    }
}

/// Toca descargar: 3 h desde el último éxito y 1 h desde un error posterior.
pub fn should_fetch(last_ok: Option<i64>, last_err: Option<i64>, now: i64) -> bool {
    let ok_fresh = last_ok.is_some_and(|t| now - t < MIN_OK_MS);
    let err_fresh =
        last_err.is_some_and(|t| now - t < MIN_ERR_MS && last_ok.is_none_or(|ok| t >= ok));
    !(ok_fresh || err_fresh)
}

/// Entregas futuras dentro del horizonte, ordenadas por fecha.
pub fn upcoming(items: Vec<IcsItem>, subjects: &[Subject], now: DateTime<Utc>) -> Vec<CachedItem> {
    let limit = now + chrono::Duration::days(HORIZON_DAYS);
    let mut out: Vec<CachedItem> = items
        .into_iter()
        .filter(|i| i.due > now && i.due <= limit && is_delivery(i))
        .map(|i| CachedItem {
            subject: subject_for(&i, subjects),
            title: clip(&i.summary, 80),
            uid: i.uid,
            due: i.due,
            all_day: i.all_day,
        })
        .collect();
    out.sort_by_key(|i| i.due);
    out.truncate(MAX_ITEMS);
    out
}

// ---------------------------------------------------------------------------
// Descarga y estado
// ---------------------------------------------------------------------------

/// Guarda lo descargado de `fetched` solo si la URL configurada sigue siendo
/// esa: si cambió durante la descarga, lo derivado de la vieja no vale y se
/// descarta. Devuelve si se guardó. Pura salvo `save`, para los tests.
pub fn save_if_url_unchanged(
    fetched: &str,
    current: Option<String>,
    save: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if current.as_deref() != Some(fetched) {
        return Ok(false);
    }
    save().map(|_| true)
}

/// Guarda la caché de `url` bajo SAVE_LOCK (el mismo que toma
/// `mascot_calendar_set_url` al cambiar la URL y vaciar la caché).
fn commit(url: &str, cache: &Cache) -> Result<(), String> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if save_if_url_unchanged(url, fetch::read_url(), || fetch::save_cache(cache))? {
        Ok(())
    } else {
        Err("la URL del calendario cambió durante la descarga; se descarta".into())
    }
}

/// Descarga ya (serializado). Devuelve cuántas entregas próximas hay.
pub fn fetch_now() -> Result<usize, String> {
    let _guard = FETCH_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let url = fetch::read_url().ok_or("no hay URL del calendario configurada")?;
    let mut cache = fetch::load_cache();
    let now = Utc::now();
    let subjects = course::load();
    match fetch::download(&url, &cache) {
        Ok(Download::NotModified) => cache.items.retain(|i| i.due > now),
        Ok(Download::Body {
            text,
            etag,
            last_modified,
        }) => {
            cache.items = upcoming(parse_ics(&text), &subjects, now);
            cache.etag = etag;
            cache.last_modified = last_modified;
        }
        Err(e) => {
            cache.error_at_ms = Some(now.timestamp_millis());
            cache.last_error = Some(e.clone());
            let _ = commit(&url, &cache);
            return Err(e);
        }
    }
    cache.fetched_at_ms = Some(now.timestamp_millis());
    cache.last_error = None;
    commit(&url, &cache)?;
    sync_kanban(&cache.items, &subjects);
    Ok(cache.items.len())
}

/// Lleva al kanban las entregas que aún no tienen tarjeta (calendar_kanban.rs).
fn sync_kanban(items: &[CachedItem], subjects: &[Subject]) {
    match super::calendar_kanban::sync(items, subjects) {
        Ok(0) => {}
        Ok(n) => tracing::info!(n, "mascota: entregas nuevas llevadas al kanban"),
        Err(e) => tracing::warn!(error = %e, "mascota: entregas sin llevar al kanban"),
    }
}

fn status_of(cache: &Cache) -> CalendarStatus {
    let now = Utc::now();
    let stamp = |ms: Option<i64>| {
        ms.and_then(DateTime::from_timestamp_millis)
            .map(|d| d.to_rfc3339())
    };
    CalendarStatus {
        configured: fetch::read_url().is_some(),
        last_fetch: stamp(cache.fetched_at_ms),
        last_error: cache.last_error.clone(),
        upcoming: cache.items.iter().filter(|i| i.due > now).count() as u32,
    }
}

fn fetch_in_background() {
    let _ = std::thread::Builder::new()
        .name("pupus-calendar-fetch".into())
        .spawn(|| {
            if let Err(e) = fetch_now() {
                tracing::debug!(error = %e, "mascota: calendario no descargado");
            }
        });
}

/// ¿Descarga esta vuelta? Mascota activada, con ventana y el ajuste del
/// calendario encendido. Pura, para los tests.
pub fn calendar_active(s: &super::MascotSettings, has_window: bool) -> bool {
    super::watchers_active(s, has_window) && s.calendar
}

/// Hilo que despierta cada 15 min y descarga si toca. La primera vuelta
/// activa de cada arranque descarga siempre: el kanban sale al día al abrir
/// ULTRON aunque la última descarga tenga menos de 3 h.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("pupus-calendar".into())
        .spawn(move || {
            std::thread::sleep(FIRST_WAKE);
            let mut fetched_since_start = false;
            loop {
                let cache = fetch::load_cache();
                let due = !fetched_since_start
                    || should_fetch(
                        cache.fetched_at_ms,
                        cache.error_at_ms,
                        Utc::now().timestamp_millis(),
                    );
                let has_window = app.get_webview_window(super::LABEL).is_some();
                let active = calendar_active(&super::load_settings(), has_window);
                if due && active && fetch::read_url().is_some() {
                    fetched_since_start = true;
                    if let Err(e) = fetch_now() {
                        tracing::debug!(error = %e, "mascota: calendario no descargado");
                    }
                } else if active {
                    // Sin descarga: lo ya guardado, por si curso.json ganó
                    // asignaciones (UID o palabras clave) desde la última.
                    sync_kanban(&fetch::load_cache().items, &course::load());
                }
                std::thread::sleep(WAKE);
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "mascota: no arrancó el calendario");
    }
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

/// Entregas de hoy y de mañana (vacío con el ajuste apagado).
#[tauri::command]
pub async fn mascot_calendar_today() -> Vec<DueSoon> {
    if !super::load_settings().calendar {
        return Vec::new();
    }
    let now = Local::now();
    fetch::load_cache()
        .items
        .into_iter()
        .filter_map(|i| {
            let when = due_window(now, i.due)?;
            Some(DueSoon {
                subject: i.subject,
                title: i.title,
                due: i.due.to_rfc3339(),
                all_day: i.all_day,
                when,
            })
        })
        .collect()
}

/// Estado para Settings. Nunca incluye la URL ni su host.
#[tauri::command]
pub async fn mascot_calendar_status() -> CalendarStatus {
    status_of(&fetch::load_cache())
}

/// Guarda la URL en ~/.ultron/.env ("" = quitarla) y descarga en segundo plano.
#[tauri::command]
pub async fn mascot_calendar_set_url(url: String) -> Result<CalendarStatus, String> {
    let value = if url.trim().is_empty() {
        String::new()
    } else {
        fetch::validate_url(&url)?
    };
    {
        // SAVE_LOCK y no FETCH_LOCK: este comando no espera a una descarga
        // en curso (hasta 20 s); `commit` descarta lo que traiga de la URL
        // vieja.
        let _guard = SAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        fetch::write_url(&value)?;
        // Otra URL (u ninguna): lo derivado de la anterior ya no vale.
        fetch::save_cache(&Cache::default())?;
    }
    if !value.is_empty() {
        fetch_in_background();
    }
    Ok(status_of(&Cache::default()))
}

/// Comprobar ahora (como mucho una vez cada 5 min).
#[tauri::command]
pub async fn mascot_calendar_refresh() -> Result<CalendarStatus, String> {
    {
        let mut last = LAST_FORCED.lock().unwrap_or_else(|p| p.into_inner());
        if last.is_some_and(|t| t.elapsed() < FORCE_MIN) {
            return Err("Espera unos minutos antes de volver a comprobar el calendario.".into());
        }
        *last = Some(Instant::now());
    }
    let _ = tauri::async_runtime::spawn_blocking(fetch_now)
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?;
    Ok(status_of(&fetch::load_cache()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    const FIXTURE: &str = include_str!("fixtures/calendar/uni-anon.ics");

    fn subs() -> Vec<Subject> {
        vec![Subject::new("XYZ1", "Asignatura Inventada", &[])]
    }

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .earliest()
            .unwrap()
    }

    #[test]
    fn filtra_entregas_y_deja_fuera_las_clases() {
        let now = Utc.with_ymd_and_hms(2030, 3, 1, 0, 0, 0).unwrap();
        let items = upcoming(parse_ics(FIXTURE), &subs(), now);
        let uids: Vec<&str> = items.iter().map(|i| i.uid.as_str()).collect();
        assert_eq!(uids.len(), 4, "{uids:?}");
        assert!(
            !uids.contains(&"demo-005@example.invalid"),
            "clase de teoría"
        );
    }

    #[test]
    fn una_tarea_calificable_de_blackboard_es_entrega_aunque_el_titulo_no_lo_diga() {
        let item = |uid: &str, summary: &str| IcsItem {
            uid: uid.into(),
            summary: summary.into(),
            categories: String::new(),
            description_head: String::new(),
            due: Utc::now(),
            all_day: false,
            todo: false,
        };
        assert!(is_delivery(&item(
            "_blackboard.platform.gradebook2.GradableItem-_258020_1",
            "Anteproyecto"
        )));
        // Caso negativo: la clase de Blackboard (otro UID, sin palabra de entrega) no lo es.
        assert!(!is_delivery(&item(
            "_blackboard.platform.calendar.Event-_1_1",
            "2509_INSO3_DIPR_B_C: Dirección"
        )));
    }

    #[test]
    fn deduce_la_asignatura() {
        let items = parse_ics(FIXTURE);
        let get = |uid: &str| items.iter().find(|i| i.uid == uid).unwrap();
        assert_eq!(
            subject_for(get("demo-001@example.invalid"), &subs()),
            "XYZ1"
        );
        assert_eq!(
            subject_for(get("demo-002@example.invalid"), &subs()),
            "XYZ1",
            "por el nombre"
        );
        assert_eq!(
            subject_for(get("demo-004@example.invalid"), &subs()),
            "XYZ2 — Memoria fi…"
        );
        assert_eq!(
            subject_for(get("demo-001@example.invalid"), &[]),
            "XYZ1",
            "por CATEGORIES"
        );
    }

    #[test]
    fn hoy_y_manana_si_pasado_o_ya_vencido_no() {
        let now = local(2030, 3, 10, 12, 0);
        let at = |d: DateTime<Local>| d.with_timezone(&Utc);
        assert_eq!(
            due_window(now, at(local(2030, 3, 10, 18, 0))),
            Some(When::Today)
        );
        assert_eq!(
            due_window(now, at(local(2030, 3, 11, 23, 59))),
            Some(When::Tomorrow)
        );
        // Casos negativos: vencido hoy, ayer y dentro de dos días.
        assert_eq!(due_window(now, at(local(2030, 3, 10, 8, 0))), None);
        assert_eq!(due_window(now, at(local(2030, 3, 9, 18, 0))), None);
        assert_eq!(due_window(now, at(local(2030, 3, 12, 9, 0))), None);
    }

    #[test]
    fn respeta_los_intervalos_de_descarga() {
        let h = 3600 * 1000;
        assert!(should_fetch(None, None, 10 * h));
        assert!(!should_fetch(Some(9 * h), None, 10 * h), "éxito hace 1 h");
        assert!(should_fetch(Some(6 * h), None, 10 * h), "éxito hace 4 h");
        assert!(
            !should_fetch(Some(2 * h), Some(10 * h - h / 2), 10 * h),
            "error hace 30 min"
        );
        assert!(
            should_fetch(Some(2 * h), Some(8 * h), 10 * h),
            "error hace 2 h"
        );
    }

    #[test]
    fn sin_mascota_o_sin_ventana_no_se_descarga() {
        let on = super::super::MascotSettings {
            calendar: true,
            ..Default::default()
        };
        assert!(calendar_active(&on, true));
        // Casos negativos: mascota apagada, sin ventana o ajuste apagado.
        assert!(!calendar_active(
            &super::super::MascotSettings {
                enabled: false,
                ..on.clone()
            },
            true
        ));
        assert!(!calendar_active(&on, false));
        assert!(!calendar_active(
            &super::super::MascotSettings {
                calendar: false,
                ..on
            },
            true
        ));
    }

    #[test]
    fn lo_descargado_de_una_url_cambiada_se_descarta() {
        let a = "https://a.example.invalid/x.ics";
        let mut saved = 0;
        assert_eq!(
            save_if_url_unchanged(a, Some(a.into()), || {
                saved += 1;
                Ok(())
            }),
            Ok(true)
        );
        assert_eq!(saved, 1);
        // Casos negativos: la URL cambió o se quitó durante la descarga.
        let b = Some("https://b.example.invalid/y.ics".to_string());
        assert_eq!(
            save_if_url_unchanged(a, b, || {
                saved += 1;
                Ok(())
            }),
            Ok(false)
        );
        assert_eq!(
            save_if_url_unchanged(a, None, || {
                saved += 1;
                Ok(())
            }),
            Ok(false)
        );
        assert_eq!(saved, 1, "no se guarda nada de la URL vieja");
    }

    #[test]
    fn normaliza_tildes_y_palabras() {
        assert_eq!(normalize("Fecha LÍMITE"), "fecha limite");
        assert!(!has_word("duelo de titanes", "due"), "palabra entera");
    }
}
