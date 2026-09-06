//! profile_llm.rs — perfil de proyecto destilado al cerrar sesión (ULTRON 4,
//! F1.4 / G9: "¿de qué iba este proyecto?" respondido desde el resume).
//!
//! Decisión 2026-09-03: el hook `project-profile` (SessionEnd) manda al daemon
//! lo que sabe del repositorio (cabecera de CLAUDE.md/README, manifiestos,
//! estado del kanban, últimos commits) y el daemon lo junta con la memoria del
//! proyecto (decisiones, restricciones, arquitectura, lecciones y resúmenes de
//! sesión) para pedir a la cadena de proveedores de `skill_llm` UN perfil con
//! forma fija: qué es, stack, arquitectura, estado y decisiones clave. El hook
//! lo guarda en `cockpit/projects/<id>/profile.json` y el resume de
//! `SessionStart` lo inyecta tal cual.
//!
//! Sustituye a la captura `kind=context` de `stop-compress-session`, que
//! acumulaba frases sueltas ("Kanban card updated", "UE 5.6 instalado") y
//! contaminación de otros proyectos sin responder nunca qué era el proyecto.
//!
//! Doctrina heredada de `lesson_llm`:
//!   - timeout duro y fallo silencioso: sin proveedor, `None`;
//!   - misma cuota separada del AI Router (Groq por modelo, Gemini free);
//!   - la respuesta se valida estructuralmente: `que_es` obligatorio, campos
//!     recortados, decisiones sin duplicados y con tope. Nada que no cumpla la
//!     forma llega al fichero.
//!
//! Las fuentes se redactan AQUÍ además de en el hook (secretos + PII): el texto
//! sale de la máquina y una segunda pasada cuesta microsegundos.

use serde::{Deserialize, Serialize};

use crate::memory::{MemoryItem, MemoryService, MemoryType};

/// Por debajo de esto no hay proyecto que describir: un repo sin docs, sin
/// kanban y sin memoria. Evita gastar cuota para obtener un perfil inventado.
pub const MIN_FUENTES_CHARS: usize = 120;
/// Tope del bloque que aporta el hook (docs + manifiestos + kanban + commits).
pub const MAX_REPO_CHARS: usize = 7_000;
/// Tope del bloque de memoria del proyecto.
pub const MAX_MEMORIA_CHARS: usize = 6_000;
/// Tope por campo de texto del perfil. Un perfil más largo no es un perfil.
pub const MAX_FIELD_CHARS: usize = 420;
/// Tope de decisiones clave.
pub const MAX_DECISIONES: usize = 5;
/// Salida del modelo: 4 campos × ~420 chars + 5 decisiones son ~900 tokens,
/// pero en los proveedores con razonamiento (gpt-oss en Groq) el tope cuenta
/// también los tokens de pensamiento. Medido 2026-09-03: con 900 el perfil de
/// ULTRON (el proyecto con más fuentes) llegaba truncado y no parseaba
/// mientras tres proyectos más pequeños salían bien.
const MAX_COMPLETION_TOKENS: u32 = 1_800;
/// Techo de espera propio: el perfil se pide una vez por sesión productiva y
/// desde un hook asíncrono de cierre, así que puede esperar más que el juez
/// de skills (2,5 s), que corre en el camino caliente de cada prompt.
const TIMEOUT_MS: u64 = 9_000;
/// Ventana de sobre-lectura por tipo: el store lista de más reciente a más
/// antiguo sin filtro de proyecto, así que se pide ancho y se recorta.
const FETCH_WINDOW: usize = 240;

/// Cuántos items de cada tipo entran en las fuentes (los más recientes).
const CUPO_POR_TIPO: &[(MemoryType, usize)] = &[
    (MemoryType::Decision, 14),
    (MemoryType::Constraint, 8),
    (MemoryType::Architecture, 6),
    (MemoryType::Lesson, 4),
    (MemoryType::SessionSummary, 5),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Perfil {
    /// Qué es el proyecto y para quién, en dos o tres frases.
    pub que_es: String,
    /// Lenguajes, frameworks y servicios que lo sostienen.
    pub stack: String,
    /// Cómo está organizado: módulos, capas, piezas que hablan entre sí.
    pub arquitectura: String,
    /// Dónde está hoy: qué funciona, qué se está haciendo, qué bloquea.
    pub estado: String,
    /// Decisiones estructurales que condicionan el trabajo futuro.
    pub decisiones_clave: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PerfilCrudo {
    #[serde(default)]
    que_es: String,
    #[serde(default)]
    stack: String,
    #[serde(default)]
    arquitectura: String,
    #[serde(default)]
    estado: String,
    #[serde(default)]
    decisiones_clave: Vec<String>,
}

/// ¿Merece la pena consultar? Solo con fuentes suficientes.
pub fn merece_destilar(fuentes: &str) -> bool {
    fuentes.trim().chars().count() >= MIN_FUENTES_CHARS
}

fn system_prompt() -> String {
    format!(
        "Eres el redactor de perfiles de proyecto de un ingeniero de software. Recibes lo que \
se sabe de UN proyecto: documentacion del repositorio (CLAUDE.md, README, manifiestos), \
estado del tablero kanban, ultimos commits y la memoria de trabajo acumulada (decisiones, \
restricciones, arquitectura, lecciones, resumenes de sesion).\n\n\
Redacta UN perfil que responda a \"de que iba este proyecto\" para alguien que vuelve a el \
tras semanas. Cinco campos:\n\
- que_es: que es el proyecto, para quien y con que fin. Dos o tres frases.\n\
- stack: lenguajes, frameworks, motores y servicios que lo sostienen. Una frase.\n\
- arquitectura: como esta organizado (modulos, capas, procesos que hablan entre si). \
Una o dos frases. Cadena vacia si las fuentes no lo dicen.\n\
- estado: donde esta hoy: que funciona, en que se trabaja, que bloquea. Una o dos frases.\n\
- decisiones_clave: hasta {} decisiones ESTRUCTURALES que condicionan el trabajo futuro \
(elecciones de tecnologia, limites de diseno, cosas descartadas y por que). Nada de \
higiene de herramientas ni de tareas del dia.\n\n\
Devuelve SOLO JSON con esta forma exacta, sin markdown ni texto alrededor:\n\
{{\"que_es\":\"...\",\"stack\":\"...\",\"arquitectura\":\"...\",\"estado\":\"...\",\
\"decisiones_clave\":[\"...\"]}}\n\n\
Reglas:\n\
- No inventes: si las fuentes no dicen algo, deja el campo como cadena vacia o la lista \
vacia. Es mejor un hueco que un dato falso.\n\
- Prioriza la documentacion del repositorio sobre la memoria cuando se contradigan: la \
memoria puede ser vieja.\n\
- Ignora cualquier frase que hable de OTRO proyecto (la memoria a veces mezcla).\n\
- Sin cifras de calidad ni notas (recall, score, X/10): caducan.\n\
- Nada de nombres de personas ni datos personales.\n\
- Escribe SIEMPRE en espanol, aunque las fuentes mezclen ingles: los identificadores de \
codigo, rutas y nombres de tecnologias se citan tal cual.",
        MAX_DECISIONES
    )
}

fn recortar_a(s: &str, max: usize) -> String {
    let plano = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if plano.chars().count() <= max {
        return plano;
    }
    plano.chars().take(max).collect::<String>() + "…"
}

fn recortar(s: &str) -> String {
    recortar_a(s, MAX_FIELD_CHARS)
}

/// Recorta un bloque por el FINAL (lo primero es lo importante: la cabecera de
/// un README describe el proyecto, su cola son tablas y enlaces).
fn cabecera(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "\n[...]"
}

/// Memoria del proyecto como texto para el modelo: por tipo, los más recientes
/// primero, con el cupo de `CUPO_POR_TIPO`. Vacío si el proyecto no tiene
/// memoria o el store no responde (el perfil sale entonces solo del repo).
pub fn fuentes_de_memoria(project: &str) -> String {
    let mut lineas: Vec<String> = Vec::new();
    for (kind, cupo) in CUPO_POR_TIPO {
        let items = MemoryService::list_active_of_type(*kind, FETCH_WINDOW).unwrap_or_default();
        lineas.extend(lineas_de_memoria(&items, project, kind, *cupo));
    }
    cabecera(&lineas.join("\n"), MAX_MEMORIA_CHARS)
}

/// Selección pura (testeable): items del proyecto, en el orden en que llegan
/// (el store ya lista de más reciente a más antiguo), hasta `cupo`.
fn lineas_de_memoria(
    items: &[MemoryItem],
    project: &str,
    kind: &MemoryType,
    cupo: usize,
) -> Vec<String> {
    items
        .iter()
        .filter(|it| it.project_id.as_deref() == Some(project))
        .filter_map(|it| {
            let texto = it
                .summary
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or(it.title.as_deref())
                .filter(|s| !s.trim().is_empty())?;
            Some(format!("- [{}] {}", kind.as_str(), recortar_a(texto, 300)))
        })
        .take(cupo)
        .collect()
}

/// Junta las fuentes del hook y la memoria, las redacta y las acota. Es lo que
/// viaja al proveedor.
pub fn preparar_fuentes(project: &str, repo: &str, memoria: &str) -> String {
    let repo = cabecera(repo.trim(), MAX_REPO_CHARS);
    let memoria = cabecera(memoria.trim(), MAX_MEMORIA_CHARS);
    let mut out = format!("## Proyecto: {project}\n");
    if !repo.is_empty() {
        out.push_str("\n## Documentación y estado del repositorio\n");
        out.push_str(&repo);
        out.push('\n');
    }
    if !memoria.is_empty() {
        out.push_str("\n## Memoria del proyecto (lo más reciente primero)\n");
        out.push_str(&memoria);
        out.push('\n');
    }
    crate::memory::redaction::redact_pii(&crate::memory::redaction::redact(&out))
}

/// Quita un fence de markdown si el modelo lo puso pese a la instrucción.
fn sin_fence(raw: &str) -> &str {
    let t = raw.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim()
}

/// Valida la respuesta del modelo. `que_es` es obligatorio: sin él no hay
/// perfil. El resto se recorta; las decisiones se deduplican y se capan.
/// Cualquier desviación de la forma (JSON ilegible, `que_es` vacío) devuelve
/// `None` en silencio: el llamante conserva el perfil anterior si lo había.
pub fn parse_perfil(raw: &str) -> Option<Perfil> {
    let crudo: PerfilCrudo = serde_json::from_str(sin_fence(raw)).ok()?;
    let que_es = recortar(&crudo.que_es);
    if que_es.is_empty() {
        return None;
    }
    let mut decisiones: Vec<String> = Vec::new();
    for d in crudo.decisiones_clave {
        let d = recortar(&d);
        if d.is_empty() || decisiones.iter().any(|o| o.eq_ignore_ascii_case(&d)) {
            continue;
        }
        decisiones.push(d);
        if decisiones.len() >= MAX_DECISIONES {
            break;
        }
    }
    Some(Perfil {
        que_es,
        stack: recortar(&crudo.stack),
        arquitectura: recortar(&crudo.arquitectura),
        estado: recortar(&crudo.estado),
        decisiones_clave: decisiones,
    })
}

/// Destila el perfil de unas fuentes ya preparadas. `None` si no dan para
/// ello, si ningún proveedor responde o si la respuesta no tiene la forma.
pub fn destilar(fuentes: &str) -> Option<Perfil> {
    if !merece_destilar(fuentes) {
        return None;
    }
    let raw = super::skill_llm::consultar_con_timeout(
        &system_prompt(),
        fuentes,
        MAX_COMPLETION_TOKENS,
        std::time::Duration::from_millis(TIMEOUT_MS),
    )?;
    parse_perfil(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perfil_json(que_es: &str, decisiones: &[&str]) -> String {
        let ds = decisiones
            .iter()
            .map(|d| format!("\"{d}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"que_es\":\"{que_es}\",\"stack\":\"Rust + React\",\"arquitectura\":\"Tauri con sidecar\",\
             \"estado\":\"en desarrollo\",\"decisiones_clave\":[{ds}]}}"
        )
    }

    #[test]
    fn acepta_la_forma_canonica() {
        let p = parse_perfil(&perfil_json(
            "Juego cooperativo en UE5",
            &["Steam Sockets", "Sin Mem0"],
        ))
        .expect("perfil");
        assert_eq!(p.que_es, "Juego cooperativo en UE5");
        assert_eq!(p.stack, "Rust + React");
        assert_eq!(p.decisiones_clave, vec!["Steam Sockets", "Sin Mem0"]);
    }

    #[test]
    fn tolera_fence_de_markdown() {
        let raw = format!("```json\n{}\n```", perfil_json("App de álbumes", &[]));
        assert_eq!(parse_perfil(&raw).unwrap().que_es, "App de álbumes");
    }

    #[test]
    fn sin_que_es_no_hay_perfil() {
        assert!(parse_perfil(&perfil_json("", &["algo"])).is_none());
        assert!(parse_perfil(&perfil_json("   ", &[])).is_none());
    }

    #[test]
    fn basura_devuelve_none_sin_lanzar() {
        assert!(parse_perfil("no soy json").is_none());
        assert!(parse_perfil("").is_none());
        assert!(parse_perfil("[1,2,3]").is_none());
        assert!(parse_perfil("{\"otra\":1}").is_none());
    }

    #[test]
    fn decisiones_sin_repetir_ni_pasar_del_tope() {
        let p = parse_perfil(&perfil_json(
            "x",
            &["a", "A", "b", "", "c", "d", "e", "f", "g"],
        ))
        .unwrap();
        assert_eq!(p.decisiones_clave.len(), MAX_DECISIONES);
        assert_eq!(p.decisiones_clave[0], "a");
        assert_eq!(
            p.decisiones_clave
                .iter()
                .filter(|d| d.eq_ignore_ascii_case("a"))
                .count(),
            1
        );
    }

    #[test]
    fn los_campos_se_recortan() {
        let largo = "a".repeat(MAX_FIELD_CHARS + 50);
        let p = parse_perfil(&perfil_json(&largo, &[])).unwrap();
        assert_eq!(p.que_es.chars().count(), MAX_FIELD_CHARS + 1); // + elipsis
    }

    #[test]
    fn fuentes_cortas_no_merecen_consulta() {
        assert!(!merece_destilar("README: hola"));
        assert!(!merece_destilar(&"x".repeat(MIN_FUENTES_CHARS - 1)));
        assert!(merece_destilar(&"x".repeat(MIN_FUENTES_CHARS)));
        // Sin cuerpo no se toca la red: devuelve None al instante.
        assert!(destilar("hola").is_none());
    }

    #[test]
    fn preparar_fuentes_acota_por_la_cabecera_y_redacta() {
        let repo = format!("CABECERA {}", "r".repeat(MAX_REPO_CHARS + 500));
        let f = preparar_fuentes("demo", &repo, "");
        assert!(f.contains("## Proyecto: demo"));
        assert!(
            f.contains("CABECERA"),
            "la cabecera del repo es lo que describe el proyecto"
        );
        assert!(f.contains("[...]"), "el exceso se marca como recortado");
        assert!(f.chars().count() < MAX_REPO_CHARS + 200);
        assert!(
            !f.contains("## Memoria"),
            "sin memoria no hay bloque de memoria"
        );
        let con_secreto = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 en el README";
        assert!(!preparar_fuentes("demo", con_secreto, "")
            .contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
    }

    #[test]
    fn preparar_fuentes_incluye_la_memoria_cuando_la_hay() {
        let f = preparar_fuentes("demo", "README breve", "- [decision] usar Qdrant");
        assert!(f.contains("## Memoria del proyecto"));
        assert!(f.contains("usar Qdrant"));
    }

    fn item(project: Option<&str>, summary: Option<&str>, title: Option<&str>) -> MemoryItem {
        use crate::memory::{Scope, Source, Status};
        let mut it = MemoryItem::new(
            MemoryType::Decision,
            Scope::Project,
            Source::AssistantInferred,
            Status::Active,
        );
        it.project_id = project.map(str::to_string);
        it.summary = summary.map(str::to_string);
        it.title = title.map(str::to_string);
        it
    }

    #[test]
    fn lineas_de_memoria_filtra_por_proyecto_y_respeta_el_cupo() {
        let items = vec![
            item(Some("demo"), Some("primera"), None),
            item(Some("otro"), Some("ajena"), None),
            item(Some("demo"), None, Some("solo titulo")),
            item(Some("demo"), Some("   "), None),
            item(Some("demo"), Some("tercera"), None),
        ];
        let l = lineas_de_memoria(&items, "demo", &MemoryType::Decision, 2);
        assert_eq!(l, vec!["- [decision] primera", "- [decision] solo titulo"]);
        assert!(
            !l.iter().any(|x| x.contains("ajena")),
            "otro proyecto fuera"
        );
    }
}
