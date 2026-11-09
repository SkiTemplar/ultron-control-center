//! Lanzamiento y negociación de los servidores persistentes.
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::Stdio;
use std::sync::{mpsc::Sender, Arc};
use std::time::{Duration, Instant};

use super::super::motor_eventos::EventoMotor;
use super::super::motor_sesion::SesionMotor;
use super::super::{
    acp::ClienteAcp,
    cli_info::Trabajo,
    codex_app::{ClienteCodexApp, PoliticaCodex},
    motores, opencode_entorno,
};
use serde_json::Value;

/// Frontera inyectable: los tests aportan tuberías en memoria y cierre observable.
pub struct Conexion {
    pub lector: Box<dyn BufRead + Send>,
    pub escritor: Box<dyn Write + Send>,
    pub cerrar: Box<dyn FnOnce() + Send>,
}

pub type Lanzador<'a> = &'a dyn Fn(&SesionMotor) -> Result<Conexion, String>;

pub(super) enum Cliente {
    Codex(ClienteCodexApp),
    Acp(ClienteAcp),
}

impl Cliente {
    pub(super) fn nuevo(
        s: &SesionMotor,
        c: Conexion,
        eventos: Sender<EventoMotor>,
    ) -> (Self, Box<dyn FnOnce() + Send>) {
        let lector = BufReader::new(Vigilado {
            lector: c.lector,
            eventos: eventos.clone(),
            cerrado: false,
        });
        let emitir = move |e| {
            let _ = eventos.send(e);
        };
        let cliente = if s.engine == "codex" {
            Self::Codex(ClienteCodexApp::nuevo(lector, c.escritor, emitir))
        } else {
            Self::Acp(ClienteAcp::nuevo(lector, c.escritor, emitir))
        };
        (cliente, c.cerrar)
    }

    pub(super) fn iniciar(&self, s: &SesionMotor) -> Result<String, String> {
        let fin = Instant::now() + Duration::from_secs(30);
        let plazo = || fin.saturating_duration_since(Instant::now());
        let resultado = match self {
            Self::Codex(c) => {
                let politica = PoliticaCodex::desde_modo(s.permission_mode)?;
                c.establecer_politica(politica, &s.cwd)
                    .map_err(|e| e.to_string())?;
                c.iniciar(plazo()).map_err(|e| e.to_string())?;
                let r = match &s.thread_id {
                    Some(id) => c.retomar_con_politica(id, &s.cwd, politica, plazo()),
                    None => c.nuevo_hilo(&s.cwd, politica, plazo()),
                }
                .map_err(|e| e.to_string())?;
                r["thread"]["id"].as_str().map(str::to_string)
            }
            Self::Acp(c) => {
                c.initialize(plazo()).map_err(|e| e.to_string())?;
                let r = match &s.thread_id {
                    Some(id) => c.cargar_sesion(id, &s.cwd, plazo()),
                    None => c.nueva_sesion(&s.cwd, plazo()),
                }
                .map_err(|e| e.to_string())?;
                configurar_acp(c, s, &r, &plazo)?;
                s.thread_id
                    .clone()
                    .or_else(|| r["sessionId"].as_str().map(str::to_string))
            }
        };
        resultado.ok_or_else(|| "respuesta de arranque sin id de hilo".into())
    }
}

fn configurar_acp(
    c: &ClienteAcp,
    s: &SesionMotor,
    r: &Value,
    plazo: &dyn Fn() -> Duration,
) -> Result<(), String> {
    let modo = modo_acp(&s.engine, s.permission_mode, r)?;
    c.establecer_modo(&modo, plazo())
        .map_err(|e| e.to_string())?;
    if let Some(modelo) = &s.model {
        c.establecer_modelo(modelo, plazo())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn modo_acp(
    engine: &str,
    mode: super::super::types::PermissionMode,
    r: &Value,
) -> Result<String, String> {
    use super::super::types::PermissionMode;
    let modos = r.pointer("/modes/availableModes").and_then(Value::as_array);
    // OpenCode no tiene modos de permisos: sus agentes `build` y `plan` arrancan
    // con `*: allow`. Las reglas de cada modo van en `OPENCODE_PERMISSION` al
    // lanzar el proceso (`opencode::permisos_sesion`); aquí solo se elige agente.
    // Bypass, en un motor sin modo propio, cae al modo de edición más amplio:
    // `permisos::permiso` aprueba solo cada petición mientras la sesión esté en
    // bypass, así que el efecto es el mismo y el motor no falla al arrancar.
    let candidatos: &[&str] = match mode {
        PermissionMode::Plan if engine == "opencode" => &["plan"],
        PermissionMode::Default
        | PermissionMode::AcceptEdits
        | PermissionMode::BypassPermissions
            if engine == "opencode" =>
        {
            &["build"]
        }
        PermissionMode::Default => &["default"],
        PermissionMode::AcceptEdits => &["accept-edits", "acceptEdits"],
        PermissionMode::Plan => &["plan"],
        PermissionMode::BypassPermissions => &[
            "bypassPermissions",
            "bypass-permissions",
            "yolo",
            "accept-edits",
            "acceptEdits",
        ],
        _ => &[],
    };
    let elegido = candidatos.iter().find_map(|id| {
        modos?
            .iter()
            .find(|m| m["id"] == *id)
            .and_then(|m| m["id"].as_str())
            .map(str::to_string)
    });
    elegido.ok_or_else(|| {
        format!(
            "{engine} no anuncia un modo equivalente a {}",
            super::super::lanzamiento::modo_cli(mode)
        )
    })
}

pub(super) fn lanzar(s: &SesionMotor) -> Result<Conexion, String> {
    let programa = programa(&s.engine)?;
    let mut cmd = motores::command_for_task(&programa, &s.cwd);
    if s.engine == "opencode" {
        let claves = opencode_entorno::claves_para(
            opencode_entorno::claves(),
            super::super::motor::KIND_CHAT,
            s.model.as_deref(),
        );
        opencode_entorno::inyectar(&mut cmd, &claves);
        if let Some(reglas) = super::super::opencode::permisos_sesion(s.permission_mode) {
            cmd.env(super::super::opencode::VAR_PERMISOS, reglas);
        }
    }
    cmd.arg(if s.engine == "codex" {
        "app-server"
    } else {
        "acp"
    })
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    conectar(cmd.spawn().map_err(|e| e.to_string())?)
}

fn programa(engine: &str) -> Result<motores::Program, String> {
    match engine {
        "codex" => motores::codex_program(),
        "opencode" => opencode_entorno::opencode_program(),
        _ => {
            let (cli, p) = motores::gemini_program()?;
            if cli != motores::GeminiCli::Agy {
                return Err("Gemini de npm no ofrece ACP; se usa exec".into());
            }
            Ok(p)
        }
    }
}

pub(super) fn conectar(mut hijo: std::process::Child) -> Result<Conexion, String> {
    let trabajo = match Trabajo::para(&hijo) {
        Ok(t) => t,
        Err(e) => {
            let _ = hijo.kill();
            let _ = hijo.wait();
            return Err(e);
        }
    };
    let lector = hijo.stdout.take().ok_or("proceso sin stdout")?;
    let escritor = hijo.stdin.take().ok_or("proceso sin stdin")?;
    if let Some(stderr) = hijo.stderr.take() {
        std::thread::spawn(move || {
            for linea in BufReader::new(stderr).lines().map_while(Result::ok) {
                tracing::debug!(%linea, "stderr de motor persistente");
            }
        });
    }
    let hijo = Arc::new(std::sync::Mutex::new(hijo));
    Ok(Conexion {
        lector: Box::new(BufReader::new(lector)),
        escritor: Box::new(escritor),
        cerrar: Box::new(move || {
            let _ = trabajo.terminar();
            if let Ok(mut hijo) = hijo.lock() {
                let _ = hijo.kill();
                let _ = hijo.wait();
            }
        }),
    })
}

struct Vigilado {
    lector: Box<dyn BufRead + Send>,
    eventos: Sender<EventoMotor>,
    cerrado: bool,
}
impl Read for Vigilado {
    fn read(&mut self, datos: &mut [u8]) -> io::Result<usize> {
        let resultado = self.lector.read(datos);
        if !datos.is_empty() && !self.cerrado && matches!(&resultado, Ok(0) | Err(_)) {
            self.cerrado = true;
            let _ = self.eventos.send(EventoMotor::Error(
                "Canal RPC cerrado: el proceso terminó".into(),
            ));
        }
        resultado
    }
}
