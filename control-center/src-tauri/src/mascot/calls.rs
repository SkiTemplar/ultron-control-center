// Mascota — esconderse durante las llamadas.
//
// Windows apunta en el registro qué aplicaciones usan el micrófono:
// HKCU\...\CapabilityAccessManager\ConsentStore\microphone, una subclave por
// app empaquetada y otra por ejecutable bajo NonPackaged (la ruta con '#' en
// lugar de '\'). Mientras una app lo usa, LastUsedTimeStop vale 0.
//
// Ojo: una app que se cierra mal deja Stop = 0 para siempre (comprobado con
// una versión vieja de Discord). Por eso solo cuentan las entradas que
// empezaron después del arranque del equipo y cuyo proceso sigue vivo: en
// las NonPackaged, su ejecutable; en las empaquetadas, algún proceso de la
// familia del paquete (carpeta de WindowsApps o SystemApps). La lista de
// procesos solo se pide si hay algún candidato, se reutiliza SNAPSHOT_TTL y
// sale de un único `System` que se refresca (no uno nuevo por vuelta). Un
// candidato ya visto muerto (subclave + LastUsedTimeStart) no vuelve a pedir
// la lista: si la app se relanza y abre el micro, Start cambia.
//
// Alcance real: micrófono en uso no siempre es una llamada (un dictado o una
// nota de voz también lo ocultan). Una app empaquetada cuyo ejecutable no se
// puede leer (elevada) no cuenta. Cero tokens: registro y procesos.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use super::{screens, LABEL};

const TICK: Duration = Duration::from_millis(1500);
const SETTINGS_EVERY: u32 = 8;
/// Vigencia de la lista de procesos antes de volver a pedirla.
const SNAPSHOT_TTL: Duration = Duration::from_secs(12);
/// Segundos entre 1601-01-01 (FILETIME) y 1970-01-01 (Unix).
const FILETIME_UNIX_OFFSET_S: u64 = 11_644_473_600;

static WATCHING: AtomicBool = AtomicBool::new(false);
/// Estado compartido por el hilo y `mic_in_use` (Presence).
static STATE: Mutex<Option<(MicWatch, sysinfo::System)>> = Mutex::new(None);

/// Una subclave del ConsentStore del micrófono.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicEntry {
    /// Nombre de la subclave (familia del paquete o ruta con '#').
    pub key: String,
    pub packaged: bool,
    /// LastUsedTimeStart / LastUsedTimeStop (FILETIME).
    pub start: u64,
    pub stop: u64,
}

/// «C:#Users#x#app#Discord.exe» → «c:\users\x\app\discord.exe».
pub fn decode_nonpackaged(key: &str) -> String {
    key.replace('#', "\\").to_lowercase()
}

/// Segundos Unix → FILETIME (intervalos de 100 ns desde 1601).
pub fn unix_to_filetime(unix_s: u64) -> u64 {
    (unix_s + FILETIME_UNIX_OFFSET_S) * 10_000_000
}

fn now_filetime() -> u64 {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    unix_to_filetime(unix.as_secs())
}

/// Entradas que dicen estar usando el micrófono desde este arranque, sin
/// contar a la propia app. Pura.
fn candidates<'a>(entries: &'a [MicEntry], boot_filetime: u64, own_exe: &str) -> Vec<&'a MicEntry> {
    let own = own_exe.to_lowercase();
    entries
        .iter()
        .filter(|e| e.stop == 0 && e.start > boot_filetime)
        .filter(|e| e.packaged || decode_nonpackaged(&e.key) != own)
        .collect()
}

/// ¿Hay un proceso de la familia «Nombre_Editor»? Su carpeta es
/// «Nombre_Versión_Arq__Editor» (WindowsApps) o la familia tal cual
/// (SystemApps). Pura.
pub fn family_running(family: &str, exes: &HashSet<String>) -> bool {
    let fam = family.to_lowercase();
    let Some((name, publisher)) = fam.rsplit_once('_') else {
        return false;
    };
    let (prefix, suffix) = (format!("{name}_"), format!("_{publisher}"));
    exes.iter().any(|p| {
        p.split(['\\', '/'])
            .any(|seg| seg == fam || (seg.starts_with(&prefix) && seg.ends_with(&suffix)))
    })
}

fn is_alive(e: &MicEntry, exes: &HashSet<String>) -> bool {
    if e.packaged {
        family_running(&e.key, exes)
    } else {
        exes.contains(&decode_nonpackaged(&e.key))
    }
}

/// Procesos vivos (rutas en minúsculas) y cuándo se leyeron.
struct Snapshot {
    taken: Instant,
    taken_ft: u64,
    exes: HashSet<String>,
}

/// Estado entre vueltas: lista de procesos reutilizable y candidatos muertos.
#[derive(Default)]
pub struct MicWatch {
    snap: Option<Snapshot>,
    /// (subclave, LastUsedTimeStart) de candidatos vistos sin proceso.
    dead: HashSet<(String, u64)>,
}

impl MicWatch {
    /// Apps que usan el micrófono ahora mismo. `running` da las rutas (en
    /// minúsculas) de los procesos vivos y solo se llama si hace falta.
    /// Pura salvo `running`.
    pub fn active_users(
        &mut self,
        entries: &[MicEntry],
        boot_filetime: u64,
        own_exe: &str,
        now: (Instant, u64),
        running: impl FnOnce() -> HashSet<String>,
    ) -> Vec<String> {
        // Solo se recuerdan los muertos que siguen en el registro tal cual.
        self.dead.retain(|(k, s)| {
            entries
                .iter()
                .any(|e| e.key == *k && e.start == *s && e.stop == 0)
        });
        let cands: Vec<&MicEntry> = candidates(entries, boot_filetime, own_exe)
            .into_iter()
            .filter(|e| !self.dead.contains(&(e.key.clone(), e.start)))
            .collect();
        if cands.is_empty() {
            return Vec::new();
        }
        if self.needs_snapshot(&cands, now.0) {
            self.snap = Some(Snapshot {
                taken: now.0,
                taken_ft: now.1,
                exes: running(),
            });
        }
        let Some(snap) = self.snap.as_ref() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for e in cands {
            if is_alive(e, &snap.exes) {
                out.push(e.key.clone());
            } else if e.start < snap.taken_ft {
                // La lista es posterior a su arranque y no está: muerto.
                self.dead.insert((e.key.clone(), e.start));
            }
        }
        out
    }

    /// Sin lista, caducada o anterior a algún candidato (su proceso podría
    /// no estar aún en ella).
    fn needs_snapshot(&self, cands: &[&MicEntry], now: Instant) -> bool {
        self.snap.as_ref().is_none_or(|s| {
            now.duration_since(s.taken) >= SNAPSHOT_TTL
                || cands.iter().any(|e| e.start >= s.taken_ft)
        })
    }
}

fn running_exes(sys: &mut sysinfo::System) -> HashSet<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .values()
        .filter_map(|p| p.exe())
        .map(|p| p.to_string_lossy().to_lowercase())
        .collect()
}

fn own_exe() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// ¿Alguna app usa el micrófono ahora? (registro real).
pub fn mic_in_use() -> bool {
    let boot = unix_to_filetime(sysinfo::System::boot_time());
    let entries = reg::mic_entries();
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let (watch, sys) = guard.get_or_insert_with(|| (MicWatch::default(), sysinfo::System::new()));
    let now = (Instant::now(), now_filetime());
    !watch
        .active_users(&entries, boot, &own_exe(), now, || running_exes(sys))
        .is_empty()
}

/// Hilo «pupus-calls»: con el ajuste activo, esconde a Pupus mientras el
/// micrófono esté en uso; con el ajuste apagado, retira el motivo.
pub fn start(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("pupus-calls".into())
        .spawn(move || {
            let mut enabled = super::load_settings().hide_in_calls;
            let mut ticks: u32 = 0;
            loop {
                std::thread::sleep(TICK);
                ticks = ticks.wrapping_add(1);
                if ticks.is_multiple_of(SETTINGS_EVERY) {
                    enabled = super::load_settings().hide_in_calls;
                }
                if app.get_webview_window(LABEL).is_none() {
                    continue;
                }
                screens::set_auto_reason(&app, screens::CALL, enabled && mic_in_use());
            }
        });
    if let Err(e) = spawned {
        tracing::error!(error = %e, "mascota: no arrancó el vigilante de llamadas");
    }
}

#[cfg(target_os = "windows")]
mod reg {
    use super::MicEntry;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, REG_QWORD,
    };

    const ROOT: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Clave abierta que se cierra sola.
    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(parent: HKEY, sub: &str) -> Option<Key> {
        let mut h: HKEY = std::ptr::null_mut();
        let name = wide(sub);
        let rc = unsafe { RegOpenKeyExW(parent, name.as_ptr(), 0, KEY_READ, &mut h) };
        (rc == ERROR_SUCCESS).then_some(Key(h))
    }

    fn subkeys(k: &Key) -> Vec<String> {
        let mut out = Vec::new();
        for i in 0u32.. {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let rc = unsafe {
                RegEnumKeyExW(
                    k.0,
                    i,
                    buf.as_mut_ptr(),
                    &mut len,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if rc != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        out
    }

    fn qword(k: &Key, value: &str) -> Option<u64> {
        let name = wide(value);
        let mut kind = 0u32;
        let mut data = 0u64;
        let mut size = std::mem::size_of::<u64>() as u32;
        let rc = unsafe {
            RegQueryValueExW(
                k.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                &mut data as *mut u64 as *mut u8,
                &mut size,
            )
        };
        (rc == ERROR_SUCCESS && kind == REG_QWORD).then_some(data)
    }

    fn entry(parent: &Key, name: String, packaged: bool) -> Option<MicEntry> {
        let k = open(parent.0, &name)?;
        Some(MicEntry {
            start: qword(&k, "LastUsedTimeStart")?,
            stop: qword(&k, "LastUsedTimeStop")?,
            key: name,
            packaged,
        })
    }

    pub fn mic_entries() -> Vec<MicEntry> {
        let Some(root) = open(HKEY_CURRENT_USER, ROOT) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for name in subkeys(&root) {
            if name == "NonPackaged" {
                let Some(np) = open(root.0, &name) else {
                    continue;
                };
                out.extend(
                    subkeys(&np)
                        .into_iter()
                        .filter_map(|n| entry(&np, n, false)),
                );
            } else if let Some(e) = entry(&root, name, true) {
                out.push(e);
            }
        }
        out
    }
}

#[cfg(not(target_os = "windows"))]
mod reg {
    pub fn mic_entries() -> Vec<super::MicEntry> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const BOOT: u64 = 1_000_000;
    /// Lista de procesos tomada mucho después de todos los arranques.
    const LATER: u64 = BOOT + 1_000;
    const TEAMS_EXE: &str =
        "c:\\program files\\windowsapps\\msteams_25.1.0.0_x64__8wekyb3d8bbwe\\ms-teams.exe";

    fn np(path: &str, start: u64, stop: u64) -> MicEntry {
        MicEntry {
            key: path.into(),
            packaged: false,
            start,
            stop,
        }
    }

    fn teams(start: u64) -> MicEntry {
        MicEntry {
            key: "MSTeams_8wekyb3d8bbwe".into(),
            packaged: true,
            start,
            stop: 0,
        }
    }

    fn alive(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| p.to_lowercase()).collect()
    }

    fn active_mic_users(
        e: &[MicEntry],
        running: impl FnOnce() -> HashSet<String>,
        own: &str,
    ) -> Vec<String> {
        MicWatch::default().active_users(e, BOOT, own, (Instant::now(), LATER), running)
    }

    #[test]
    fn decodifica_la_ruta_de_una_entrada_no_empaquetada() {
        assert_eq!(
            decode_nonpackaged("C:#Users#x#app#Discord.exe"),
            "c:\\users\\x\\app\\discord.exe"
        );
    }

    #[test]
    fn una_entrada_obsoleta_de_otra_version_de_discord_no_cuenta() {
        // Caso negativo real: Stop = 0 de una versión que ya no corre.
        let e = [np("C:#App#Discord#app-1.0.9239#Discord.exe", BOOT + 5, 0)];
        let users = active_mic_users(
            &e,
            || alive(&["c:\\app\\discord\\app-1.0.9262\\discord.exe"]),
            "",
        );
        assert!(users.is_empty());
    }

    #[test]
    fn una_no_empaquetada_viva_y_una_empaquetada_viva_cuentan() {
        let e = [
            np("C:#App#Discord#app-1.0.9262#Discord.exe", BOOT + 5, 0),
            teams(BOOT + 9),
        ];
        let running = || alive(&["c:\\app\\discord\\app-1.0.9262\\discord.exe", TEAMS_EXE]);
        assert_eq!(active_mic_users(&e, running, "").len(), 2);
    }

    #[test]
    fn una_empaquetada_sin_proceso_de_su_familia_no_cuenta() {
        // Caso negativo: Teams se cerró mal y dejó Stop = 0 tras el arranque.
        let e = [teams(BOOT + 9)];
        let other = "c:\\program files\\windowsapps\\msteamsx_1.0.0.0_x64__8wekyb3d8bbwe\\a.exe";
        assert!(active_mic_users(&e, || alive(&[other]), "").is_empty());
        let system_app = "c:\\windows\\systemapps\\msteams_8wekyb3d8bbwe\\host.exe";
        assert_eq!(active_mic_users(&e, || alive(&[system_app]), "").len(), 1);
    }

    #[test]
    fn anterior_al_arranque_parada_o_propia_no_cuentan() {
        let e = [
            np("C:#a#old.exe", BOOT - 1, 0),
            np("C:#a#stopped.exe", BOOT + 5, BOOT + 6),
            np("C:#u#control-center.exe", BOOT + 5, 0),
        ];
        let all = || {
            alive(&[
                "c:\\a\\old.exe",
                "c:\\a\\stopped.exe",
                "c:\\u\\control-center.exe",
            ])
        };
        assert!(active_mic_users(&e, all, "C:\\u\\control-center.exe").is_empty());
    }

    #[test]
    fn sin_candidatos_no_se_piden_los_procesos() {
        let e = [np("C:#a#stopped.exe", BOOT + 5, BOOT + 6)];
        let users = active_mic_users(&e, || panic!("no debía listar procesos"), "");
        assert!(users.is_empty());
    }

    #[test]
    fn un_candidato_muerto_no_vuelve_a_pedir_los_procesos() {
        let e = [np("C:#a#crashed.exe", BOOT + 5, 0)];
        let (mut w, calls, t0) = (MicWatch::default(), Cell::new(0), Instant::now());
        let list = || {
            calls.set(calls.get() + 1);
            HashSet::new()
        };
        for i in 0..5u64 {
            let now = (t0 + SNAPSHOT_TTL * (i as u32 + 1), LATER + i);
            assert!(w.active_users(&e, BOOT, "", now, list).is_empty());
        }
        assert_eq!(calls.get(), 1, "solo la primera vuelta lista procesos");
        // Si la app se relanza y abre el micro, Start cambia: se vuelve a mirar.
        let relaunched = [np("C:#a#crashed.exe", LATER + 50, 0)];
        let now = (t0 + SNAPSHOT_TTL * 9, LATER + 60);
        let users = w.active_users(&relaunched, BOOT, "", now, || {
            alive(&["c:\\a\\crashed.exe"])
        });
        assert_eq!(users.len(), 1);
    }

    #[test]
    fn la_lista_de_procesos_se_reutiliza_mientras_vale() {
        let e = [np("C:#a#call.exe", BOOT + 5, 0)];
        let (mut w, calls, t0) = (MicWatch::default(), Cell::new(0), Instant::now());
        let list = || {
            calls.set(calls.get() + 1);
            alive(&["c:\\a\\call.exe"])
        };
        assert_eq!(w.active_users(&e, BOOT, "", (t0, LATER), list).len(), 1);
        let soon = (t0 + SNAPSHOT_TTL / 2, LATER + 1);
        assert_eq!(w.active_users(&e, BOOT, "", soon, list).len(), 1);
        assert_eq!(calls.get(), 1, "dentro del TTL no se relista");
        let late = (t0 + SNAPSHOT_TTL, LATER + 2);
        assert_eq!(w.active_users(&e, BOOT, "", late, list).len(), 1);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn un_candidato_posterior_a_la_lista_no_se_da_por_muerto() {
        let (mut w, t0) = (MicWatch::default(), Instant::now());
        let first = [np("C:#a#call.exe", BOOT + 5, 0)];
        w.active_users(&first, BOOT, "", (t0, LATER), || {
            alive(&["c:\\a\\call.exe"])
        });
        // Arranca otra app después de la lista: se relista aunque valga.
        let both = [first[0].clone(), np("C:#a#new.exe", LATER + 10, 0)];
        let now = (t0 + Duration::from_secs(1), LATER + 20);
        let users = w.active_users(&both, BOOT, "", now, || {
            alive(&["c:\\a\\call.exe", "c:\\a\\new.exe"])
        });
        assert_eq!(users.len(), 2);
    }

    #[test]
    #[ignore = "sonda: lee el registro y los procesos reales"]
    fn sonda_microfono_real() {
        let entries = reg::mic_entries();
        let stale: Vec<&str> = entries
            .iter()
            .filter(|e| e.stop == 0)
            .map(|e| e.key.as_str())
            .collect();
        eprintln!(
            "entradas: {}; Stop=0: {stale:?}; en uso: {}",
            entries.len(),
            mic_in_use()
        );
    }

    #[test]
    fn convierte_segundos_unix_a_filetime() {
        assert_eq!(unix_to_filetime(0), 116_444_736_000_000_000);
    }
}
