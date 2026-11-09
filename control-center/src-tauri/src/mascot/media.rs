// Mascota — ¿suena música? Para que Pupus baile (activities/music.ts).
//
// Se mira la sesión multimedia actual de Windows (System Media Transport
// Controls, la misma que enseña el panel de volumen): si está reproduciendo
// y es música, o si el tipo no se sabe pero la app es un reproductor de
// música conocido (Spotify, Música de Apple, foobar2000…). Los navegadores
// suelen informar de «vídeo» o de nada: YouTube Music no cuenta. Se descarta
// el medidor de pico de audio (WASAPI) porque también salta con llamadas y
// sonidos del sistema.
//
// Cero tokens: una consulta local de WinRT cuando la webview pregunta (cada
// pocos segundos y solo con el ajuste activo). Cualquier error = sin música.
// El gestor de sesiones (RequestAsync) se pide una vez y se reutiliza; si una
// consulta falla se descarta y la siguiente lo vuelve a pedir.

use std::sync::Mutex;

use serde::Serialize;

/// Valor caro de crear que se guarda tras el primer éxito y se descarta con
/// `reset` (un error al usarlo).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct Cached<T>(Mutex<Option<T>>);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl<T: Clone> Cached<T> {
    const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// El valor guardado o, si no hay, el de `init` (un error no se guarda).
    fn get_or_try<E>(&self, init: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
        let mut slot = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(v) = slot.as_ref() {
            return Ok(v.clone());
        }
        let v = init()?;
        *slot = Some(v.clone());
        Ok(v)
    }

    fn reset(&self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Media {
    /// Está sonando música ahora.
    pub music: bool,
}

/// Estado de reproducción (subconjunto de GlobalSystemMediaTransportControlsSessionPlaybackStatus).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackState {
    Playing,
    Other,
}

/// Tipo de contenido (MediaPlaybackType); None = la app no lo dice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Music,
    Video,
    Image,
    Unknown,
}

/// Reproductores de música conocidos (trozo del AUMID o del ejecutable, en minúsculas).
pub const MUSIC_APPS: &[&str] = &[
    "spotify",
    "applemusic",
    "zunemusic",
    "foobar2000",
    "musicbee",
    "aimp",
    "tidal",
    "deezer",
    "winamp",
];

/// ¿Cuenta como música? Reproduciendo y de tipo música, o de tipo
/// desconocido en un reproductor de música conocido.
pub fn classify_music(status: PlaybackState, kind: Option<MediaKind>, app_id: &str) -> bool {
    if status != PlaybackState::Playing {
        return false;
    }
    match kind {
        Some(MediaKind::Music) => true,
        Some(MediaKind::Video) | Some(MediaKind::Image) => false,
        Some(MediaKind::Unknown) | None => {
            let app = app_id.to_ascii_lowercase();
            MUSIC_APPS.iter().any(|m| app.contains(m))
        }
    }
}

#[cfg(target_os = "windows")]
type SessionManager = windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

/// Gestor de sesiones multimedia (agile: Send + Sync en windows-rs).
#[cfg(target_os = "windows")]
static MANAGER: Cached<SessionManager> = Cached::new();

#[cfg(target_os = "windows")]
fn current_music() -> windows::core::Result<bool> {
    let manager = MANAGER.get_or_try(|| SessionManager::RequestAsync()?.get())?;
    let result = music_of(&manager);
    if result.is_err() {
        MANAGER.reset();
    }
    result
}

#[cfg(target_os = "windows")]
fn music_of(manager: &SessionManager) -> windows::core::Result<bool> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
    use windows::Media::MediaPlaybackType;

    let Some(session) = session_or_none(manager.GetCurrentSession())? else {
        return Ok(false);
    };
    let info = session.GetPlaybackInfo()?;
    let status = if info.PlaybackStatus()? == Status::Playing {
        PlaybackState::Playing
    } else {
        PlaybackState::Other
    };
    let kind = info
        .PlaybackType()
        .and_then(|r| r.Value())
        .ok()
        .map(|t| match t {
            MediaPlaybackType::Music => MediaKind::Music,
            MediaPlaybackType::Video => MediaKind::Video,
            MediaPlaybackType::Image => MediaKind::Image,
            _ => MediaKind::Unknown,
        });
    let app = session
        .SourceAppUserModelId()
        .map(|s| s.to_string())
        .unwrap_or_default();
    Ok(classify_music(status, kind, &app))
}

/// Sin sesión activa, GetCurrentSession devuelve un nulo, que windows-rs
/// convierte en un error con código S_OK: eso es «no hay música». Un HRESULT
/// de fallo real (p. ej. el broker reiniciado) se propaga para que
/// `current_music` descarte el gestor cacheado y lo vuelva a pedir.
#[cfg(target_os = "windows")]
fn session_or_none<T>(r: windows::core::Result<T>) -> windows::core::Result<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.code().is_ok() => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(not(target_os = "windows"))]
fn current_music() -> Result<bool, ()> {
    Ok(false)
}

/// ¿Suena música? (la sondea la webview con el ajuste «Bailar con música»).
#[tauri::command]
pub async fn mascot_media() -> Result<Media, String> {
    tauri::async_runtime::spawn_blocking(|| Media {
        music: current_music().unwrap_or(false),
    })
    .await
    .map_err(|e| format!("tarea interrumpida: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn musica_reproduciendose_cuenta() {
        assert!(classify_music(
            PlaybackState::Playing,
            Some(MediaKind::Music),
            "chrome"
        ));
    }

    #[test]
    fn en_pausa_no_cuenta_aunque_sea_spotify() {
        assert!(!classify_music(
            PlaybackState::Other,
            Some(MediaKind::Music),
            "Spotify.exe"
        ));
    }

    #[test]
    fn un_video_no_es_musica() {
        assert!(!classify_music(
            PlaybackState::Playing,
            Some(MediaKind::Video),
            "chrome"
        ));
        assert!(!classify_music(
            PlaybackState::Playing,
            Some(MediaKind::Video),
            "Spotify.exe"
        ));
    }

    #[test]
    fn tipo_desconocido_solo_en_reproductores_de_musica() {
        assert!(classify_music(PlaybackState::Playing, None, "Spotify.exe"));
        assert!(classify_music(
            PlaybackState::Playing,
            Some(MediaKind::Unknown),
            "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"
        ));
        // Caso negativo: un navegador sin tipo no cuenta.
        assert!(!classify_music(PlaybackState::Playing, None, "chrome"));
        assert!(!classify_music(
            PlaybackState::Playing,
            Some(MediaKind::Unknown),
            "msedge"
        ));
    }

    /// Consulta real a los controles multimedia de Windows (a mano:
    /// `cargo test --lib mascot::media -- --ignored --nocapture`).
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn consulta_real_de_la_sesion_multimedia() {
        let r = current_music();
        println!("música ahora: {r:?}");
        assert!(r.is_ok(), "WinRT falló: {r:?}");
    }

    #[test]
    fn el_gestor_se_pide_una_vez_y_se_repide_tras_un_fallo() {
        let cache: Cached<u32> = Cached::new();
        let calls = std::cell::Cell::new(0);
        let init = || -> Result<u32, ()> {
            calls.set(calls.get() + 1);
            Ok(7)
        };
        assert_eq!(cache.get_or_try(init), Ok(7));
        assert_eq!(cache.get_or_try(init), Ok(7));
        assert_eq!(calls.get(), 1, "se reutiliza");
        cache.reset();
        assert_eq!(cache.get_or_try(init), Ok(7));
        assert_eq!(calls.get(), 2, "tras un fallo se vuelve a pedir");
        // Caso negativo: un error al crearlo no se guarda.
        let empty: Cached<u32> = Cached::new();
        assert_eq!(empty.get_or_try(|| Err::<u32, ()>(())), Err(()));
        assert_eq!(empty.get_or_try(|| Ok::<u32, ()>(1)), Ok(1));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sin_sesion_no_hay_musica_y_un_fallo_real_se_propaga() {
        use windows::core::{Error, HRESULT};
        assert_eq!(session_or_none(Ok::<u32, Error>(3)).unwrap(), Some(3));
        // Nulo de windows-rs (código S_OK): no hay sesión, no es un fallo.
        assert_eq!(session_or_none::<u32>(Err(Error::empty())).unwrap(), None);
        // Caso negativo: un HRESULT de fallo no se traga (si no, el gestor
        // cacheado no se repediría nunca).
        let rpc_gone = HRESULT(0x800706BAu32 as i32);
        assert!(session_or_none::<u32>(Err(Error::from_hresult(rpc_gone))).is_err());
    }

    #[test]
    fn se_serializa_con_el_nombre_que_espera_la_webview() {
        let v = serde_json::to_value(Media { music: true }).unwrap();
        assert_eq!(v, serde_json::json!({ "music": true }));
    }
}
