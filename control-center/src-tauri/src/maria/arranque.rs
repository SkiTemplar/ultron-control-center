// mar.ia — arrancar con Windows, y que el interruptor de Ajustes MANDE.
//
// Dos peticiones del usuario:
//   2026-09-21: "la aplicacion deberia iniciarse en el arranque del pc y no lo
//   hace, debes poner una opcion en ajustes para ello, y que si esta activada
//   lo cumpla".
//   2026-09-23: "deshabilita completamente que maria se ejecute al inicio,
//   siempre y cuando lo tenga desactivado en la aplicacion, ninguno de sus
//   procesos".
//
// Lo que fallaba el 2026-09-23: nada guardaba la decision. El interruptor
// borraba la entrada de `HKCU\...\Run`, pero `scripts/instalar-lanzador.ps1`
// la volvia a escribir en cada `npm run build:local`, y `ensure_autostart` la
// recreaba si alguien limpiaba su marca en `.tmp`. Ademas habia dos
// interruptores (Ajustes → General con el plugin de Tauri, y Ajustes →
// Arranque con este modulo) sin estado comun.
//
// Ahora la decision vive en `<raiz>/cockpit/maria/arranque.json` y todo la
// respeta:
//   - este modulo al arrancar la app (`aplicar_al_arrancar`) y al pulsar el
//     interruptor (`fijar`);
//   - `run()` en lib.rs: si Windows lanza mar.ia con `--from-autostart` y la
//     preferencia dice que no, la app sale ANTES de levantar nada (Qdrant,
//     daemon de memoria, voz, Ollama);
//   - el lanzador del build y los instaladores de tareas de `scripts/`.
//
// "Ninguno de sus procesos": ademas de la entrada Run, mar.ia puede dejar
// tareas programadas que se lanzan al iniciar sesion (el programador del
// cockpit, el arranque y el vigilante de Qdrant). Desactivar el arranque las
// APAGA (Disable-ScheduledTask, no las borra) y anota cuales, para que
// activarlo de nuevo encienda exactamente esas.
//
// Solo toca HKCU y tareas del usuario. No pide administrador.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Nombre del valor dentro de la clave Run. El mismo que deja
/// `scripts/instalar-lanzador.ps1`: si fueran distintos, habria dos entradas
/// y dos copias de mar.ia al iniciar sesion.
const VALOR: &str = "mar.ia";
/// Nombres de entradas de versiones anteriores (ULTRON). Tambien lanzan un
/// `control-center.exe`, asi que desactivar el arranque las quita.
const VALORES_VIEJOS: [&str; 3] = ["ULTRON", "ULTRON Control Center", "ultron-control-center"];
const CLAVE_RUN: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const CLAVE_APROBADO: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// Marca que Windows pone al arrancar desde la entrada, para distinguirlo de
/// una apertura a mano.
pub const BANDERA: &str = "--from-autostart";
const FICHERO_PREF: &str = "arranque.json";
/// Tareas programadas que son de mar.ia (todas las que crean sus scripts:
/// `ULTRON-QdrantBoot`, `ULTRON-QdrantWatchdog`, `ULTRON-Daily-Diagnostic`, el
/// prefijo `Ultron` del programador...). `-TaskName` no distingue mayusculas.
const PATRONES_TAREA: [&str; 3] = ["ULTRON*", "maria*", "mar.ia*"];

/// Lo que el usuario eligio en Ajustes. Fuente de verdad del arranque.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Preferencia {
    pub activado: bool,
    /// Tareas que se apagaron al desactivar el arranque: activarlo vuelve a
    /// encender estas y solo estas (una que el usuario tuviera apagada por su
    /// cuenta sigue apagada).
    #[serde(default)]
    pub tareas_apagadas: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EstadoArranque {
    /// Lo que dice el interruptor de Ajustes.
    pub activado_en_ajustes: bool,
    /// Hay una entrada de arranque para mar.ia.
    pub registrado: bool,
    /// Lo que hay escrito en el registro (ruta + argumentos).
    pub comando: String,
    /// La entrada apunta al ejecutable que se esta ejecutando ahora.
    pub apunta_aqui: bool,
    /// Windows la tiene desactivada desde el Administrador de tareas.
    pub bloqueado_por_windows: bool,
    /// Tareas de mar.ia ENCENDIDAS que se lanzarian al iniciar sesion.
    pub tareas_de_inicio: Vec<String>,
    /// Tareas que mar.ia apago al desactivar el arranque.
    pub tareas_apagadas: Vec<String>,
    /// Que pasa ahora, en una frase. Vacio = todo en orden.
    pub problema: String,
}

fn exe_actual() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Comando que deberia estar escrito en el registro.
#[must_use]
pub fn comando_esperado() -> String {
    format!("\"{}\" {BANDERA}", exe_actual())
}

// --- preferencia -----------------------------------------------------------

/// Ruta de la preferencia. No crea carpetas: se lee tambien en `run()`, antes
/// de que exista nada.
fn ruta_pref() -> PathBuf {
    crate::maria::paths::home()
        .join("cockpit")
        .join("maria")
        .join(FICHERO_PREF)
}

/// Interpreta el fichero. Tolera la BOM que deja PowerShell 5.1 al escribir
/// UTF-8 (los instaladores de `scripts/` tambien la tocan).
#[must_use]
pub fn pref_de_texto(texto: &str) -> Option<Preferencia> {
    serde_json::from_str(texto.trim_start_matches('\u{feff}')).ok()
}

#[must_use]
pub fn leer_pref() -> Option<Preferencia> {
    std::fs::read_to_string(ruta_pref())
        .ok()
        .and_then(|t| pref_de_texto(&t))
}

fn guardar_pref(p: &Preferencia) -> Result<(), String> {
    let ruta = ruta_pref();
    if let Some(dir) = ruta.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    // Escribir y renombrar: un corte a mitad no puede dejar la preferencia a
    // medias (un JSON roto se leeria como "no hay preferencia").
    let tmp = ruta.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &ruta).map_err(|e| format!("guardar {}: {e}", ruta.display()))
}

/// Primera vez con preferencia: se deduce de lo que habia.
///
/// Con la marca de `ensure_autostart` (instalacion que ya paso por aqui) manda
/// el registro tal como esta. Sin marca es una instalacion nueva y se activa,
/// que era el comportamiento de siempre (un asistente arranca con Windows).
#[must_use]
pub fn pref_migrada(habia_marca: bool, habia_entrada: bool) -> Preferencia {
    Preferencia {
        activado: if habia_marca { habia_entrada } else { true },
        tareas_apagadas: Vec::new(),
    }
}

/// ¿Tiene que salir la app nada mas empezar?
///
/// Solo si la lanzo Windows (`--from-autostart`) y el usuario tiene el
/// arranque desactivado. Una apertura a mano nunca sale. Sin preferencia
/// (instalacion anterior a esta) tampoco: aun no hay decision que respetar.
#[must_use]
pub fn debe_salir(args: &[String], pref: Option<&Preferencia>) -> bool {
    args.iter().any(|a| a == BANDERA) && matches!(pref, Some(p) if !p.activado)
}

// --- registro --------------------------------------------------------------

#[cfg(windows)]
fn leer_valor(clave: &str, nombre: &str) -> Option<String> {
    let salida = crate::proc::oculto("reg.exe")
        .args(["query", clave, "/v", nombre])
        .output()
        .ok()?;
    if !salida.status.success() {
        return None;
    }
    let texto = String::from_utf8_lossy(&salida.stdout).to_string();
    // Formato: "    mar.ia    REG_SZ    C:\...\control-center.exe --from-autostart"
    texto
        .lines()
        .find(|l| l.trim_start().starts_with(nombre))
        .and_then(|l| {
            l.split_once("REG_SZ")
                .or_else(|| l.split_once("REG_BINARY"))
        })
        .map(|(_, v)| v.trim().to_string())
}

#[cfg(not(windows))]
fn leer_valor(_clave: &str, _nombre: &str) -> Option<String> {
    None
}

/// ¿Windows ha desactivado la entrada desde el Administrador de tareas?
///
/// El valor es binario; el PRIMER byte manda: 2 o 6 = habilitada, 3 = el
/// usuario la desactivo. Que no exista el valor significa que nadie la ha
/// tocado, o sea habilitada.
#[must_use]
pub fn bloqueada(primer_byte: Option<u8>) -> bool {
    matches!(primer_byte, Some(b) if b != 2 && b != 6)
}

#[cfg(windows)]
fn primer_byte_aprobado() -> Option<u8> {
    let hex = leer_valor(CLAVE_APROBADO, VALOR)?;
    // `reg query` devuelve el binario como una cadena hexadecimal continua.
    let limpio: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    u8::from_str_radix(limpio.get(0..2)?, 16).ok()
}

#[cfg(not(windows))]
fn primer_byte_aprobado() -> Option<u8> {
    None
}

#[cfg(windows)]
fn escribir_run() -> Result<(), String> {
    let ok = crate::proc::oculto("reg.exe")
        .args([
            "add",
            CLAVE_RUN,
            "/v",
            VALOR,
            "/t",
            "REG_SZ",
            "/d",
            &comando_esperado(),
            "/f",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("no pude escribir la entrada de arranque".into())
    }
}

#[cfg(not(windows))]
fn escribir_run() -> Result<(), String> {
    Err("el arranque automatico solo esta implementado en Windows".into())
}

/// Quita la entrada de mar.ia y las de ULTRON. Barata (solo `reg.exe`): se
/// usa tambien en `run()` antes de salir.
#[cfg(windows)]
pub fn quitar_entradas_run() {
    for nombre in std::iter::once(VALOR).chain(VALORES_VIEJOS) {
        let _ = crate::proc::oculto("reg.exe")
            .args(["delete", CLAVE_RUN, "/v", nombre, "/f"])
            .output();
    }
}

#[cfg(not(windows))]
pub fn quitar_entradas_run() {}

fn entradas_run_que_quedan() -> Vec<String> {
    std::iter::once(VALOR)
        .chain(VALORES_VIEJOS)
        .filter(|n| leer_valor(CLAVE_RUN, n).is_some())
        .map(str::to_string)
        .collect()
}

// --- tareas programadas ----------------------------------------------------

/// Una tarea de mar.ia tal como la cuenta PowerShell.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TareaVista {
    /// `TaskPath` + `TaskName`, p. ej. `\ULTRON-QdrantBoot`.
    pub ruta: String,
    /// `Ready`, `Running`, `Disabled`...
    pub estado: String,
    /// Settings.StartWhenAvailable: si se perdio su hora, corre al volver.
    #[serde(default)]
    pub al_volver: bool,
    #[serde(default)]
    pub disparadores: Vec<Disparador>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Disparador {
    /// Clase CIM: `MSFT_TaskLogonTrigger`, `MSFT_TaskTimeTrigger`...
    pub clase: String,
    /// Tiene intervalo de repeticion (el vigilante de Qdrant: cada 5 min).
    #[serde(default)]
    pub repite: bool,
}

/// ¿Esta tarea lanzaria algo de mar.ia al iniciar sesion?
///
/// Si: al iniciar sesion o el sistema, al desbloquear o conectar la sesion,
/// las que repiten cada pocos minutos (corren en cuanto hay sesion) y las que
/// recuperan la hora perdida (una diaria de las 3:00 con el PC apagado corre
/// nada mas encenderlo). No: una diaria o semanal normal, que corre a su hora
/// con la sesion ya abierta.
#[must_use]
pub fn es_de_inicio(t: &TareaVista) -> bool {
    t.al_volver
        || t.disparadores.iter().any(|d| {
            d.repite
                || matches!(
                    d.clase.as_str(),
                    "MSFT_TaskLogonTrigger"
                        | "MSFT_TaskBootTrigger"
                        | "MSFT_TaskSessionStateChangeTrigger"
                )
        })
}

#[must_use]
pub fn encendida(t: &TareaVista) -> bool {
    !t.estado.eq_ignore_ascii_case("Disabled")
}

/// Comillas simples de PowerShell: dentro solo hay que doblar la comilla.
fn ps_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Separa `\Carpeta\Nombre` en (`\Carpeta\`, `Nombre`).
#[must_use]
pub fn partir_ruta(ruta: &str) -> (String, String) {
    match ruta.rfind('\\') {
        Some(i) => (ruta[..=i].to_string(), ruta[i + 1..].to_string()),
        None => ("\\".to_string(), ruta.to_string()),
    }
}

/// Lee la salida JSON de PowerShell. Vacia o rota = ninguna tarea.
#[must_use]
pub fn tareas_de_json(json: &str) -> Vec<TareaVista> {
    let limpio = json.trim().trim_start_matches('\u{feff}');
    if limpio.is_empty() {
        return Vec::new();
    }
    // ConvertTo-Json de un solo objeto no da lista: se aceptan las dos formas.
    serde_json::from_str::<Vec<TareaVista>>(limpio)
        .or_else(|_| serde_json::from_str::<TareaVista>(limpio).map(|t| vec![t]))
        .unwrap_or_default()
}

#[cfg(windows)]
fn powershell(script: &str) -> Option<String> {
    let salida = crate::proc::oculto("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    salida
        .status
        .success()
        .then(|| String::from_utf8_lossy(&salida.stdout).to_string())
}

#[cfg(windows)]
fn tareas_de_maria() -> Vec<TareaVista> {
    let patrones = PATRONES_TAREA
        .iter()
        .map(|p| ps_literal(p))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $t = @(Get-ScheduledTask -TaskName {patrones} | Sort-Object TaskPath,TaskName -Unique | ForEach-Object {{ \
           [pscustomobject]@{{ \
             ruta = $_.TaskPath + $_.TaskName; \
             estado = [string]$_.State; \
             al_volver = [bool]$_.Settings.StartWhenAvailable; \
             disparadores = @($_.Triggers | ForEach-Object {{ [pscustomobject]@{{ \
               clase = [string]$_.CimClass.CimClassName; \
               repite = [bool]($_.Repetition -and $_.Repetition.Interval) }} }}) \
           }} }}); \
         ConvertTo-Json -InputObject $t -Depth 4 -Compress"
    );
    powershell(&script)
        .map(|s| tareas_de_json(&s))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn tareas_de_maria() -> Vec<TareaVista> {
    Vec::new()
}

/// Enciende o apaga tareas. Devuelve las que NO se pudieron cambiar.
#[cfg(windows)]
fn cambiar_tareas(rutas: &[String], encender: bool) -> Vec<String> {
    let verbo = if encender {
        "Enable-ScheduledTask"
    } else {
        "Disable-ScheduledTask"
    };
    rutas
        .iter()
        .filter(|ruta| {
            let (carpeta, nombre) = partir_ruta(ruta);
            let script = format!(
                "$ErrorActionPreference='Stop'; {verbo} -TaskPath {} -TaskName {} | Out-Null",
                ps_literal(&carpeta),
                ps_literal(&nombre)
            );
            powershell(&script).is_none()
        })
        .cloned()
        .collect()
}

#[cfg(not(windows))]
fn cambiar_tareas(rutas: &[String], _encender: bool) -> Vec<String> {
    rutas.to_vec()
}

/// Tareas de mar.ia encendidas que se lanzarian al iniciar sesion.
fn tareas_de_inicio_encendidas() -> Vec<String> {
    tareas_de_maria()
        .into_iter()
        .filter(|t| encendida(t) && es_de_inicio(t))
        .map(|t| t.ruta)
        .collect()
}

// --- estado y decisiones ---------------------------------------------------

/// Decide la frase de diagnostico. Pura: se testea sin registro.
#[must_use]
pub fn problema_de(
    activado: bool,
    registrado: bool,
    apunta_aqui: bool,
    bloqueado: bool,
    tareas_de_inicio: usize,
) -> String {
    if !activado {
        if registrado {
            return "Desactivado en Ajustes, pero la entrada de arranque sigue escrita: \
                    vuelve a desactivarlo aquí para quitarla."
                .into();
        }
        if tareas_de_inicio > 0 {
            return format!(
                "Desactivado en Ajustes, pero {tareas_de_inicio} tarea(s) de mar.ia se lanzan al \
                 iniciar sesión: vuelve a desactivarlo aquí para apagarlas."
            );
        }
        return String::new();
    }
    if !registrado {
        return "Activado en Ajustes, pero no hay entrada de arranque: vuelve a activarlo \
                aquí para escribirla."
            .into();
    }
    if bloqueado {
        return "Windows lo tiene desactivado. Administrador de tareas → Aplicaciones de \
                inicio → mar.ia → Habilitar. Mientras esté así, la entrada existe pero no \
                se ejecuta."
            .into();
    }
    if !apunta_aqui {
        return "La entrada de arranque apunta a OTRA copia de mar.ia. Vuelve a activarla \
                aquí para que apunte a esta."
            .into();
    }
    String::new()
}

fn apunta_a(comando: &str, exe: &str) -> bool {
    // Se compara sin comillas ni mayusculas: Windows no distingue y el valor
    // puede estar escrito con o sin ellas.
    let norm = |s: &str| s.replace('"', "").to_lowercase();
    !comando.trim().is_empty() && !exe.is_empty() && norm(comando).contains(&norm(exe))
}

#[must_use]
pub fn estado() -> EstadoArranque {
    let comando = leer_valor(CLAVE_RUN, VALOR).unwrap_or_default();
    let registrado = !comando.trim().is_empty();
    let apunta_aqui = apunta_a(&comando, &exe_actual());
    let bloqueado_por_windows = bloqueada(primer_byte_aprobado());
    let pref = leer_pref();
    // Sin preferencia todavia, lo que hay en el registro es lo que se ve.
    let activado_en_ajustes = pref.as_ref().map_or(registrado, |p| p.activado);
    let tareas_de_inicio = tareas_de_inicio_encendidas();
    // Las entradas de ULTRON tambien cuentan como "sigue escrita".
    let alguna_entrada = registrado || !entradas_run_que_quedan().is_empty();
    EstadoArranque {
        problema: problema_de(
            activado_en_ajustes,
            if activado_en_ajustes {
                registrado
            } else {
                alguna_entrada
            },
            apunta_aqui,
            bloqueado_por_windows,
            if activado_en_ajustes {
                0
            } else {
                tareas_de_inicio.len()
            },
        ),
        activado_en_ajustes,
        registrado,
        comando,
        apunta_aqui,
        bloqueado_por_windows,
        tareas_de_inicio,
        tareas_apagadas: pref.map(|p| p.tareas_apagadas).unwrap_or_default(),
    }
}

/// Enciende o apaga el arranque con Windows, lo GUARDA como decision del
/// usuario y comprueba que quedo hecho.
///
/// Devuelve el estado leido despues de escribir: un interruptor que dice "ya
/// esta" sin volver a mirar es exactamente lo que dejo al usuario pensando que
/// lo tenia activado (mandamiento 11).
pub fn fijar(activar: bool) -> Result<EstadoArranque, String> {
    let mut pref = leer_pref().unwrap_or_default();
    let mut fallos: Vec<String> = Vec::new();
    if activar {
        escribir_run()?;
        // Y se quita la marca de "desactivado por el usuario" de Windows: si
        // estaba puesta, activar sin borrarla no serviria de nada.
        #[cfg(windows)]
        let _ = crate::proc::oculto("reg.exe")
            .args(["delete", CLAVE_APROBADO, "/v", VALOR, "/f"])
            .output();
        let por_encender = std::mem::take(&mut pref.tareas_apagadas);
        let sin_encender = cambiar_tareas(&por_encender, true);
        if !sin_encender.is_empty() {
            fallos.push(format!(
                "no pude volver a encender: {}",
                sin_encender.join(", ")
            ));
        }
        // Las que no se pudieron encender (o ya no existen) siguen anotadas:
        // no se pierde la cuenta de lo que mar.ia apago.
        pref.tareas_apagadas = sin_encender;
    } else {
        quitar_entradas_run();
        // Accesos directos en la carpeta Inicio (ULTRON y mar.ia): Windows
        // los ejecuta aparte de la clave Run.
        match crate::settings::purge_legacy_autostart_inner() {
            Ok(r) if !r.warnings.is_empty() => fallos.push(r.warnings.join("; ")),
            Ok(_) => {}
            Err(e) => fallos.push(e),
        }
        let de_inicio = tareas_de_inicio_encendidas();
        let sin_apagar = cambiar_tareas(&de_inicio, false);
        for t in de_inicio.into_iter().filter(|t| !sin_apagar.contains(t)) {
            if !pref.tareas_apagadas.contains(&t) {
                pref.tareas_apagadas.push(t);
            }
        }
        if !sin_apagar.is_empty() {
            fallos.push(format!("no pude apagar: {}", sin_apagar.join(", ")));
        }
    }
    pref.activado = activar;
    guardar_pref(&pref)?;
    let e = estado();
    if fallos.is_empty() {
        Ok(e)
    } else {
        Err(format!("{}. {}", fallos.join("; "), e.problema))
    }
}

/// Al abrir la app: que el sistema quede como dice la preferencia.
///
/// Activado: la entrada existe y apunta a este ejecutable (tras mover o
/// reconstruir el repo, se reapunta). No toca la marca de Windows: si el
/// usuario lo bloqueo en el Administrador de tareas, eso se respeta y se
/// enseña en Ajustes. Desactivado: se quita la entrada y se apagan las tareas
/// de inicio que alguien haya creado desde la ultima vez.
///
/// Best-effort y en su propio hilo: un fallo aqui no puede impedir que la
/// aplicacion abra.
pub fn aplicar_al_arrancar() {
    let pref = match leer_pref() {
        Some(p) => p,
        None => {
            let marca = crate::maria::paths::home()
                .join(".tmp")
                .join("maria-autostart-done.txt");
            let p = pref_migrada(marca.exists(), leer_valor(CLAVE_RUN, VALOR).is_some());
            if let Err(e) = guardar_pref(&p) {
                tracing::warn!(error = %e, "no pude guardar la preferencia de arranque");
            }
            p
        }
    };
    if pref.activado {
        let comando = leer_valor(CLAVE_RUN, VALOR).unwrap_or_default();
        if !apunta_a(&comando, &exe_actual()) {
            match escribir_run() {
                Ok(()) => tracing::info!("mar.ia registrada para arrancar con Windows"),
                Err(e) => tracing::warn!(error = %e, "no pude registrar el arranque"),
            }
        }
    } else if let Err(e) = fijar(false) {
        tracing::warn!(error = %e, "arranque desactivado, pero quedo algo encendido");
    }
}

/// Si el usuario tiene el arranque desactivado, editar una tarea para que se
/// lance al iniciar sesion choca con esa decision: se dice por que, en vez de
/// crearla y apagarla por detras (seria un no-op silencioso).
#[must_use]
pub fn choque_con_edicion(
    activado: bool,
    disparador: &str,
    al_volver: Option<bool>,
) -> Option<String> {
    if activado {
        return None;
    }
    if disparador.eq_ignore_ascii_case("AtLogon") {
        return Some(
            "El arranque con Windows está desactivado en Ajustes → Arranque: una tarea «al \
             iniciar sesión» lo saltaría. Actívalo allí o elige una hora."
                .into(),
        );
    }
    if al_volver == Some(true) {
        return Some(
            "El arranque con Windows está desactivado en Ajustes → Arranque: «recuperar la \
             hora perdida» haría que la tarea corriera al encender el PC. Actívalo allí o \
             quita esa opción."
                .into(),
        );
    }
    None
}

#[tauri::command]
pub async fn maria_arranque_estado() -> Result<EstadoArranque, String> {
    tauri::async_runtime::spawn_blocking(estado)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[tauri::command]
pub async fn maria_arranque_set(activar: bool) -> Result<EstadoArranque, String> {
    tauri::async_runtime::spawn_blocking(move || fijar(activar))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tarea(ruta: &str, estado: &str, clases: &[(&str, bool)], al_volver: bool) -> TareaVista {
        TareaVista {
            ruta: ruta.into(),
            estado: estado.into(),
            al_volver,
            disparadores: clases
                .iter()
                .map(|(c, r)| Disparador {
                    clase: (*c).into(),
                    repite: *r,
                })
                .collect(),
        }
    }

    #[test]
    fn solo_2_y_6_significan_habilitado() {
        // Los valores que usa Windows. Un 3 es "el usuario la desactivo desde
        // el Administrador de tareas", que es el caso silencioso: la entrada
        // sigue escrita y aun asi no arranca.
        assert!(!bloqueada(Some(2)));
        assert!(!bloqueada(Some(6)));
        assert!(bloqueada(Some(3)));
        assert!(bloqueada(Some(1)));
    }

    #[test]
    fn sin_marca_no_esta_bloqueada() {
        // Caso negativo: que no exista el valor significa que nadie la ha
        // tocado. Tratarlo como bloqueo haria que la pantalla avisara de un
        // problema inexistente en una instalacion recien hecha.
        assert!(!bloqueada(None));
    }

    #[test]
    fn activado_cada_fallo_tiene_su_frase_y_en_orden() {
        assert!(problema_de(true, false, false, false, 0).contains("no hay entrada"));
        // El bloqueo de Windows manda sobre el resto: mientras este puesto, da
        // igual a donde apunte la entrada.
        assert!(problema_de(true, true, true, true, 0).contains("Administrador de tareas"));
        assert!(problema_de(true, true, false, false, 0).contains("OTRA copia"));
        assert_eq!(problema_de(true, true, true, false, 0), "");
    }

    #[test]
    fn desactivado_sin_restos_no_es_un_problema() {
        // Antes, sin entrada salia «No está configurado» como aviso aunque el
        // usuario lo hubiera apagado a proposito.
        assert_eq!(problema_de(false, false, false, false, 0), "");
    }

    #[test]
    fn desactivado_con_restos_lo_dice() {
        assert!(problema_de(false, true, true, false, 0).contains("sigue escrita"));
        assert!(problema_de(false, false, false, false, 2).contains("2 tarea(s)"));
    }

    #[test]
    fn el_comando_lleva_la_bandera_de_arranque() {
        // Sin ella, la instancia unica no sabe distinguir un arranque
        // automatico de una apertura a mano y enfoca la ventana sin que nadie
        // se lo haya pedido; y `debe_salir` no podria reconocerlo.
        assert!(comando_esperado().contains(BANDERA));
        assert!(
            comando_esperado().starts_with('"'),
            "la ruta va entrecomillada"
        );
    }

    #[test]
    fn sale_solo_si_la_lanzo_windows_y_esta_desactivado() {
        let args = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        let apagado = Preferencia {
            activado: false,
            tareas_apagadas: vec![],
        };
        let encendido = Preferencia {
            activado: true,
            tareas_apagadas: vec![],
        };
        assert!(debe_salir(&args(&["mar.ia.exe", BANDERA]), Some(&apagado)));
        // Casos negativos: abierta a mano, activado, o sin decision todavia.
        assert!(!debe_salir(&args(&["mar.ia.exe"]), Some(&apagado)));
        assert!(!debe_salir(
            &args(&["mar.ia.exe", BANDERA]),
            Some(&encendido)
        ));
        assert!(!debe_salir(&args(&["mar.ia.exe", BANDERA]), None));
    }

    #[test]
    fn la_primera_preferencia_respeta_lo_que_habia() {
        assert!(
            pref_migrada(false, false).activado,
            "instalacion nueva: activado"
        );
        assert!(pref_migrada(true, true).activado);
        assert!(
            !pref_migrada(true, false).activado,
            "ya lo habia quitado: no se vuelve a poner"
        );
    }

    #[test]
    fn la_preferencia_se_lee_con_la_bom_de_powershell() {
        let p = pref_de_texto(
            "\u{feff}{\"activado\":false,\"tareas_apagadas\":[\"\\\\ULTRON-QdrantBoot\"]}",
        )
        .expect("con BOM");
        assert!(!p.activado);
        assert_eq!(p.tareas_apagadas, vec!["\\ULTRON-QdrantBoot".to_string()]);
        assert_eq!(
            pref_de_texto("{\"activado\":true}").map(|p| p.activado),
            Some(true)
        );
        assert_eq!(pref_de_texto("no es json"), None);
    }

    #[test]
    fn tareas_que_se_lanzan_al_iniciar_sesion() {
        assert!(es_de_inicio(&tarea(
            "\\ULTRON-QdrantBoot",
            "Ready",
            &[("MSFT_TaskLogonTrigger", false)],
            false
        )));
        assert!(es_de_inicio(&tarea(
            "\\ULTRON-QdrantWatchdog",
            "Ready",
            &[("MSFT_TaskTimeTrigger", true)],
            true
        )));
        assert!(es_de_inicio(&tarea(
            "\\X",
            "Ready",
            &[("MSFT_TaskBootTrigger", false)],
            false
        )));
        assert!(es_de_inicio(&tarea(
            "\\X",
            "Ready",
            &[("MSFT_TaskDailyTrigger", false)],
            true
        )));
        // Casos negativos: una diaria a su hora, sin recuperar, no es de inicio.
        assert!(!es_de_inicio(&tarea(
            "\\ULTRON-Daily-Diagnostic",
            "Ready",
            &[("MSFT_TaskDailyTrigger", false)],
            false
        )));
        assert!(!es_de_inicio(&tarea("\\X", "Ready", &[], false)));
    }

    #[test]
    fn una_tarea_apagada_no_cuenta() {
        assert!(!encendida(&tarea("\\X", "Disabled", &[], false)));
        assert!(encendida(&tarea("\\X", "Ready", &[], false)));
    }

    #[test]
    fn json_de_powershell_en_sus_dos_formas() {
        let uno = r#"{"ruta":"\\ULTRON-QdrantBoot","estado":"Ready","al_volver":false,"disparadores":[{"clase":"MSFT_TaskLogonTrigger","repite":false}]}"#;
        let lista = format!("[{uno}]");
        assert_eq!(tareas_de_json(uno).len(), 1);
        assert_eq!(tareas_de_json(&lista).len(), 1);
        assert_eq!(tareas_de_json("[]"), Vec::<TareaVista>::new());
        assert_eq!(tareas_de_json(""), Vec::<TareaVista>::new());
        assert_eq!(tareas_de_json("basura"), Vec::<TareaVista>::new());
    }

    #[test]
    fn rutas_y_comillas_de_powershell() {
        assert_eq!(
            partir_ruta("\\ULTRON-QdrantBoot"),
            ("\\".to_string(), "ULTRON-QdrantBoot".to_string())
        );
        assert_eq!(
            partir_ruta("\\maria\\Diario"),
            ("\\maria\\".to_string(), "Diario".to_string())
        );
        assert_eq!(ps_literal("it's"), "'it''s'");
    }

    #[test]
    fn editar_una_tarea_de_inicio_con_el_arranque_apagado_se_explica() {
        assert!(choque_con_edicion(false, "AtLogon", None).is_some());
        assert!(choque_con_edicion(false, "Daily", Some(true)).is_some());
        // Casos negativos: con el arranque activado, o una diaria normal.
        assert!(choque_con_edicion(true, "AtLogon", Some(true)).is_none());
        assert!(choque_con_edicion(false, "Daily", Some(false)).is_none());
        assert!(choque_con_edicion(false, "Weekly", None).is_none());
    }
}
