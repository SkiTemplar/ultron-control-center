//! Catálogo y operaciones locales del motor, sin turnos de chat artificiales.
use super::super::types::{CommandDef, CommandKind};
use super::*;

fn definicion(nombre: &str, descripcion: &str, pista: Option<String>) -> CommandDef {
    CommandDef {
        name: nombre.trim_start_matches('/').into(),
        description: descripcion.into(),
        arg_hint: pista,
        source: "motor".into(),
        origin: None,
        kind: CommandKind::Prompt,
        panel: None,
        needs_args: false,
        immediate: false,
        note: None,
        aliases: Vec::new(),
    }
}

pub(super) fn propios() -> Vec<CommandDef> {
    [
        ("compact", "Compactar el hilo"),
        ("review", "Revisar cambios sin commitear"),
        ("clear", "Abrir un hilo nuevo"),
        ("rewind", "Quitar los últimos turnos"),
    ]
    .into_iter()
    .map(|(n, d)| definicion(n, d, (n == "rewind").then(|| "[n]".into())))
    .collect()
}

pub(super) fn desde_vivo(vivo: &Vivo) -> Vec<CommandDef> {
    vivo.estado
        .lock()
        .map(|e| {
            e.comandos
                .iter()
                .map(|c| definicion(&c.nombre, &c.descripcion, c.pista_argumento.clone()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn comandos(id: &str) -> Vec<CommandDef> {
    let codex = motor_sesion::get(id).is_ok_and(|s| s.engine == "codex");
    let mut items = if codex { propios() } else { Vec::new() };
    if let Some(vivo) = obtener(id).filter(|v| !v.cerrado.load(Ordering::Acquire)) {
        if let Cliente::Codex(c) = &vivo.cliente {
            if let Ok(r) = c.skills(PLAZO) {
                for entrada in r["data"].as_array().into_iter().flatten() {
                    for skill in entrada["skills"].as_array().into_iter().flatten() {
                        if let Some(nombre) = skill["name"].as_str() {
                            if !items.iter().any(|i| i.name == nombre) {
                                items.push(definicion(
                                    nombre,
                                    skill["description"].as_str().unwrap_or_default(),
                                    None,
                                ));
                            }
                        }
                    }
                }
            }
        } else {
            items.extend(desde_vivo(&vivo));
        }
    }
    items
}

pub(super) fn propio(texto: &str) -> Option<(&str, &str)> {
    let texto = texto.trim().strip_prefix('/')?;
    let (nombre, args) = texto.split_once(char::is_whitespace).unwrap_or((texto, ""));
    matches!(nombre, "compact" | "clear" | "rewind").then_some((nombre, args.trim()))
}

pub(super) fn ejecutar(id: &str, texto: &str, vivo: &Vivo) -> Result<bool, String> {
    let Cliente::Codex(c) = &vivo.cliente else {
        return Ok(false);
    };
    let Some((nombre, args)) = propio(texto) else {
        return Ok(false);
    };
    if vivo
        .estado
        .lock()
        .map_err(|e| e.to_string())?
        .turno
        .is_some()
    {
        return Err("no se puede ejecutar el comando con un turno en curso".into());
    }
    match nombre {
        "compact" => {
            c.compactar(PLAZO).map_err(|e| e.to_string())?;
        }
        "clear" => limpiar(id, vivo, c)?,
        "rewind" => rebobinar(id, vivo, c, args)?,
        _ => return Ok(false),
    }
    let resultado = match nombre {
        "compact" => "Compactación iniciada",
        "clear" => "Hilo nuevo creado; transcript anterior archivado",
        _ => "Turnos retirados del hilo; recorte del transcript archivado. Los cambios en ficheros no se deshacen",
    };
    vivo.notice(id, "info", resultado);
    Ok(true)
}

fn limpiar(
    id: &str,
    vivo: &Vivo,
    c: &super::super::codex_app::ClienteCodexApp,
) -> Result<(), String> {
    let s = motor_sesion::get(id)?;
    let politica = super::super::codex_app::PoliticaCodex::desde_modo(s.permission_mode)?;
    let r = c
        .nuevo_hilo(&s.cwd, politica, PLAZO)
        .map_err(|e| e.to_string())?;
    let hilo = r["thread"]["id"]
        .as_str()
        .ok_or("Codex no devolvió hilo nuevo")?;
    transcript::archivar(id)?;
    motor::retirar_turnos(id);
    motor_sesion::fijar_hilo(id, hilo)?;
    vivo.emitir(ev::RESET, json!({"id":id}));
    Ok(())
}

fn rebobinar(
    id: &str,
    vivo: &Vivo,
    c: &super::super::codex_app::ClienteCodexApp,
    args: &str,
) -> Result<(), String> {
    let n = if args.is_empty() {
        1
    } else {
        args.parse::<usize>()
            .map_err(|_| "rewind requiere un entero ≥ 1")?
    };
    if n == 0 {
        return Err("rewind requiere un entero ≥ 1".into());
    }
    let mensajes = transcript::leer(id)?.unwrap_or_default();
    let usuarios = mensajes.iter().filter(|m| m.role == "user").count();
    if n > usuarios {
        return Err(format!(
            "rewind {n}: el hilo solo tiene {usuarios} turno(s) en el transcript"
        ));
    }
    let indice = mensajes
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, m)| m.role == "user")
        .nth(n - 1)
        .map_or(0, |(i, _)| i);
    c.rebobinar(n, PLAZO).map_err(|e| e.to_string())?;
    transcript::recortar(id, &mensajes, indice)?;
    vivo.emitir(ev::RESET, json!({"id":id}));
    Ok(())
}

pub fn dirigir(id: &str, item: &super::super::types::QueueItem) -> Result<(), String> {
    let vivo = obtener(id).ok_or("no hay proceso Codex vivo")?;
    let Cliente::Codex(c) = &vivo.cliente else {
        return Err(super::super::motor_cola::ERROR_ACP.into());
    };
    let (imagenes, archivos) =
        super::super::intervencion::split_attachments("codex", &item.attachments);
    let texto = super::super::intervencion::with_attachment_list(&item.text, &archivos);
    let imagenes: Vec<_> = imagenes
        .into_iter()
        .map(super::super::codex_app::ImagenCodex::Local)
        .collect();
    c.steer(&texto, &imagenes, PLAZO)
        .map_err(|e| e.to_string())?;
    let mut usuario = transcript::usuario(&item.text, &item.attachments);
    usuario.client_id = Some(item.client_id.clone());
    transcript::anexar(id, std::slice::from_ref(&usuario))?;
    vivo.emitir(ev::MESSAGES, json!({"id":id,"messages":[usuario]}));
    Ok(())
}
