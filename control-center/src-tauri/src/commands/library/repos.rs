//! Comandos de "Destacados": descubrir repositorios, ver QUE traen y aplicarlos.
//!
//! 2026-09-22. Son la cara visible de `maria::repos`. Aqui solo hay tres cosas:
//! validar lo que llega de la interfaz, sacar el trabajo bloqueante del runtime
//! asincrono (la capa HTTP es `reqwest::blocking`, como el resto del crate) y
//! engancharse a la integracion post-instalacion que ya existia.

use crate::maria::repos::{
    self, DetalleRepo, Fuente, PlanAplicar, RespuestaBusqueda, ResultadoAplicar, TipoRepo,
};

#[derive(serde::Deserialize)]
pub struct BuscarArgs {
    /// `oficiales` | `en_alza` | `mejor_valorados` | `skills` | `agentes` | `mcps` | `libre`.
    pub fuente: String,
    #[serde(default)]
    pub consulta: Option<String>,
    #[serde(default)]
    pub limite: Option<u32>,
    /// Salta la cache. Es lo que hace el boton "Refrescar", y lo unico que
    /// gasta cuota a peticion del usuario.
    #[serde(default)]
    pub refrescar: bool,
}

/// Una fuente de repositorios. Nunca devuelve `Err` por cuota agotada: eso
/// viaja dentro de la respuesta (`cuota.agotada` + `avisos`) porque en la
/// interfaz es otra pantalla, no un fallo.
#[tauri::command]
pub async fn repos_buscar(args: BuscarArgs) -> Result<RespuestaBusqueda, String> {
    let fuente = Fuente::de_id(args.fuente.trim())
        .ok_or_else(|| format!("fuente desconocida: {}", args.fuente))?;
    let libre = args.consulta.unwrap_or_default();
    let limite = args.limite.unwrap_or(30);
    tauri::async_runtime::spawn_blocking(move || {
        repos::buscar(fuente, &libre, limite, args.refrescar)
    })
    .await
    .map_err(|e| format!("spawn join: {e}"))
}

/// Que trae un repositorio, leyendo SOLO la lista de rutas de su arbol. No
/// descarga contenido y no ejecuta nada: es lo que el usuario ve antes de
/// decidir.
#[tauri::command]
pub async fn repos_detalle(
    owner: String,
    repo: String,
    refrescar: Option<bool>,
) -> Result<DetalleRepo, String> {
    let refrescar = refrescar.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || repos::detalle(&owner, &repo, refrescar))
        .await
        .map_err(|e| format!("spawn join: {e}"))?
}

/// Aplica un plan que el usuario ya ha visto. El backend lo vuelve a validar
/// entero: el plan viene de la interfaz, y la interfaz recibio datos de un
/// tercero.
#[tauri::command]
pub async fn repos_aplicar(plan: PlanAplicar) -> Result<ResultadoAplicar, String> {
    let etiqueta = format!("{}/{}", plan.owner, plan.repo);
    let project_id = if plan.destino == "project" {
        plan.project_id.clone()
    } else {
        None
    };
    // Solo skills y agentes dejan ficheros en disco; para el resto no hay nada
    // que sincronizar con el catalogo de routing.
    let integrar = matches!(plan.tipo, TipoRepo::Skill | TipoRepo::Agente);

    let resultado = tauri::async_runtime::spawn_blocking(move || repos::aplicar(plan))
        .await
        .map_err(|e| format!("spawn join: {e}"))??;

    if integrar && !resultado.escritos.is_empty() {
        // Best-effort, igual que en el camino de instalacion de un fichero
        // suelto: sincroniza el catalogo de routing y propone un candidato de
        // memoria. Un fallo aqui NO convierte una instalacion buena en mala.
        let assets = resultado.assets.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            super::post_install::post_install_integrate(&etiqueta, &assets, project_id.as_deref())
        })
        .await;
    }

    Ok(resultado)
}
