// sesiones/ — Backend de la ventana «ULTRON Sessions» (contratos en
// docs/sesiones/CONTRATO.md, v0.1, docs/sesiones/CONTRATO-v2.md, v0.2, y el
// contrato de estabilidad, docs/sesiones/CONTRATO-v3.md).
//
// Propiedad: WP-ESTADO. WP-PTY y WP-MOTORES solo editan dentro de su zona
// `// <WP-x>` … `// </WP-x>`.
//
// Submódulos:
//   types          — tipos y nombres de eventos del contrato
//   registro       — registro de sesiones vivas, salida de eventos (Sink) y
//                    cableado de la máquina (registro_estado.rs)
//   maquina        — máquina de estados pura de una sesión (+ maquina_tiempo)
//   cola           — cola única de envíos por sesión (+ cola_emparejar)
//   persistencia   — sesiones abiertas y su cola en abiertas.json, y su
//                    restauración al arrancar (+ persistencia_restaurar)
//   buzon          — operaciones backend → mod (puente v2)
//   transcript     — parser del JSONL de Claude Code a ChatMessage
//                    (+ transcript_clases: clases, señales Tx, cola nativa)
//   seguidor       — sondeo incremental de transcripts y subagentes
//   agentes        — árbol de subagentes desde disco + puente
//   puente         — servidor HTTP loopback del mod ultron-puente
//   puente_eventos — hello, events, ask, inbox, result y fill
//                    (+ puente_aplicar y puente_stream)
//   preguntas      — permisos, preguntas y planes pendientes
//   ajustes        — modelo, effort, permisos, socrático y prefs de lanzamiento
//   historial      — historial de prompts desde los transcripts
//   pagina         — historial paginado del chat (CONTRATO-v3 §7)
//   lectura_final  — lectura del final de un JSONL sin cargarlo entero
//   ficheros       — ficheros del proyecto para el autocompletar `@`
//   catalogo       — paleta de comandos (integrados, mods, skills…)
//   mods           — mods de ULTRON (solo lectura)
//   comandos       — envoltorios #[tauri::command] de la v0.1
//   comandos_v2    — envoltorios #[tauri::command] de la v0.2 y de estado
//   senales        — señales hacia la máquina de estados (interfaz congelada)
//   gestor         — crear / escribir / teclas / matar / historial / agentes
//   entrada        — vigilante de la pantalla: señales Pantalla, Progreso y Tick
//   lanzamiento    — argv de claude (--session-id, --permission-mode…), settings y entorno
//   pantalla       — pantalla emulada (vt100) de la TUI y su clasificación
//   proteccion     — aviso antes de salir con sesiones trabajando o con cola
//   recuperacion   — interrumpir, salir del menú, diálogos y modo de permisos
//   comandos_pty   — envoltorios #[tauri::command] del PTY
//   segundo_plano  — Ctrl+B sobre la herramienta en primer plano (§3.4)
//   forzar         — interrumpir y enviar por delante de la cola (§3.4)
//   comandos_forzar — envoltorios #[tauri::command] de los dos anteriores
//   motor          — registro y ejecución de tareas de motores externos
//   motor_sesion   — sesiones nativas de Codex y Gemini (sin Claude) y su
//                    persistencia; comandos en comandos_motor_sesion
//   motores        — localización y detección de Codex y Gemini (agy)
//   codex          — motor Codex local (con continuidad de hilo) y cloud
//   codex_parse    — interpretación de la salida JSON de codex exec
//   gemini         — motor Gemini por agy (stream-json por stdin)
//   intervencion   — intervenciones en el hilo con paquete de contexto
//   adjuntos       — adjuntos del composer y lectura de imágenes
//   mejorar        — /mejorar por el AI Router (zona light) hacia el composer
//   ganchos        — cola de un fichero de registro (read_tail)
//   proyecto       — bitácora del proyecto
//   ventana        — creación y foco de la ventana, protocolos propios
//   abrir_carpeta  — argumentos `--sesiones` y `--sesiones-cwd <ruta>`
//   cli_info       — CLI de claude fuera del PTY (mcp, plugins, auth)
//   workflows      — tarjeta en vivo de los runs de `Workflow` (journal,
//                    actividad de agentes, meta del script y JSON final)

// <WP-ESTADO>
pub mod agentes;
pub mod ajustes;
pub mod buzon;
pub mod catalogo;
pub mod cola;
pub mod comando_run;
pub mod comandos;
pub mod comandos_motor_sesion;
pub mod comandos_v2;
pub mod ediciones_turno;
pub mod ficheros;
pub mod historial;
pub mod lectura_final;
pub mod maquina;
pub mod mods;
pub mod pagina;
pub mod permiso_siempre;
pub mod persistencia;
pub mod preguntas;
pub mod puente;
pub mod puente_eventos;
pub mod registro;
pub mod relevo;
pub mod seguidor;
pub mod titulo;
pub mod transcript;
pub mod types;

#[cfg(test)]
mod test_sink;
#[cfg(test)]
mod tests_motor_cola;
#[cfg(test)]
mod tests_motor_sesion_guardado;
#[cfg(test)]
mod tests_puente;
#[cfg(test)]
mod tests_puente_v2;
#[cfg(test)]
mod tests_transcript;
// </WP-ESTADO>

// <WP-PTY>
pub mod caja;
pub mod comandos_forzar;
pub mod comandos_pty;
pub mod entrada;
pub mod forzar;
pub mod gestor;
pub mod incidentes;
pub mod lanzamiento;
pub mod pantalla;
pub mod proteccion;
pub mod recuperacion;
pub mod segundo_plano;
pub mod senales;
pub mod supervisor;
// </WP-PTY>

// <WP-MOTORES>
pub mod abrir_carpeta;
pub mod acp;
pub mod acp_normalizar;
pub mod adjuntos;
pub mod archivos;
pub mod barra_lateral;
pub mod cli_info;
pub mod codex;
pub mod codex_app;
pub mod codex_app_normalizar;
pub mod codex_parse;
pub mod exportar;
pub mod exportar_html;
pub mod foco_sesion;
pub mod ganchos;
pub mod gemini;
pub mod intervencion;
pub mod mejorar;
pub mod modelos;
pub mod motor;
pub mod motor_cola;
pub mod motor_eventos;
pub mod motor_sesion;
pub mod motor_stderr;
pub mod motor_vivo;
pub mod motores;
pub mod opencode;
pub mod opencode_entorno;
pub mod opencode_modelos;
pub mod opencode_parse;
pub mod proto_rpc;
pub mod proyecto;
pub mod ruta_fichero;
#[cfg(test)]
mod tests_opencode_real;
pub mod uso;
pub mod uso_externo;
pub mod uso_motores;
pub mod ventana;
pub mod ventana_icono;
pub mod voz;
pub mod workflows;
// </WP-MOTORES>

use std::sync::Arc;

use tauri::AppHandle;

/// Arranque en el setup de la app: instala el sink, levanta el puente,
/// restaura las sesiones abiertas al cerrar (registro y cola, antes del
/// seguidor de transcripts) y las relanza con `--resume` cuando la máquina
/// y el escritor ya están instalados. Los fallos se registran o se avisan y
/// no bloquean el arranque.
pub fn init(app: AppHandle) {
    let sink = registro::install(app.clone());
    let handler = Arc::new(puente_eventos::SesionesPuente::new(
        sink,
        preguntas::Broker::global(),
    ));
    match puente::start_global(handler) {
        Ok(info) => tracing::info!(url = %info.url, "puente de Sesiones escuchando"),
        Err(e) => tracing::error!(error = %e, "puente de Sesiones no disponible"),
    }
    let restauradas = persistencia::restaurar::restaurar();
    seguidor::start();
    // Máquina de estados (contrato v3 §1) y escritor real de la cola (§3).
    // Sin ellos, entrada.rs y gestor.rs caen en la reserva mínima y todo
    // envío de la cola falla con «escritor no instalado».
    senales::instalar(Box::new(registro::cableado::manejar_senal));
    cola::instalar_escritor(Arc::new(gestor::EscritorPty));
    persistencia::restaurar::relanzar(app, restauradas);
}
