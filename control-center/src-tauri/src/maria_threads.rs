// mar.ia — indice de conversaciones.
//
// El relevo (`maria_relay`) guarda los TURNOS en
// `<raiz>/cockpit/maria/threads/<id>.jsonl`. Aqui vive lo demas: titulo,
// carpeta, fijado, fecha y si la conversacion se dio por terminada. Va en un
// fichero aparte (`threads.json`) a proposito: los turnos son un log al que
// solo se anade, y reescribirlo entero para cambiar un titulo seria pedir una
// corrupcion.
//
// Por que existe: hasta ahora el chat abria un hilo por dia y cada pregunta
// parecia una conversacion suelta. El usuario pidio lo contrario (2026-09-18):
// "no quiero que cada pregunta se haga una conversacion, sino que el chat en
// si sea el comienzo de una conversacion hasta que termine", con fijado,
// agrupacion por fecha y carpeta y un mini titulo para distinguirlas.
//
// Limite declarado: el indice se reconcilia con los ficheros de turnos al
// leerlo, asi que un hilo creado a mano (o los `hilo-YYYYMMDD` de la version
// anterior) aparece igualmente, con titulo derivado de su primer mensaje.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Ficha de una conversacion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMeta {
    pub id: String,
    /// Mini titulo para distinguirla de un vistazo. Vacio = aun sin generar.
    #[serde(default)]
    pub title: String,
    /// Carpeta libre. Vacio = sin carpeta.
    #[serde(default)]
    pub folder: String,
    pub created: String,
    pub updated: String,
    #[serde(default)]
    pub pinned: bool,
    /// Proveedor fijado para esta conversacion. Vacio = decide el relevo.
    ///
    /// Vive en el HILO y no en la pantalla a proposito. Antes estaba en el
    /// estado de React y se perdia al recargar, al abrir otra pestaña o al
    /// entrar desde el movil: el usuario decia "respondeme con Codex", Codex
    /// preguntaba "¿que quieres que haga?", y el mensaje siguiente volvia al
    /// modelo general (reportado el 2026-09-21).
    #[serde(default)]
    pub provider: String,
    /// Conversacion cerrada: sigue consultable, pero el chat abre una nueva.
    #[serde(default)]
    pub closed: bool,
    /// Turnos que tiene. Se calcula al listar (no se persiste): asi nunca
    /// miente aunque alguien borre el jsonl a mano.
    #[serde(default, skip_deserializing)]
    pub turns: usize,
}

impl ThreadMeta {
    fn nueva(id: String, folder: String) -> Self {
        let ahora = chrono::Utc::now().to_rfc3339();
        Self {
            id,
            title: String::new(),
            folder,
            created: ahora.clone(),
            updated: ahora,
            pinned: false,
            provider: String::new(),
            closed: false,
            turns: 0,
        }
    }
}

fn maria_dir() -> Result<PathBuf, String> {
    let dir = crate::maria_paths::cockpit("maria")?;
    std::fs::create_dir_all(dir.join("threads")).map_err(|e| format!("crear carpeta: {e}"))?;
    Ok(dir)
}

fn index_path() -> Result<PathBuf, String> {
    Ok(maria_dir()?.join("threads.json"))
}

fn load_raw() -> Vec<ThreadMeta> {
    index_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<ThreadMeta>>(&t).ok())
        .unwrap_or_default()
}

fn save_raw(lista: &[ThreadMeta]) -> Result<(), String> {
    let path = index_path()?;
    let text = serde_json::to_string_pretty(lista).map_err(|e| format!("serializar: {e}"))?;
    // tmp+rename: un corte a mitad de escritura no deja el indice a medias
    // (mismo patron que el resto del cockpit).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("escribir indice: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("renombrar indice: {e}"))
}

/// Ids de hilo que tienen fichero de turnos en disco.
fn ids_en_disco() -> Vec<String> {
    let Ok(dir) = maria_dir() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(dir.join("threads")) else {
        return Vec::new();
    };
    rd.filter_map(Result::ok)
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            p.file_stem().and_then(|s| s.to_str()).map(str::to_string)
        })
        .collect()
}

/// Ordena: fijadas primero, y dentro de cada grupo la mas reciente arriba.
fn ordenar(lista: &mut [ThreadMeta]) {
    lista.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated.cmp(&a.updated))
    });
}

/// Todas las conversaciones, reconciliadas con lo que hay en disco.
pub fn list() -> Vec<ThreadMeta> {
    let mut lista = load_raw();
    let mut nuevos = false;
    for id in ids_en_disco() {
        if lista.iter().any(|t| t.id == id) {
            continue;
        }
        // Hilo sin ficha: de la version anterior o creado a mano.
        let mut m = ThreadMeta::nueva(id.clone(), String::new());
        if let Ok(turnos) = crate::maria_relay::read_thread(&id) {
            if let Some(primero) = turnos.first() {
                m.created = primero.ts.clone();
            }
            if let Some(ultimo) = turnos.last() {
                m.updated = ultimo.ts.clone();
            }
        }
        lista.push(m);
        nuevos = true;
    }
    if nuevos {
        let _ = save_raw(&lista);
    }
    for m in &mut lista {
        m.turns = crate::maria_relay::read_thread(&m.id)
            .map(|t| t.len())
            .unwrap_or(0);
        if m.title.trim().is_empty() {
            m.title = titulo_de_respaldo(&m.id);
        }
    }
    ordenar(&mut lista);
    lista
}

/// Titulo derivado del primer mensaje del usuario. Se usa mientras el modelo
/// local no haya generado uno mejor — nunca se deja la lista con filas sin
/// nombre, que es justo lo que el usuario no podia distinguir.
fn titulo_de_respaldo(id: &str) -> String {
    let Ok(turnos) = crate::maria_relay::read_thread(id) else {
        return "conversación".into();
    };
    match turnos.iter().find(|t| t.role == "user") {
        Some(primero) => resumen_corto(&primero.text),
        None => "conversación nueva".into(),
    }
}

/// Recorta un texto a un titulo de una linea. Pura: se testea sin ficheros.
#[must_use]
pub fn resumen_corto(texto: &str) -> String {
    let unido = texto.split_whitespace().collect::<Vec<_>>().join(" ");
    let limpio = unido.trim_start_matches('/').trim();
    if limpio.is_empty() {
        return "conversación nueva".into();
    }
    if limpio.chars().count() <= 48 {
        return limpio.to_string();
    }
    let corto: String = limpio.chars().take(46).collect();
    // Se corta por la ultima palabra entera para no dejar una a medias.
    match corto.rsplit_once(' ') {
        Some((antes, _)) if antes.chars().count() >= 20 => format!("{antes}…"),
        _ => format!("{corto}…"),
    }
}

fn con_ficha<F, T>(id: &str, f: F) -> Result<T, String>
where
    F: FnOnce(&mut ThreadMeta) -> T,
{
    let mut lista = load_raw();
    if !lista.iter().any(|t| t.id == id) {
        lista.push(ThreadMeta::nueva(id.to_string(), String::new()));
    }
    let ficha = lista
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("hilo no encontrado")?;
    let out = f(ficha);
    save_raw(&lista)?;
    Ok(out)
}

/// Marca actividad en el hilo (lo llama el relevo tras cada respuesta).
pub fn touch(id: &str) {
    let _ = con_ficha(id, |m| {
        m.updated = chrono::Utc::now().to_rfc3339();
    });
}

/// Crea una conversacion nueva. El id lleva la fecha por delante para que
/// ordene bien en el explorador de ficheros, y la hora para que dos
/// conversaciones del mismo dia no choquen.
pub fn create(folder: Option<String>) -> Result<ThreadMeta, String> {
    let ahora = chrono::Local::now();
    let id = format!("hilo-{}", ahora.format("%Y%m%d-%H%M%S"));
    let mut lista = load_raw();
    if lista.iter().any(|t| t.id == id) {
        return Err("ya existe una conversacion con ese id".into());
    }
    let meta = ThreadMeta::nueva(id, folder.unwrap_or_default());
    lista.push(meta.clone());
    save_raw(&lista)?;
    Ok(meta)
}

/// Genera el mini titulo con el modelo local a partir de los primeros turnos.
///
/// Se hace con el local a proposito: titular una conversacion no vale una
/// peticion de Claude. Si el modelo no esta o contesta cualquier cosa, se
/// queda el titulo de respaldo — nunca falla la operacion por esto.
pub fn autotitulo(id: &str) -> String {
    // Cuenta como turno: el vigilante de la VRAM no puede descargar el modelo
    // en mitad de esto, y al salir se descarga solo.
    let _en_uso = crate::maria_local::EnUso::nuevo();
    let respaldo = titulo_de_respaldo(id);
    let Ok(turnos) = crate::maria_relay::read_thread(id) else {
        return respaldo;
    };
    if turnos.is_empty() {
        return respaldo;
    }
    let muestra: String = turnos
        .iter()
        .take(4)
        .map(|t| format!("{}: {}\n", t.role, resumen_largo(&t.text)))
        .collect();
    let instruccion = format!(
        "Pon un titulo de 3 a 5 palabras a esta conversacion. Responde SOLO \
         con el titulo, en español, sin comillas ni punto final.\n\n{muestra}"
    );
    let body = serde_json::json!({
        "model": crate::ollama::toggle::model_name(),
        "stream": false,
        "think": false,
        // 0: titular no deja el modelo ocupando VRAM detras.
        "keep_alive": "0",
        "messages": [{ "role": "user", "content": instruccion }],
        "options": { "num_ctx": 2048, "num_predict": 24, "temperature": 0.2 },
    });
    let crudo = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .ok()
        .and_then(|c| {
            c.post("http://127.0.0.1:11434/api/chat")
                .json(&body)
                .send()
                .ok()
        })
        .and_then(|r| r.json::<serde_json::Value>().ok())
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(str::to_string)
        });
    match crudo.map(|t| limpia_titulo(&t)) {
        Some(t) if !t.is_empty() => t,
        _ => respaldo,
    }
}

/// ¿Le falta titulo de verdad a esta conversacion?
///
/// "De verdad" = el campo `title` esta vacio en disco. Lo que se ve en la
/// lista cuando esta vacio es el PRIMER MENSAJE recortado, que se lee pero no
/// es un resumen: cuatro conversaciones que empiezan parecido salen con cuatro
/// filas iguales. El usuario lo pidio el 2026-09-20: "que las conversaciones
/// tengan un titulo (resumen) legible".
#[must_use]
pub fn necesita_titulo(id: &str) -> bool {
    let sin_titulo = load_raw()
        .iter()
        .find(|t| t.id == id)
        .map(|t| t.title.trim().is_empty())
        .unwrap_or(true);
    if !sin_titulo {
        return false;
    }
    // Con un solo turno no hay nada que resumir todavia.
    crate::maria_relay::read_thread(id).map(|t| t.len() >= 2).unwrap_or(false)
}

/// Titula una conversacion si le hace falta. Devuelve el titulo puesto.
///
/// Se llama al terminar cada turno del relevo, asi que cubre TODAS las vias:
/// el chat, la voz, el movil y el autocompletado. Antes solo titulaba la
/// pantalla de chat y el resto se quedaba sin resumen.
pub fn titular_si_hace_falta(id: &str) -> Option<String> {
    if !necesita_titulo(id) {
        return None;
    }
    let titulo = autotitulo(id);
    if titulo.trim().is_empty() {
        return None;
    }
    let valor = titulo.clone();
    let _ = con_ficha(id, move |m| m.title = valor);
    Some(titulo)
}

/// Pasa por las conversaciones viejas que se quedaron sin titulo.
///
/// Se lanza al arrancar, en su propio hilo y de una en una: titular carga el
/// modelo local, y hacerlo en paralelo con seis conversaciones seria meter
/// seis veces el modelo en VRAM.
pub fn titular_pendientes(tope: usize) {
    let ids: Vec<String> = load_raw()
        .into_iter()
        .filter(|t| t.title.trim().is_empty())
        .map(|t| t.id)
        .take(tope)
        .collect();
    if ids.is_empty() {
        return;
    }
    tracing::info!(cuantas = ids.len(), "titulando conversaciones sin nombre");
    for id in ids {
        if let Some(t) = titular_si_hace_falta(&id) {
            tracing::debug!(hilo = %id, titulo = %t, "titulada");
        }
    }
}

/// Deja el titulo que devuelve el modelo en una linea presentable.
/// Pura: se testea sin red.
#[must_use]
pub fn limpia_titulo(crudo: &str) -> String {
    let primera = crudo
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let limpio = primera
        .trim_matches(|c: char| {
            c == '"' || c == '\'' || c == '\u{ab}' || c == '\u{bb}' || c == '.'
        })
        .trim();
    // Un modelo despistado contesta con un parrafo: eso no es un titulo.
    if limpio.is_empty() || limpio.chars().count() > 60 {
        return String::new();
    }
    resumen_corto(limpio)
}

fn resumen_largo(texto: &str) -> String {
    let limpio = texto.split_whitespace().collect::<Vec<_>>().join(" ");
    if limpio.chars().count() <= 240 {
        return limpio;
    }
    limpio.chars().take(240).collect()
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn maria_threads_list() -> Result<Vec<ThreadMeta>, String> {
    Ok(list())
}

#[tauri::command]
pub async fn maria_thread_create(folder: Option<String>) -> Result<ThreadMeta, String> {
    create(folder)
}

#[tauri::command]
pub async fn maria_thread_pin(thread_id: String, pinned: bool) -> Result<(), String> {
    con_ficha(&thread_id, |m| m.pinned = pinned)
}

#[tauri::command]
pub async fn maria_thread_rename(thread_id: String, title: String) -> Result<String, String> {
    let limpio = resumen_corto(&title);
    let valor = limpio.clone();
    con_ficha(&thread_id, move |m| m.title = valor)?;
    Ok(limpio)
}

#[tauri::command]
pub async fn maria_thread_folder(thread_id: String, folder: String) -> Result<(), String> {
    let limpio = folder.trim().to_string();
    con_ficha(&thread_id, move |m| m.folder = limpio)
}

/// Cierra la conversacion y le pone titulo con el modelo local.
#[tauri::command]
pub async fn maria_thread_close(thread_id: String) -> Result<ThreadMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let titulo = autotitulo(&thread_id);
        con_ficha(&thread_id, move |m| {
            m.closed = true;
            m.title = titulo;
            m.updated = chrono::Utc::now().to_rfc3339();
            m.clone()
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Titula la conversacion sin cerrarla (lo llama el chat tras el primer
/// intercambio, para que la lista no quede con filas iguales).
#[tauri::command]
pub async fn maria_thread_autotitle(thread_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let titulo = autotitulo(&thread_id);
        let valor = titulo.clone();
        con_ficha(&thread_id, move |m| m.title = valor)?;
        Ok(titulo)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Fija el proveedor de una conversacion desde dentro de Rust (sincrono).
pub fn fijar_provider(thread_id: &str, provider: &str) -> Result<(), String> {
    let valor = provider.trim().to_string();
    con_ficha(thread_id, move |m| m.provider = valor)
}

/// El proveedor fijado de una conversacion, si lo tiene.
#[must_use]
pub fn provider_de(thread_id: &str) -> String {
    load_raw()
        .iter()
        .find(|t| t.id == thread_id)
        .map(|t| t.provider.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn maria_thread_delete(thread_id: String) -> Result<(), String> {
    let mut lista = load_raw();
    lista.retain(|t| t.id != thread_id);
    save_raw(&lista)?;
    // El fichero de turnos se borra tambien: dejarlo haria que `list()` lo
    // readoptara en la siguiente lectura y la conversacion "volveria".
    if let Ok(dir) = maria_dir() {
        let f = dir.join("threads").join(format!("{thread_id}.jsonl"));
        if f.exists() {
            std::fs::remove_file(&f).map_err(|e| format!("borrar turnos: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_titulo_corto_cabe_en_una_linea() {
        assert_eq!(resumen_corto("arregla el login"), "arregla el login");
        assert_eq!(
            resumen_corto("  varias\n  lineas   con   espacios "),
            "varias lineas con espacios"
        );
    }

    #[test]
    fn el_titulo_largo_se_corta_por_palabra_entera() {
        let largo = "necesito que revises la configuracion del router y me digas que falla";
        let t = resumen_corto(largo);
        assert!(t.chars().count() <= 49, "demasiado largo: {t}");
        assert!(t.ends_with('…'));
        assert!(!t.contains("  "));
    }

    #[test]
    fn un_mensaje_vacio_no_deja_la_fila_sin_nombre() {
        // Caso negativo: sin esto la lista mostraba filas en blanco, que es lo
        // que el usuario no podia distinguir.
        assert_eq!(resumen_corto("   "), "conversación nueva");
        assert_eq!(resumen_corto("/"), "conversación nueva");
    }

    #[test]
    fn limpia_el_titulo_que_devuelve_el_modelo() {
        assert_eq!(limpia_titulo("\"Ajustes del router\""), "Ajustes del router");
        assert_eq!(limpia_titulo("Ajustes del router.\n"), "Ajustes del router");
        assert_eq!(limpia_titulo("\u{ab}Memoria y recall\u{bb}"), "Memoria y recall");
    }

    #[test]
    fn rechaza_un_parrafo_disfrazado_de_titulo() {
        // Caso negativo: el modelo a veces explica en vez de titular. Eso no
        // puede acabar en la lista, asi que se devuelve vacio y manda el
        // titulo de respaldo.
        let parrafo = "Claro, creo que un buen titulo para esta conversacion \
                       podria ser algo relacionado con la configuracion";
        assert_eq!(limpia_titulo(parrafo), "");
        assert_eq!(limpia_titulo(""), "");
        assert_eq!(limpia_titulo("   \n  "), "");
    }

    #[test]
    fn las_fijadas_van_primero_y_luego_las_recientes() {
        let mut lista = vec![
            ThreadMeta {
                updated: "2026-09-18T10:00:00Z".into(),
                ..ThreadMeta::nueva("a".into(), String::new())
            },
            ThreadMeta {
                updated: "2026-09-18T12:00:00Z".into(),
                ..ThreadMeta::nueva("b".into(), String::new())
            },
            ThreadMeta {
                pinned: true,
                updated: "2026-09-01T09:00:00Z".into(),
                ..ThreadMeta::nueva("c".into(), String::new())
            },
        ];
        ordenar(&mut lista);
        let ids: Vec<&str> = lista.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "b", "a"], "orden incorrecto");
    }
}
