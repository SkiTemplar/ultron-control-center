// mar.ia — encargos: varios agentes trabajando a la vez para la misma conversacion.
//
// Pedido del usuario (2026-09-21): "que pueda mandar a codex o antigravity hacer
// una cosa mientras claude trabaja en otra... un entorno compartido y de
// multiagentes". El relevo es UNO detras de otro; esto es VARIOS a la vez.
//
// Un encargo es un trabajo que se le da a un proveedor concreto y corre en
// segundo plano mientras el chat sigue libre. Lo que lo hace "compartido":
//
//   * CARPETA DE TRABAJO comun por hilo (`<hilo>.trabajo/`): todos los agentes
//     arrancan ahi, asi que lo que deja uno lo encuentra el otro.
//   * TABLERO.md dentro de ella: una linea por encargo con quien lo lleva y en
//     que estado esta. Cada agente lo recibe al empezar, para no pisarse.
//   * EL HILO: al acabar, el resultado entra en la conversacion como un turno
//     mas, firmado por quien lo hizo. El siguiente mensaje del chat ya lo ve.
//
// LIMITES DECLARADOS: los agentes no se hablan entre si en directo; se
// coordinan por el tablero y los ficheros. Y un encargo no reanuda sesion: cada
// uno es un trabajo cerrado con el contexto del hilo por delante.

use std::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;

use super::relay::{self, recorta, Adjuntos, Turn};

pub const EVENTO: &str = "maria://encargo";
/// Encargos simultaneos por conversacion. Mas que esto es pelearse por la cuota
/// y por la GPU, no ir mas rapido.
const MAX_A_LA_VEZ: usize = 4;

#[derive(Debug, Clone, Serialize)]
pub struct Encargo {
    pub id: String,
    pub thread_id: String,
    pub provider: String,
    pub texto: String,
    /// "en_curso" | "hecho" | "error" | "parado".
    pub estado: String,
    pub creado: String,
    pub fin: String,
    /// Resultado o motivo del fallo, recortado: el completo esta en el hilo.
    pub resumen: String,
}

static ENCARGOS: Mutex<Vec<Encargo>> = Mutex::new(Vec::new());

fn con<R>(f: impl FnOnce(&mut Vec<Encargo>) -> R) -> R {
    let mut g = ENCARGOS.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut g)
}

/// Clave con la que un encargo emite su texto y se deja parar.
#[must_use]
pub fn clave(thread_id: &str, id: &str) -> String {
    format!("{thread_id}#{id}")
}

fn emitir(e: &Encargo) {
    if let Some(app) = super::flujo::app() {
        let _ = app.emit(EVENTO, e);
    }
}

/// Linea del tablero para un encargo. Pura.
#[must_use]
pub fn linea_tablero(e: &Encargo) -> String {
    let marca = match e.estado.as_str() {
        "hecho" => "x",
        "error" | "parado" => "!",
        _ => " ",
    };
    format!(
        "- [{marca}] `{}` · {} · {} · {}",
        e.id,
        e.provider,
        e.estado,
        recorta(&e.texto.replace('\n', " "), 140)
    )
}

/// Reescribe TABLERO.md con el estado actual de los encargos de este hilo.
fn escribir_tablero(thread_id: &str) {
    let Ok(dir) = relay::carpeta_de_trabajo(thread_id) else {
        return;
    };
    let lineas: Vec<String> = con(|v| {
        v.iter()
            .filter(|e| e.thread_id == thread_id)
            .map(linea_tablero)
            .collect()
    });
    let cuerpo = format!(
        "# Tablero de la conversacion\n\nQuien esta haciendo que. `[ ]` en curso, `[x]` hecho, `[!]` fallo o se paro.\n\n{}\n",
        lineas.join("\n")
    );
    let _ = std::fs::write(dir.join("TABLERO.md"), cuerpo);
}

/// El mensaje que recibe el agente: entorno, tablero, conversacion y encargo. Pura.
#[must_use]
pub fn componer(manual: &str, skills: &str, tablero: &str, contexto: &str, texto: &str) -> String {
    let mut out = String::new();
    out.push_str(manual);
    out.push_str(skills);
    if !tablero.trim().is_empty() {
        out.push_str("[tablero — otros agentes trabajan a la vez que tu; no repitas lo suyo]\n");
        out.push_str(tablero.trim());
        out.push_str("\n\n");
    }
    out.push_str(contexto);
    out.push_str("[encargo]\n");
    out.push_str(texto.trim());
    out.push_str(
        "\n\nTrabaja por tu cuenta hasta terminarlo. Si produces ficheros, dejalos en la carpeta \
         de trabajo. Acaba con un resumen breve de lo que has hecho y donde esta.",
    );
    out
}

pub fn lanzar(thread_id: &str, provider: &str, texto: &str) -> Result<Encargo, String> {
    let texto = texto.trim();
    if texto.is_empty() {
        return Err("el encargo esta vacio".into());
    }
    let cfg = relay::load_config();
    if !cfg.order.iter().any(|p| p == provider) {
        return Err(format!(
            "no conozco al proveedor «{provider}» (hay: {})",
            cfg.order.join(", ")
        ));
    }
    if cfg.disabled.iter().any(|p| p == provider) {
        return Err(format!("{provider} esta apagado en el relevo"));
    }
    let en_curso = con(|v| {
        v.iter()
            .filter(|e| e.thread_id == thread_id && e.estado == "en_curso")
            .count()
    });
    if en_curso >= MAX_A_LA_VEZ {
        return Err(format!(
            "ya hay {MAX_A_LA_VEZ} encargos en marcha en esta conversacion; espera a que acabe alguno"
        ));
    }
    let trabajo = relay::carpeta_de_trabajo(thread_id)?;
    let turnos = relay::read_thread(thread_id)?;

    let encargo = Encargo {
        id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        thread_id: thread_id.to_string(),
        provider: provider.to_string(),
        texto: texto.to_string(),
        estado: "en_curso".into(),
        creado: chrono::Utc::now().to_rfc3339(),
        fin: String::new(),
        resumen: String::new(),
    };
    con(|v| v.push(encargo.clone()));
    escribir_tablero(thread_id);
    emitir(&encargo);

    let e = encargo.clone();
    std::thread::spawn(move || {
        let ajustes = crate::maria::criterio::cargar();
        let tablero = std::fs::read_to_string(trabajo.join("TABLERO.md")).unwrap_or_default();
        let skills = if ajustes.compartir_skills && e.provider != "claude" {
            super::capacidades::indice_skills(&e.texto)
        } else {
            String::new()
        };
        let cuerpo = componer(
            &super::capacidades::manual(Some(&trabajo), ajustes.acceso_total),
            &skills,
            &tablero,
            &relay::build_context(&turnos, relay::memoria_para(&e.texto).as_deref()),
            &e.texto,
        );
        let k = clave(&e.thread_id, &e.id);
        super::flujo::limpiar(&k);
        let modelo = crate::maria::models::modelo_por_defecto(&e.provider);
        let sin_adjuntos = Adjuntos::default();
        let r = if e.provider == "local" {
            let _en_uso = crate::maria::local::EnUso::nuevo();
            super::local_agente::responder(
                &k,
                &cuerpo,
                "medio",
                &sin_adjuntos,
                ajustes.acceso_total,
                Some(&trabajo),
            )
        } else {
            super::cli::ejecutar(&super::cli::Peticion {
                clave: &k,
                provider: &e.provider,
                prompt: &cuerpo,
                model: &modelo,
                effort: "medio",
                ajustes: &super::cli::Ajustes {
                    ligero: ajustes.claude_ligero,
                    acceso_total: ajustes.acceso_total,
                    mcp_config: super::capacidades::fichero_mcp_chat(&ajustes.claude_mcps),
                },
                adjuntos: &sin_adjuntos,
                sesion: super::cli::Sesion::Ninguna,
                cwd: Some(trabajo.clone()),
            })
            .map(|r| r.texto)
        };
        let parado = super::flujo::cancelado(&k);
        super::flujo::limpiar(&k);

        let (estado, texto_final) = match r {
            Ok(t) if parado => ("parado", t),
            Ok(t) => ("hecho", t),
            Err(_) if parado => ("parado", "parado antes de producir nada".to_string()),
            Err((motivo, _)) => ("error", motivo),
        };
        // El resultado entra en la conversacion, firmado por quien lo hizo.
        let cabecera = match estado {
            "hecho" => format!("**Encargo `{}` terminado**", e.id),
            "parado" => format!("**Encargo `{}` parado**", e.id),
            _ => format!("**Encargo `{}` fallido**", e.id),
        };
        let _ = relay::append_turn(
            &e.thread_id,
            &Turn {
                ts: chrono::Utc::now().to_rfc3339(),
                role: "assistant".into(),
                provider: e.provider.clone(),
                model: modelo,
                effort: "medio".into(),
                text: format!("{cabecera} — _{}_\n\n{texto_final}", recorta(&e.texto, 160)),
            },
        );
        let hecho = con(|v| {
            v.iter_mut().find(|x| x.id == e.id).map(|x| {
                x.estado = estado.to_string();
                x.fin = chrono::Utc::now().to_rfc3339();
                x.resumen = recorta(&texto_final, 300);
                x.clone()
            })
        });
        escribir_tablero(&e.thread_id);
        crate::maria::threads::touch(&e.thread_id);
        if let Some(h) = hecho {
            emitir(&h);
        }
    });
    Ok(encargo)
}

#[tauri::command]
pub async fn maria_encargo_lanzar(
    thread_id: String,
    provider: String,
    texto: String,
) -> Result<Encargo, String> {
    tauri::async_runtime::spawn_blocking(move || lanzar(&thread_id, &provider, &texto))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn maria_encargos(thread_id: String) -> Result<Vec<Encargo>, String> {
    Ok(con(|v| {
        v.iter()
            .filter(|e| e.thread_id == thread_id)
            .cloned()
            .collect()
    }))
}

#[tauri::command]
pub async fn maria_encargo_cancelar(thread_id: String, id: String) -> Result<(), String> {
    super::flujo::cancelar(&clave(&thread_id, &id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(estado: &str) -> Encargo {
        Encargo {
            id: "ab12cd34".into(),
            thread_id: "hilo".into(),
            provider: "codex".into(),
            texto: "genera el indice\ndel libro".into(),
            estado: estado.into(),
            creado: String::new(),
            fin: String::new(),
            resumen: String::new(),
        }
    }

    #[test]
    fn el_tablero_marca_el_estado_y_cabe_en_una_linea() {
        assert!(linea_tablero(&e("en_curso")).starts_with("- [ ] `ab12cd34` · codex"));
        assert!(linea_tablero(&e("hecho")).starts_with("- [x]"));
        assert!(linea_tablero(&e("error")).starts_with("- [!]"));
        assert!(!linea_tablero(&e("hecho")).contains('\n'));
    }

    #[test]
    fn el_mensaje_lleva_tablero_contexto_y_encargo_en_ese_orden() {
        let m = componer(
            "[entorno]\n",
            "",
            "- [ ] `x` · claude",
            "[hilo]\n",
            "haz el esquema",
        );
        let t = m.find("[tablero").unwrap();
        let h = m.find("[hilo]").unwrap();
        let g = m.find("[encargo]").unwrap();
        assert!(t < h && h < g);
        assert!(m.contains("haz el esquema"));
        // Sin tablero no se inventa la seccion.
        assert!(!componer("", "", "  ", "", "x").contains("[tablero"));
    }

    #[test]
    fn un_encargo_vacio_o_a_un_desconocido_no_arranca() {
        assert!(lanzar("hilo-test-encargos", "claude", "   ").is_err());
        assert!(lanzar("hilo-test-encargos", "skynet", "haz algo").is_err());
    }

    #[test]
    fn la_clave_de_un_encargo_no_choca_con_la_del_hilo() {
        assert_eq!(clave("hilo", "ab12"), "hilo#ab12");
        assert_ne!(clave("hilo", "ab12"), "hilo");
    }
}
