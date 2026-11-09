// projects/discover.rs — «Volver a escanear el disco»: da de alta las carpetas
// de proyecto nuevas bajo las raíces reales del creador.
//
// Las raíces salen de `cockpit/project-roots.json`, las mismas de
// `project-create.mjs roots`. El escaneo solo AÑADE entradas: una ya registrada
// no se reescribe, así que `color`, `socratic` o `default_provider` no se pueden
// perder aquí. Respeta `cockpit/projects-exclusions.json`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::normalise::normalise_provider;
use super::registry::{atomic_write, projects_lock, slugify};
use super::types::ProjectInfo;

/// Profundidad bajo cada raíz. `<asignatura>/codigo/<proyecto>` son 3 niveles;
/// el margen cubre agrupaciones por curso o práctica sin recorrer todo el árbol.
const MAX_SCAN_DEPTH: usize = 6;

/// Un directorio con alguno de estos ficheros es la raíz de un proyecto. `.git`
/// cubre lo que crean las plantillas sin manifiesto (`trabajo-entrega`, `vacio`).
const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle.kts",
    "pyproject.toml",
    "setup.py",
    "go.mod",
    "Podfile",
    "CMakeLists.txt",
];
const PROJECT_MARKER_EXTENSIONS: &[&str] = &["uproject", "sln", "csproj", "vcxproj"];

/// Carpetas que no se recorren: dependencias y salidas de compilación.
const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "__pycache__",
    "venv",
    "Library",
    "Temp",
    "Logs",
    "Intermediate",
    "Saved",
    "DerivedDataCache",
    "cmake-build-debug",
    "cmake-build-release",
    "Pods",
    "DerivedData",
    "worktrees",
];

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ScanRoot {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Deserialize)]
struct RootsFile {
    #[serde(default)]
    roots: Vec<ScanRoot>,
}

/// Lista permanente de proyectos que no se vuelven a dar de alta.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct Exclusions {
    #[serde(default)]
    excluded_by_id: Vec<String>,
    #[serde(default)]
    excluded_by_path_pattern: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AddedProject {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Resultado del escaneo. La UI dice qué raíces recorrió y qué dio de alta: un
/// «hecho» sin más no distingue «nada nuevo» de «no ha mirado donde debía».
#[derive(Debug, Serialize)]
pub struct ScanReport {
    pub projects: Vec<ProjectInfo>,
    pub added: Vec<AddedProject>,
    pub scanned_roots: Vec<String>,
    pub missing_roots: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Discovered {
    name: String,
    path: PathBuf,
    root_id: String,
    root_kind: String,
}

/// Identidad de una ruta en el registro: separadores, mayúsculas y barra final.
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// `fnmatch` de Python, como lo aplica `scan_projects.py` en Windows: `*` cruza
/// separadores, `?` es un carácter, sin distinguir mayúsculas ni tipo de barra.
fn glob_matches(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = normalize_path(pattern).chars().collect();
    let text: Vec<char> = normalize_path(text).chars().collect();
    let (mut p, mut t) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            backtrack = Some((p + 1, t));
            p += 1;
        } else if let Some((after_star, matched)) = backtrack {
            p = after_star;
            t = matched + 1;
            backtrack = Some((after_star, t));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

impl Exclusions {
    fn excludes(&self, id: &str, path: &str) -> bool {
        self.excluded_by_id.iter().any(|x| x == id)
            || self
                .excluded_by_path_pattern
                .iter()
                .any(|pattern| glob_matches(pattern, path))
    }
}

/// Con `.git` como FICHERO, la carpeta es un worktree enlazado o un submódulo:
/// pertenece a otro repo y darla de alta duplicaría el proyecto.
fn is_linked_checkout(dir: &Path) -> bool {
    dir.join(".git").is_file()
}

fn is_project_root(dir: &Path) -> bool {
    if PROJECT_MARKERS.iter().any(|m| dir.join(m).exists()) {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| {
                PROJECT_MARKER_EXTENSIONS
                    .iter()
                    .any(|m| e.eq_ignore_ascii_case(m))
            })
    })
}

fn should_descend(name: &str) -> bool {
    !name.starts_with('.') && !SKIP_DIR_NAMES.contains(&name)
}

/// Contexto común del recorrido de una raíz.
struct Walk<'a> {
    root: &'a ScanRoot,
    registered: &'a HashSet<String>,
    exclusions: &'a Exclusions,
}

impl Walk<'_> {
    fn visit(&self, dir: &Path, depth: usize, found: &mut Vec<Discovered>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => {
                tracing::warn!("[scan] no se pudo leer {}: {e}", dir.display());
                return;
            }
        };
        for entry in entries.flatten() {
            // `file_type` no sigue enlaces: un junction no multiplica el árbol.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !should_descend(&name) {
                continue;
            }
            let path = entry.path();
            let shown = path.to_string_lossy().to_string();
            // Lo que cuelga de un proyecto registrado es parte de ese proyecto.
            if self.registered.contains(&normalize_path(&shown)) || is_linked_checkout(&path) {
                continue;
            }
            if is_project_root(&path) {
                if !self.exclusions.excludes(&slugify(&name), &shown) {
                    found.push(Discovered {
                        name,
                        path,
                        root_id: self.root.id.clone(),
                        root_kind: self.root.kind.clone(),
                    });
                }
                continue;
            }
            if depth < MAX_SCAN_DEPTH {
                self.visit(&path, depth + 1, found);
            }
        }
    }
}

fn discover(
    root: &ScanRoot,
    registered: &HashSet<String>,
    exclusions: &Exclusions,
) -> Vec<Discovered> {
    let mut found = Vec::new();
    let walk = Walk {
        root,
        registered,
        exclusions,
    };
    walk.visit(Path::new(&root.path), 1, &mut found);
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// Id libre con la misma cadena que `ensure-project.js` y `scan_projects.py`:
/// base, base con el nombre de la carpeta madre, base numerada.
fn free_id(found: &Discovered, taken: &HashSet<String>) -> String {
    let base = match slugify(&found.name) {
        slug if slug.is_empty() => "proyecto".to_string(),
        slug => slug,
    };
    if !taken.contains(&base) {
        return base;
    }
    let parent = found
        .path
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let with_parent = slugify(&format!("{parent}-{}", found.name));
    if !with_parent.is_empty() && !taken.contains(&with_parent) {
        return with_parent;
    }
    (2u32..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or(base)
}

/// Entrada del registro. `status: "manual"` a propósito: `scan_projects.py`
/// borra las `auto-detected` que no encuentra, y estas raíces no son las suyas.
/// Bajo una raíz de asignaturas va en modo socrático `uni`, como en el creador.
fn registry_entry(found: &Discovered, id: &str, today: &str) -> serde_json::Value {
    let mut entry = serde_json::json!({
        "id": id,
        "name": found.name,
        "path": found.path.to_string_lossy(),
        "ide": "",
        "language": "",
        "type": "",
        "deadline": "",
        "last_active": today,
        "status": "manual",
        "tags": [found.root_id],
        "auto_tags": [],
        "items": [],
        "default_provider": normalise_provider(None),
    });
    if found.root_kind == "asignatura" {
        entry["socratic"] = serde_json::Value::String("uni".to_string());
    }
    entry
}

fn registered_paths(root: &serde_json::Value) -> HashSet<String> {
    root.get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| p.get("path").and_then(|v| v.as_str()))
        .map(normalize_path)
        .collect()
}

fn read_registry(registry: &Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(registry).map_err(|e| format!("read projects.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse projects.json: {e}"))
}

/// Añade lo encontrado al registro con el cerrojo de escritura tomado, releyendo
/// el fichero: el recorrido del disco es lento y otra escritura pudo entrar.
fn register_discovered(
    registry: &PathBuf,
    found: Vec<Discovered>,
) -> Result<Vec<AddedProject>, String> {
    if found.is_empty() {
        return Ok(Vec::new());
    }
    let _guard = projects_lock()
        .lock()
        .map_err(|e| format!("projects write lock poisoned: {e}"))?;
    let mut root = read_registry(registry)?;
    let registered = registered_paths(&root);
    let projects = root
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "projects.json has no projects[]".to_string())?;
    let mut taken: HashSet<String> = projects
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut added = Vec::new();
    for item in found {
        let path = item.path.to_string_lossy().to_string();
        if registered.contains(&normalize_path(&path)) {
            continue;
        }
        let id = free_id(&item, &taken);
        projects.push(registry_entry(&item, &id, &today));
        taken.insert(id.clone());
        added.push(AddedProject {
            id,
            name: item.name,
            path,
        });
    }
    if added.is_empty() {
        return Ok(added);
    }
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(registry, &serialized)?;
    Ok(added)
}

/// Lee las raíces. Sin raíces no hay qué escanear y se dice: el escaneo de antes
/// recorría carpetas por defecto que no eran las del usuario y daba altas basura.
fn load_roots(path: &Path) -> Result<Vec<ScanRoot>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        format!(
            "no hay raíces de proyectos que recorrer ({}: {e}). Configúralas con «project-create.mjs roots set»",
            path.display()
        )
    })?;
    let parsed: RootsFile =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if parsed.roots.is_empty() {
        return Err(format!(
            "{} no define ninguna raíz. Configúralas con «project-create.mjs roots set»",
            path.display()
        ));
    }
    Ok(parsed.roots)
}

/// Un fichero ausente es «sin exclusiones»; uno ilegible para el escaneo: dar de
/// alta sin él resucitaría lo que el usuario sacó a propósito.
fn load_exclusions(path: &Path) -> Result<Exclusions, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Exclusions::default()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Resultado del escaneo antes de releer la lista completa para la UI.
#[derive(Debug)]
struct ScanOutcome {
    added: Vec<AddedProject>,
    scanned_roots: Vec<String>,
    missing_roots: Vec<String>,
}

/// Recorre `roots` y registra lo nuevo en `registry`. Una raíz inexistente no
/// aborta las demás, pero si faltan todas es un error: no hay nada recorrido.
fn scan_roots_into(
    registry: &PathBuf,
    roots: &[ScanRoot],
    exclusions: &Exclusions,
) -> Result<ScanOutcome, String> {
    let (present, missing): (Vec<&ScanRoot>, Vec<&ScanRoot>) =
        roots.iter().partition(|r| Path::new(&r.path).is_dir());
    let missing_roots: Vec<String> = missing.iter().map(|r| r.path.clone()).collect();
    if present.is_empty() {
        return Err(format!(
            "ninguna raíz de proyectos existe en disco: {}",
            missing_roots.join(", ")
        ));
    }
    let registered = registered_paths(&read_registry(registry)?);
    let found = present
        .iter()
        .flat_map(|root| discover(root, &registered, exclusions))
        .collect();
    Ok(ScanOutcome {
        added: register_discovered(registry, found)?,
        scanned_roots: present.iter().map(|r| r.path.clone()).collect(),
        missing_roots,
    })
}

/// Escanea las raíces del creador y devuelve el registro actualizado con el
/// parte de lo hecho. Bloquea: los comandos lo llaman fuera del hilo principal.
pub fn scan_projects_inner() -> Result<ScanReport, String> {
    let cockpit = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/cockpit");
    let roots = load_roots(&cockpit.join("project-roots.json"))?;
    let exclusions = load_exclusions(&cockpit.join("projects-exclusions.json"))?;
    let outcome = scan_roots_into(&cockpit.join("projects.json"), &roots, &exclusions)?;
    Ok(ScanReport {
        projects: super::read_ops::list_projects_inner()?,
        added: outcome.added,
        scanned_roots: outcome.scanned_roots,
        missing_roots: outcome.missing_roots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        tmp: tempfile::TempDir,
        registry: PathBuf,
    }

    fn fixture(projects: serde_json::Value) -> Fixture {
        let tmp = tempfile::tempdir().expect("tempdir");
        let registry = tmp.path().join("projects.json");
        let body = serde_json::json!({ "version": "1.0", "projects": projects });
        fs::write(&registry, body.to_string()).expect("registro");
        fs::create_dir_all(tmp.path().join("raiz")).expect("raiz");
        Fixture { tmp, registry }
    }

    impl Fixture {
        fn root(&self, kind: &str) -> ScanRoot {
            ScanRoot {
                id: "asignaturas".into(),
                path: self.tmp.path().join("raiz").to_string_lossy().to_string(),
                kind: kind.into(),
            }
        }
        fn project(&self, rel: &str, marker: &str) -> PathBuf {
            let dir = self.tmp.path().join("raiz").join(rel);
            fs::create_dir_all(&dir).expect("carpeta");
            let marker = dir.join(marker);
            if marker.extension().is_some() {
                fs::write(marker, "x").expect("marcador");
            } else {
                fs::create_dir_all(marker).expect("marcador");
            }
            dir
        }
        fn entries(&self) -> Vec<serde_json::Value> {
            let root = read_registry(&self.registry).expect("registro");
            root["projects"].as_array().expect("projects").clone()
        }
    }

    #[test]
    fn da_de_alta_lo_nuevo_bajo_la_raiz_real() {
        let fx = fixture(serde_json::json!([]));
        let dir = fx.project("CDE/codigo/Practica 7", ".git");
        fx.project("CDE/codigo/Web", "package.json");
        fs::create_dir_all(fx.tmp.path().join("raiz/CDE/apuntes")).expect("sin marcador");

        let out = scan_roots_into(
            &fx.registry,
            &[fx.root("asignatura")],
            &Exclusions::default(),
        )
        .expect("scan");

        let nombres: Vec<&str> = out.added.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(nombres, ["Practica 7", "Web"]);
        let entrada = fx
            .entries()
            .into_iter()
            .find(|e| e["id"] == "practica-7")
            .expect("alta");
        assert_eq!(
            normalize_path(entrada["path"].as_str().expect("path")),
            normalize_path(&dir.to_string_lossy())
        );
        assert_eq!(entrada["socratic"], "uni", "bajo asignaturas es modo uni");
        assert_eq!(entrada["status"], "manual");
    }

    #[test]
    fn fuera_de_las_asignaturas_no_impone_modo_socratico() {
        let fx = fixture(serde_json::json!([]));
        fx.project("App", "Cargo.toml");
        scan_roots_into(&fx.registry, &[fx.root("personal")], &Exclusions::default())
            .expect("scan");
        assert!(fx.entries()[0].get("socratic").is_none());
    }

    #[test]
    fn no_reescribe_una_entrada_registrada_ni_entra_en_ella() {
        let fx = fixture(serde_json::json!([]));
        let dir = fx.project("Existente", ".git");
        fx.project("Existente/sub", "package.json");
        let original = serde_json::json!({
            "id": "mi-id",
            "name": "Mi nombre",
            "path": dir.to_string_lossy().to_uppercase().replace('\\', "/"),
            "color": "#123456",
            "socratic": "off",
            "default_provider": "codex",
            "ide": "cursor",
        });
        let body = serde_json::json!({ "projects": [original] });
        fs::write(&fx.registry, body.to_string()).expect("registro");
        let antes = fs::read(&fx.registry).expect("leer");

        let out = scan_roots_into(
            &fx.registry,
            &[fx.root("asignatura")],
            &Exclusions::default(),
        )
        .expect("scan");

        assert!(out.added.is_empty());
        assert_eq!(
            fs::read(&fx.registry).expect("leer"),
            antes,
            "sin altas no se escribe"
        );
    }

    #[test]
    fn respeta_las_exclusiones_por_id_y_por_patron() {
        let fx = fixture(serde_json::json!([]));
        fx.project("Fuera", ".git");
        fx.project("flutter/dev/tool", "package.json");
        fx.project("Dentro", ".git");
        let exclusions = Exclusions {
            excluded_by_id: vec!["fuera".into()],
            excluded_by_path_pattern: vec!["**/flutter\\dev\\**".into()],
        };
        let out = scan_roots_into(&fx.registry, &[fx.root("personal")], &exclusions).expect("scan");
        let nombres: Vec<&str> = out.added.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(nombres, ["Dentro"]);
    }

    #[test]
    fn no_recorre_dependencias_ni_carpetas_ocultas() {
        let fx = fixture(serde_json::json!([]));
        fx.project("node_modules/paquete", "package.json");
        fx.project(".cache/algo", ".git");
        fx.project("target/x", "Cargo.toml");
        let out = scan_roots_into(&fx.registry, &[fx.root("personal")], &Exclusions::default())
            .expect("scan");
        assert!(out.added.is_empty(), "{:?}", out.added);
    }

    #[test]
    fn un_worktree_enlazado_no_es_un_proyecto_aparte() {
        let fx = fixture(serde_json::json!([]));
        let dir = fx.tmp.path().join("raiz/App-slot1");
        fs::create_dir_all(&dir).expect("carpeta");
        fs::write(dir.join(".git"), "gitdir: C:/App/.git/worktrees/App-slot1").expect("git");
        fs::write(dir.join("package.json"), "{}").expect("manifiesto");
        let out = scan_roots_into(&fx.registry, &[fx.root("personal")], &Exclusions::default())
            .expect("scan");
        assert!(out.added.is_empty(), "{:?}", out.added);
    }

    #[test]
    fn un_nombre_repetido_recibe_un_id_libre_sin_pisar_al_titular() {
        let fx = fixture(serde_json::json!([{ "id": "practica", "path": "C:/otra/ruta" }]));
        fx.project("A/Practica", ".git");
        fx.project("B/Practica", ".git");
        let out = scan_roots_into(&fx.registry, &[fx.root("personal")], &Exclusions::default())
            .expect("scan");
        let ids: Vec<&str> = out.added.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["a-practica", "b-practica"]);
        assert_eq!(fx.entries()[0]["path"], "C:/otra/ruta");
    }

    #[test]
    fn una_raiz_ausente_se_informa_y_si_faltan_todas_es_un_error() {
        let fx = fixture(serde_json::json!([]));
        fx.project("App", ".git");
        let ausente = ScanRoot {
            id: "x".into(),
            path: fx
                .tmp
                .path()
                .join("no-existe")
                .to_string_lossy()
                .to_string(),
            kind: "personal".into(),
        };
        let raices = [ausente.clone(), fx.root("personal")];
        let out = scan_roots_into(&fx.registry, &raices, &Exclusions::default()).expect("scan");
        assert_eq!(out.missing_roots, std::slice::from_ref(&ausente.path));
        assert_eq!(out.added.len(), 1);
        let err = scan_roots_into(&fx.registry, &[ausente], &Exclusions::default()).unwrap_err();
        assert!(err.contains("ninguna raíz"), "{err}");
    }

    #[test]
    fn sin_raices_configuradas_es_un_error_que_explica_como_arreglarlo() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("project-roots.json");
        assert!(load_roots(&path).unwrap_err().contains("roots set"));
        fs::write(&path, r#"{"roots":[]}"#).expect("vacío");
        assert!(load_roots(&path).unwrap_err().contains("roots set"));
        fs::write(&path, "{no es json").expect("roto");
        assert!(load_roots(&path).is_err());
        fs::write(
            &path,
            r#"{"roots":[{"id":"a","path":"C:/a","kind":"personal"}]}"#,
        )
        .expect("ok");
        assert_eq!(load_roots(&path).expect("raíces").len(), 1);
    }

    #[test]
    fn un_fichero_de_exclusiones_roto_para_el_escaneo() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("projects-exclusions.json");
        assert!(load_exclusions(&path).is_ok(), "ausente = sin exclusiones");
        fs::write(&path, "{no es json").expect("roto");
        assert!(load_exclusions(&path).is_err());
    }

    #[test]
    fn el_comodin_cruza_separadores_sin_distinguir_barras_ni_mayusculas() {
        assert!(glob_matches(
            "**/ejercicios/T11",
            r"C:\Users\x\Ejercicios\t11"
        ));
        assert!(glob_matches("**/flutter\\dev\\**", "C:/a/flutter/dev/b/c"));
        assert!(glob_matches("a?c*", "abcdef"));
        assert!(!glob_matches("**/ejercicios/T11", "C:/ejercicios/T12"));
        assert!(!glob_matches("abc", "abcd"));
    }

    /// Comprobación contra las raíces reales de esta máquina, solo lectura:
    /// `cargo test --features finance --lib descubre_en_las_raices_reales -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn descubre_en_las_raices_reales_sin_escribir() {
        let cockpit = dirs::home_dir().expect("home").join(".ultron/cockpit");
        let roots = load_roots(&cockpit.join("project-roots.json")).expect("raíces");
        let exclusions =
            load_exclusions(&cockpit.join("projects-exclusions.json")).expect("exclusiones");
        let registered =
            registered_paths(&read_registry(&cockpit.join("projects.json")).expect("registro"));
        for root in &roots {
            for found in discover(root, &registered, &exclusions) {
                println!("{} <- {}", root.id, found.path.display());
            }
        }
    }
}
