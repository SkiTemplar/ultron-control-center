// sesiones/ventana.rs — Ventanas «ULTRON Sessions» (label `sesiones` y
// adicionales `sesiones-<uuid8>`).
//
// Mismo patrón que `detach.rs`: si existe se muestra y enfoca; si no, se crea
// con la página de app `sesiones.html`. Cerrarla no mata las sesiones ni
// cancela sus preguntas: los PTY y el `Broker` viven en el backend y al
// reabrir se reengancha con `sesiones_list` y `sesiones_pending_asks`
// (estado-cola:M2).
//
// Cada ventana lleva su icono y su AppUserModelID (`ventana_icono.rs`) para
// que Windows le dé un botón propio en la barra de tareas, y un manejador de
// permisos de WebView2 que concede el micrófono solo al origen de la app
// (motores-ventanas:F6) y otro de `ProcessFailed` que recarga la página si
// cae su renderer (estabilidad nocturna, hallazgo 1). El esquema `preview` sirve el HTML de las vistas
// previas semiinteractivas con su propia CSP (R16, motores-ventanas:F13).

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::ajustes::valid_project_id;
use super::comandos_pty;
use super::registro::{self, WINDOW_LABEL};
use super::types::ev;
use super::ventana_icono;

/// Argumento del acceso directo «ULTRON Sessions» del escritorio: abre la
/// ventana de Sessions (en la copia viva si ya hay una, vía single-instance).
pub const LAUNCH_ARG: &str = "--sesiones";

// ---------------------------------------------------------------------------
// Vistas previas HTML (`preview`)
// ---------------------------------------------------------------------------

const PREVIEW_SCHEME: &str = "preview";
const PREVIEW_MAX_DOCS: usize = 32;
const PREVIEW_MAX_BYTES: usize = 2 * 1024 * 1024;
/// CSP del documento servido: scripts en línea sí, red y navegación no. El
/// iframe que lo carga lleva `sandbox="allow-scripts"` sin `allow-same-origin`.
pub const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; \
style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; \
connect-src 'none'; form-action 'none'; base-uri 'none'";

type Previews = Mutex<VecDeque<(String, String)>>;

fn previews() -> &'static Previews {
    static P: OnceLock<Previews> = OnceLock::new();
    P.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// Guarda el HTML y devuelve su id (se conservan los `PREVIEW_MAX_DOCS` últimos).
pub fn preview_put(html: String) -> Result<String, String> {
    if html.len() > PREVIEW_MAX_BYTES {
        return Err(format!(
            "la vista previa supera {} MB",
            PREVIEW_MAX_BYTES / 1024 / 1024
        ));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut docs = previews()
        .lock()
        .map_err(|_| "almacén de vistas previas envenenado".to_string())?;
    docs.push_back((id.clone(), html));
    while docs.len() > PREVIEW_MAX_DOCS {
        docs.pop_front();
    }
    Ok(id)
}

/// URL con la que WebView2 pide el documento: en Windows los esquemas propios
/// se sirven como `http://<esquema>.localhost/`.
pub fn preview_url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://{PREVIEW_SCHEME}.localhost/{id}")
    } else {
        format!("{PREVIEW_SCHEME}://localhost/{id}")
    }
}

/// Respuesta del esquema para la ruta pedida: `(estado, cuerpo)`.
pub fn preview_response(path: &str) -> (u16, String) {
    let id = path.trim_start_matches('/');
    let found = previews()
        .lock()
        .ok()
        .and_then(|d| d.iter().find(|(k, _)| k == id).map(|(_, v)| v.clone()));
    match found {
        Some(html) => (200, html),
        None => (404, "vista previa caducada".to_string()),
    }
}

fn vaciar_previews() {
    if let Ok(mut d) = previews().lock() {
        d.clear();
    }
}

/// Registra el esquema `preview` en el builder de la app (firma congelada en
/// la fase 0a; lo llama `lib.rs`).
pub fn registrar_protocolos<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_uri_scheme_protocol(PREVIEW_SCHEME, |_ctx, request| {
        let (status, body) = preview_response(request.uri().path());
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", PREVIEW_CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(body.into_bytes())
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "respuesta de vista previa no válida");
                tauri::http::Response::new(Vec::new())
            })
    })
}

/// `sesiones_preview_put`: publica un HTML y devuelve su URL.
#[tauri::command]
pub async fn sesiones_preview_put(html: String) -> Result<String, String> {
    preview_put(html).map(|id| preview_url(&id))
}

// ---------------------------------------------------------------------------
// Permisos de WebView2
// ---------------------------------------------------------------------------

/// Permiso que pide la página.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permiso {
    Microfono,
    Otro,
}

const APP_ORIGINS: &[&str] = &["http://tauri.localhost", "https://tauri.localhost"];

/// `esquema://host` de una URI, en minúsculas (sin puerto ni ruta).
fn origin_of(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(format!("{scheme}://{}", &rest[..end]).to_ascii_lowercase())
}

/// true si `uri` pertenece a la propia app.
pub fn es_origen_de_app(uri: &str) -> bool {
    origin_of(uri).is_some_and(|o| APP_ORIGINS.contains(&o.as_str()))
}

/// Se concede solo el micrófono y solo al origen de la propia app.
pub fn allow_permission(uri: &str, permiso: Permiso) -> bool {
    permiso == Permiso::Microfono && es_origen_de_app(uri)
}

#[cfg(windows)]
fn registrar_permisos(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    // SAFETY: llamadas COM sobre interfaces vivas, en el hilo de la UI.
    let core = unsafe { controller.CoreWebView2()? };
    let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        let mut uri = PWSTR::null();
        // SAFETY: `args` es válido durante el evento; `uri` lo libera `take_pwstr`.
        unsafe {
            args.PermissionKind(&mut kind)?;
            args.Uri(&mut uri)?;
        }
        let permiso = if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
            Permiso::Microfono
        } else {
            Permiso::Otro
        };
        if allow_permission(&take_pwstr(uri), permiso) {
            // SAFETY: idem.
            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: `handler` y `token` viven durante la llamada.
    unsafe { core.add_PermissionRequested(&handler, &mut token) }
}

/// Solo el permiso de micrófono (mismo criterio que Sessions: origen de la
/// app), sin el vigilante de caídas de Sessions. Lo usa la mascota para el
/// dictado de su chat (src-tauri/src/mascot/mod.rs).
pub fn conceder_microfono(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let r = window.with_webview(|wv| {
            if let Err(e) = registrar_permisos(&wv.controller()) {
                tracing::warn!(error = %e, "sin manejador de permisos de WebView2");
            }
        });
        if let Err(e) = r {
            tracing::warn!(error = %e, label = window.label(), "no se pudo acceder al WebView2");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

fn permitir_microfono(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        let r = window.with_webview(move |wv| {
            if let Err(e) = registrar_permisos(&wv.controller()) {
                tracing::warn!(error = %e, "sin manejador de permisos de WebView2");
            }
            if let Err(e) = registrar_caidas(&wv.controller(), label) {
                tracing::warn!(error = %e, "sin manejador de caídas de WebView2");
            }
            if let Err(e) = super::ruta_fichero::registrar(&wv.controller()) {
                tracing::warn!(error = %e, "sin manejador de rutas de fichero de WebView2");
            }
        });
        if let Err(e) = r {
            tracing::warn!(error = %e, "no se pudo acceder al WebView2 de Sessions");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

// ---------------------------------------------------------------------------
// Caídas del renderer (`ProcessFailed`)
// ---------------------------------------------------------------------------

/// Qué hacer ante un `ProcessFailed` de WebView2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccionCaida {
    /// El renderer de la página murió (ventana en blanco): se recarga y el
    /// `bootstrap` del frontend repone el estado desde el backend.
    Recargar,
    /// Solo se anota: el proceso del navegador (el WebView ya no sirve y
    /// `Reload` no lo revive), un renderer que no responde (puede volver), un
    /// iframe (vistas previas) o procesos auxiliares que WebView2 relanza.
    Anotar,
}

/// `COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED`.
const KIND_RENDER_EXITED: i32 = 1;

pub fn accion_por_caida(kind: i32) -> AccionCaida {
    if kind == KIND_RENDER_EXITED {
        AccionCaida::Recargar
    } else {
        AccionCaida::Anotar
    }
}

/// Recargas permitidas por ventana deslizante: un renderer que cae al cargar
/// (memoria agotada) no puede entrar en un bucle de recargas toda la noche.
const MAX_RECARGAS: usize = 3;
const VENTANA_RECARGAS: Duration = Duration::from_secs(600);

/// Registra la recarga en `historial` si cabe en la ventana; false si no.
pub fn admitir_recarga(historial: &mut VecDeque<Instant>, ahora: Instant) -> bool {
    while historial
        .front()
        .is_some_and(|t| ahora.saturating_duration_since(*t) >= VENTANA_RECARGAS)
    {
        historial.pop_front();
    }
    if historial.len() >= MAX_RECARGAS {
        return false;
    }
    historial.push_back(ahora);
    true
}

#[cfg(windows)]
fn registrar_caidas(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    label: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
    use webview2_com::ProcessFailedEventHandler;

    // SAFETY: llamadas COM sobre interfaces vivas, en el hilo de la UI.
    let core = unsafe { controller.CoreWebView2()? };
    let historial = Mutex::new(VecDeque::new());
    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        if let Some(args) = args {
            // SAFETY: `args` es válido durante el evento.
            unsafe { args.ProcessFailedKind(&mut kind)? };
        }
        if accion_por_caida(kind.0) == AccionCaida::Anotar {
            tracing::warn!(ventana = %label, kind = kind.0, "WebView2: ha fallado un proceso");
            return Ok(());
        }
        let admitida = historial
            .lock()
            .map(|mut h| admitir_recarga(&mut h, Instant::now()))
            .unwrap_or(false);
        let Some(core) = sender.filter(|_| admitida) else {
            tracing::error!(ventana = %label, "WebView2: renderer caído; sin recarga (límite de recargas)");
            return Ok(());
        };
        tracing::error!(ventana = %label, "WebView2: renderer caído; se recarga la página");
        // SAFETY: `core` es el emisor del evento, vivo durante la llamada.
        unsafe { core.Reload() }
    }));
    let mut token = 0i64;
    // SAFETY: `handler` y `token` viven durante la llamada.
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

// ---------------------------------------------------------------------------
// Apertura de ventanas
// ---------------------------------------------------------------------------

pub fn open(app: &AppHandle, project_id: Option<String>) -> Result<(), String> {
    let project_id = project_id.filter(|p| !p.is_empty());
    if let Some(p) = &project_id {
        if !valid_project_id(p) {
            return Err(format!("id de proyecto no válido: '{p}'"));
        }
    }
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        w.show()
            .map_err(|e| format!("no se pudo mostrar la ventana: {e}"))?;
        w.unminimize()
            .map_err(|e| format!("no se pudo restaurar la ventana: {e}"))?;
        w.set_focus()
            .map_err(|e| format!("no se pudo enfocar la ventana: {e}"))?;
        if let Some(p) = project_id {
            app.emit_to(WINDOW_LABEL, ev::FOCUS_PROJECT, json!({ "projectId": p }))
                .map_err(|e| format!("no se pudo enviar el foco de proyecto: {e}"))?;
        }
        return Ok(());
    }
    // Recién creada, la ventana aún no escucha eventos: el proyecto viaja
    // también en la URL (`?project=<id>`).
    let url = match &project_id {
        Some(p) => format!("sesiones.html?project={p}"),
        None => "sesiones.html".to_string(),
    };
    let look = ventana_icono::Aspecto::principal();
    build(app, WINDOW_LABEL, url, look)
}

/// Abre (o enfoca) la ventana principal y le pide una sesión nueva de Claude
/// en `cwd`, ya validada (`abrir_carpeta::validar_carpeta`). Ventana abierta:
/// evento `NEW_IN_CWD`; recién creada: `?cwd=<ruta>`, que el frontend consume
/// y quita de la URL para que una recarga no repita la sesión.
pub fn open_in_cwd(app: &AppHandle, cwd: &str) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        open(app, None)?;
        return app
            .emit_to(WINDOW_LABEL, ev::NEW_IN_CWD, json!({ "cwd": cwd }))
            .map_err(|e| format!("no se pudo pedir la sesión nueva: {e}"));
    }
    let url = format!(
        "sesiones.html?cwd={}",
        super::abrir_carpeta::codificar_url(cwd)
    );
    build(app, WINDOW_LABEL, url, ventana_icono::Aspecto::principal())
}

/// Abre la ventana principal con una sesión en el panel con foco
/// (`?session=<id>`, `showInitial` en bootstrap.ts). Si ya existe, error:
/// el llamante la enfoca por evento (foco_sesion.rs).
pub fn open_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Err("la ventana de Sessions ya está abierta".into());
    }
    let url = format!("sesiones.html?session={session_id}");
    build(app, WINDOW_LABEL, url, ventana_icono::Aspecto::principal())
}

/// Abre una ventana adicional de Sessions, opcionalmente con una sesión: su
/// título es el de la sesión y su icono, la inicial del proyecto.
pub fn open_extra(app: &AppHandle, session_id: Option<String>) -> Result<String, String> {
    let session_id = session_id.filter(|s| !s.is_empty());
    let info = match &session_id {
        Some(s) => Some(
            registro::read(s, |se| {
                (se.info.title.clone(), se.info.project_name.clone())
            })
            .map_err(|_| format!("sesión desconocida: {s}"))?,
        ),
        None => None,
    };
    let label = format!(
        "{WINDOW_LABEL}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let mut url = format!("sesiones.html?win={label}");
    if let Some(s) = &session_id {
        url.push_str(&format!("&session={s}"));
    }
    let look = match &info {
        Some((title, project)) => ventana_icono::Aspecto::de_sesion(&label, title, project),
        None => ventana_icono::Aspecto::extra(&label),
    };
    build(app, &label, url, look)?;
    Ok(label)
}

fn build(
    app: &AppHandle,
    label: &str,
    url: String,
    look: ventana_icono::Aspecto,
) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(&look.titulo)
        .inner_size(1400.0, 900.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .decorations(true)
        .skip_taskbar(false)
        .center()
        // Se muestra tras fijar icono y AppUserModelID (botón propio).
        .visible(false)
        // Sin esto WebView2 entrega el arrastre a Tauri y el `drop` de HTML
        // nunca llega (la ventana principal lo fija en el conf).
        .disable_drag_drop_handler()
        .on_page_load(|w, p| al_cargar_pagina(w.app_handle(), w.label(), p.event()))
        .build()
        .map_err(|e| format!("no se pudo crear la ventana de ULTRON Sessions: {e}"))?;
    permitir_microfono(&window);
    ventana_icono::decorar_y_mostrar(app, &window, look);
    let app2 = app.clone();
    let own = label.to_string();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        super::barra_lateral::olvidar(&own);
        let quedan = quedan_otras(&app2, &own);
        // Fuera del hilo de eventos: soltar terminales redimensiona PTY (`SC-08`).
        std::thread::spawn(move || al_cerrar_ventana(quedan));
    });
    Ok(())
}

/// true si hay otra ventana de Sessions abierta además de `own`.
fn quedan_otras(app: &AppHandle, own: &str) -> bool {
    app.webview_windows()
        .keys()
        .any(|l| l != own && registro::is_sessions_window(l))
}

/// Al empezar a cargar (o recargar) la página de la única ventana de
/// Sessions, ninguna vista de menú sigue viva: el cleanup de React no corre
/// al recargar, así que las terminales enganchadas se sueltan aquí. Con
/// otras ventanas abiertas no se toca nada (pueden tener su menú abierto).
fn al_cargar_pagina(app: &AppHandle, own: &str, evento: PageLoadEvent) {
    if evento != PageLoadEvent::Started || quedan_otras(app, own) {
        return;
    }
    std::thread::spawn(comandos_pty::soltar_terminales);
}

/// Efectos de cerrar una ventana de Sessions. Las preguntas pendientes no se
/// tocan (siguen en el `Broker` y otra ventana las recupera); al cerrar la
/// última se sueltan las vistas previas y las terminales del bloque de menú
/// que sigan enganchadas (su cola estaría en pausa y su PTY, pequeño).
fn al_cerrar_ventana(quedan_otras: bool) {
    if !quedan_otras {
        vaciar_previews();
        comandos_pty::soltar_terminales();
    }
}

#[cfg(test)]
#[path = "tests_ventana.rs"]
mod tests;
