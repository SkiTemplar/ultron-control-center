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
//
// SOBREVIVIR AL CIERRE (2026-09-22). Hasta hoy la lista vivia SOLO en el Mutex
// de abajo y el trabajo corria en un `std::thread::spawn`: al cerrar la app las
// dos cosas morian, `maria_encargos` volvia vacio y TABLERO.md conservaba para
// siempre la linea `· en_curso` de un agente que ya no existia. Y ese tablero
// se le inyecta a CADA agente nuevo (ver `componer`), asi que la mentira se
// propagaba al contexto. Ahora la lista se guarda en `<hilo>.trabajo/encargos.json`
// en cada cambio de estado y, al arrancar, lo que quedo `en_curso` pasa a
// `interrumpido` — en el fichero y en el tablero — con un boton para relanzarlo.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use super::relay::{self, recorta, Adjuntos, Turn};

pub const EVENTO: &str = "maria://encargo";
/// Encargos simultaneos por conversacion. Mas que esto es pelearse por la cuota
/// y por la GPU, no ir mas rapido.
const MAX_A_LA_VEZ: usize = 4;

/// Estado al que pasa, al arrancar, lo que quedo a medias cuando se cerro la
/// aplicacion. No es un fallo del proveedor: es que le cortaron la luz.
pub const INTERRUMPIDO: &str = "interrumpido";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Encargo {
    pub id: String,
    pub thread_id: String,
    pub provider: String,
    pub texto: String,
    /// "en_curso" | "hecho" | "error" | "parado" | "interrumpido".
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
        "error" | "parado" | INTERRUMPIDO => "!",
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

// ---------------------------------------------------------------------------
// Que queda en disco
// ---------------------------------------------------------------------------

/// Fichero de encargos de una carpeta de trabajo.
fn fichero_en(dir: &Path) -> PathBuf {
    dir.join("encargos.json")
}

/// Lee los encargos guardados. Un fichero que no esta, o que no parsea,
/// devuelve la lista vacia: un json corrupto no puede impedir que mar.ia
/// arranque ni que el hilo siga usandose.
fn leer_en(dir: &Path) -> Vec<Encargo> {
    std::fs::read_to_string(fichero_en(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Encargo>>(&t).ok())
        .unwrap_or_default()
}

/// Escribe la lista con temporal + rename.
///
/// Dos instancias de mar.ia escribiendo el mismo fichero es el unico riesgo
/// real aqui: con el rename atomico gana la ultima ENTERA, nunca media. No hay
/// edicion concurrente de verdad — a cada encargo lo toca solo su hilo.
fn guardar_en(dir: &Path, v: &[Encargo]) {
    let Ok(texto) = serde_json::to_string_pretty(v) else {
        return;
    };
    let path = fichero_en(dir);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, texto).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Reescribe TABLERO.md con la lista que se le da.
fn escribir_tablero_en(dir: &Path, v: &[Encargo]) {
    let lineas: Vec<String> = v.iter().map(linea_tablero).collect();
    let cuerpo = format!(
        "# Tablero de la conversacion\n\nQuien esta haciendo que. `[ ]` en curso, `[x]` hecho, `[!]` fallo, se paro o se interrumpio.\n\n{}\n",
        lineas.join("\n")
    );
    let _ = std::fs::write(dir.join("TABLERO.md"), cuerpo);
}

/// Deja en disco el estado de los encargos de este hilo: fichero y tablero.
/// Se llama en CADA cambio de estado; si no, el tablero miente.
fn persistir(thread_id: &str) {
    let Ok(dir) = relay::carpeta_de_trabajo(thread_id) else {
        return;
    };
    let mios: Vec<Encargo> = con(|v| {
        v.iter()
            .filter(|e| e.thread_id == thread_id)
            .cloned()
            .collect()
    });
    guardar_en(&dir, &mios);
    escribir_tablero_en(&dir, &mios);
}

/// Lo que quedo `en_curso` en el fichero murio con el proceso: el trabajo corre
/// en un `std::thread::spawn` que no sobrevive al cierre de la aplicacion.
/// Pura.
#[must_use]
pub fn marcar_interrumpidos(mut v: Vec<Encargo>, ahora: &str) -> Vec<Encargo> {
    for e in &mut v {
        if e.estado == "en_curso" {
            e.estado = INTERRUMPIDO.to_string();
            e.fin = ahora.to_string();
            e.resumen = "mar.ia se cerro mientras corria; no llego a terminar".into();
        }
    }
    v
}

/// Recupera una carpeta de trabajo: marca lo interrumpido y deja fichero y
/// tablero al dia. Devuelve la lista ya corregida.
fn recuperar_en(dir: &Path) -> Vec<Encargo> {
    let guardados = leer_en(dir);
    if guardados.is_empty() {
        return guardados;
    }
    let corregidos = marcar_interrumpidos(guardados, &chrono::Utc::now().to_rfc3339());
    guardar_en(dir, &corregidos);
    escribir_tablero_en(dir, &corregidos);
    corregidos
}

/// Al arrancar: recorre las carpetas de trabajo, pasa a `interrumpido` lo que
/// quedo a medias y devuelve los encargos a la lista en memoria. Devuelve
/// cuantos quedaron interrumpidos.
///
/// Best-effort a proposito: un hilo con el fichero ilegible se salta y los
/// demas siguen. Nada de esto puede impedir que la aplicacion abra.
pub fn recuperar_todos() -> usize {
    let Ok(raiz) = relay::maria_dir() else {
        return 0;
    };
    let Ok(entradas) = std::fs::read_dir(raiz.join("threads")) else {
        return 0;
    };
    let mut rotos = 0;
    for entrada in entradas.flatten() {
        let dir = entrada.path();
        if !dir.is_dir() || dir.extension().and_then(|x| x.to_str()) != Some("trabajo") {
            continue;
        }
        for e in recuperar_en(&dir) {
            if e.estado == INTERRUMPIDO {
                rotos += 1;
            }
            con(|v| {
                if !v.iter().any(|x| x.id == e.id && x.thread_id == e.thread_id) {
                    v.push(e.clone());
                }
            });
        }
    }
    rotos
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
    persistir(thread_id);
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
        // Lo que cuesta el encargo se apunta igual que el de un turno normal:
        // es el mismo proveedor y la misma cuota, solo que en paralelo.
        let reloj = std::time::Instant::now();
        let mut consumo = super::cli::Consumo::default();
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
            .map(|r| {
                consumo = r.consumo;
                r.texto
            })
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
                tokens_in: consumo.tokens_in,
                tokens_out: consumo.tokens_out,
                coste_usd: consumo.coste_usd,
                ms: Some(reloj.elapsed().as_millis() as u64),
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
        persistir(&e.thread_id);
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

/// Quita un encargo terminado de la lista y del disco.
///
/// Hasta que los encargos se guardaron, la «×» de la tira del chat solo lo
/// borraba de la pantalla; ahora que sobreviven al cierre, borrarlo solo de la
/// vista seria un boton que no hace nada (mandamiento 11).
#[tauri::command]
pub async fn maria_encargo_olvidar(thread_id: String, id: String) -> Result<(), String> {
    let en_curso = con(|v| {
        v.iter()
            .any(|e| e.thread_id == thread_id && e.id == id && e.estado == "en_curso")
    });
    if en_curso {
        return Err("ese encargo sigue en marcha: paralo antes de quitarlo".into());
    }
    con(|v| v.retain(|e| !(e.thread_id == thread_id && e.id == id)));
    persistir(&thread_id);
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
        assert!(linea_tablero(&e(INTERRUMPIDO)).starts_with("- [!]"));
        assert!(!linea_tablero(&e("hecho")).contains('\n'));
    }

    #[test]
    fn lo_que_quedaba_en_curso_al_cerrar_vuelve_interrumpido() {
        let v = marcar_interrumpidos(
            vec![e("en_curso"), e("hecho"), e("error")],
            "2026-09-22T10:00:00Z",
        );
        assert_eq!(v[0].estado, INTERRUMPIDO);
        assert_eq!(v[0].fin, "2026-09-22T10:00:00Z");
        assert!(!v[0].resumen.is_empty(), "tiene que decir por que murio");
        // Lo que ya habia terminado no se toca: seria reescribir la historia.
        assert_eq!(v[1].estado, "hecho");
        assert_eq!(v[2].estado, "error");
        assert!(v[1].fin.is_empty());
    }

    #[test]
    fn recuperar_deja_el_fichero_y_el_tablero_sin_mentiras() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let mut vivo = e("en_curso");
        vivo.id = "aaaa1111".into();
        let mut listo = e("hecho");
        listo.id = "bbbb2222".into();
        guardar_en(dir, &[vivo, listo]);

        let tras = recuperar_en(dir);
        assert_eq!(tras[0].estado, INTERRUMPIDO);
        assert_eq!(tras[1].estado, "hecho");
        // Y lo que se recupera es lo que quedo escrito, no solo lo devuelto.
        assert_eq!(leer_en(dir), tras);
        let tablero = std::fs::read_to_string(dir.join("TABLERO.md")).expect("tablero");
        assert!(tablero.contains("- [!] `aaaa1111`"), "{tablero}");
        assert!(tablero.contains("- [x] `bbbb2222`"), "{tablero}");
        assert!(
            !tablero.contains("en_curso"),
            "el tablero seguia diciendo que alguien trabaja: {tablero}"
        );
    }

    #[test]
    fn un_fichero_corrupto_o_ausente_no_rompe_la_recuperacion() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Caso negativo 1: no hay fichero.
        assert!(recuperar_en(tmp.path()).is_empty());
        // Caso negativo 2: lo hay, pero no es la lista que esperamos.
        std::fs::write(fichero_en(tmp.path()), "{esto no es json").expect("escribir");
        assert!(recuperar_en(tmp.path()).is_empty());
        // Y no se ha inventado un tablero a partir de basura.
        assert!(!tmp.path().join("TABLERO.md").exists());
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
