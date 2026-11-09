// Mascota — revisión y reversión del guardarraíl de Pupus (guardrail.rs).
//
// `reconcile` compara la foto de antes del turno con una nueva y deshace lo
// que cambió en las rutas protegidas. Antes de borrar o sobrescribir nada,
// guarda lo que dejó el turno en la cuarentena; si la copia falla, no toca el
// fichero (nada se destruye sin copia).
//
// `~/.claude.json` lo reescribe cada sesión de Claude Code (contadores,
// proyectos recientes…). Revertirlo en cada turno pisaría el trabajo de las
// sesiones abiertas, así que solo cuenta como cambio si cambian las claves
// que dan ejecución o permisos (`mcpServers`, `hooks`, `allowedTools`,
// `enabledMcpjsonServers`, arriba o dentro de un proyecto).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};

use super::{Body, FileState, Roots, Snapshot, QUARANTINE_DIR};

const CLAUDE_JSON: &str = ".claude.json";
const CLAUDE_JSON_RISKY_KEYS: [&str; 4] = [
    "mcpServers",
    "hooks",
    "allowedTools",
    "enabledMcpjsonServers",
];

/// Qué cambió en una ruta protegida.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Modified,
    Created,
    Deleted,
    DirCreated,
}

impl Change {
    fn label(self) -> &'static str {
        match self {
            Change::Modified => "modificado",
            Change::Created => "creado",
            Change::Deleted => "borrado",
            Change::DirCreated => "carpeta creada",
        }
    }
}

/// Qué hizo el guardarraíl con el cambio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Vuelto a como estaba antes del turno.
    Reverted,
    /// Detectado, pero no se revierte (motivo).
    Kept(String),
    /// La reversión falló (error).
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub path: PathBuf,
    pub change: Change,
    pub outcome: Outcome,
    /// Copia de lo que dejó el turno, si se guardó.
    pub quarantined: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub struct Report {
    pub findings: Vec<Finding>,
}

impl Report {
    /// Aviso para el usuario; `None` si el turno no tocó nada protegido.
    pub fn notice(&self, roots: &Roots) -> Option<String> {
        if self.findings.is_empty() {
            return None;
        }
        let lines: Vec<String> = self.findings.iter().map(|f| line(f, roots)).collect();
        Some(format!(
            "Guardarraíl de Pupus: este turno tocó rutas protegidas.\n{}",
            lines.join("\n")
        ))
    }
}

fn shown(path: &Path, roots: &Roots) -> String {
    match path.strip_prefix(&roots.home) {
        Ok(rel) => format!("~/{}", rel.to_string_lossy().replace('\\', "/")),
        Err(_) => path.display().to_string(),
    }
}

fn line(f: &Finding, roots: &Roots) -> String {
    let what = match &f.outcome {
        Outcome::Reverted if f.change == Change::Deleted => "restaurado".to_string(),
        Outcome::Reverted if f.change == Change::Modified => "restaurado".to_string(),
        Outcome::Reverted => "borrado".to_string(),
        Outcome::Kept(why) => format!("NO revertido ({why})"),
        Outcome::Failed(e) => format!("NO revertido, falló: {e}"),
    };
    let copy = f
        .quarantined
        .as_ref()
        .map(|q| format!("; copia en {}", shown(q, roots)))
        .unwrap_or_default();
    format!(
        "• {}: {} → {what}{copy}",
        shown(&f.path, roots),
        f.change.label()
    )
}

// ---------------------------------------------------------------------------
// Cuarentena
// ---------------------------------------------------------------------------

static TURN_SEQ: AtomicU64 = AtomicU64::new(0);

struct Quarantine {
    root: PathBuf,
    home: PathBuf,
}

impl Quarantine {
    fn new(roots: &Roots) -> Self {
        let seq = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
        let mark = format!(
            "{}-{}-{seq}",
            chrono::Local::now().format("%Y%m%d-%H%M%S%3f"),
            std::process::id()
        );
        Self {
            root: roots.home.join(QUARANTINE_DIR).join(mark),
            home: roots.home.clone(),
        }
    }

    /// Ruta dentro de la cuarentena: relativa a la carpeta de usuario o, si
    /// está fuera (Documentos en otro disco), bajo `_fuera/`.
    fn dest(&self, path: &Path) -> PathBuf {
        if let Ok(rel) = path.strip_prefix(&self.home) {
            return self.root.join(rel);
        }
        let parts = path.components().filter_map(|c| match c {
            Component::Prefix(p) => Some(
                p.as_os_str()
                    .to_string_lossy()
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .collect::<String>(),
            ),
            Component::Normal(n) => Some(n.to_string_lossy().to_string()),
            _ => None,
        });
        parts.fold(self.root.join("_fuera"), |acc, p| acc.join(p))
    }

    /// Guarda lo que hay ahora en `path` (descrito por `now`).
    fn store(&self, path: &Path, now: &FileState) -> Result<PathBuf, String> {
        let dest = self.dest(path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("cuarentena: {e}"))?;
        }
        match &now.body {
            Body::Bytes(b) => fs::write(&dest, b).map(|()| dest),
            Body::Link(target) => {
                let note = dest.with_extension("enlace.txt");
                fs::write(&note, target.to_string_lossy().as_bytes()).map(|()| note)
            }
            Body::TooLarge | Body::OverBudget => fs::copy(path, &dest).map(|_| dest),
            Body::NotFile | Body::Unreadable(_) => {
                return Err("no es un fichero que se pueda copiar".into())
            }
        }
        .map_err(|e| format!("cuarentena: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Revisión
// ---------------------------------------------------------------------------

fn claude_json_view(bytes: &[u8]) -> Option<Value> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let pick = |o: &Value| -> Map<String, Value> {
        CLAUDE_JSON_RISKY_KEYS
            .iter()
            .filter_map(|k| o.get(*k).map(|x| ((*k).to_string(), x.clone())))
            .collect()
    };
    let projects: Map<String, Value> = v
        .get("projects")
        .and_then(Value::as_object)
        .map(|ps| {
            ps.iter()
                .map(|(k, p)| (k.clone(), pick(p)))
                .filter(|(_, m)| !m.is_empty())
                .map(|(k, m)| (k, Value::Object(m)))
                .collect()
        })
        .unwrap_or_default();
    Some(serde_json::json!({ "top": pick(&v), "projects": projects }))
}

/// Mismo contenido a efectos del guardarraíl.
fn equivalent(path: &Path, was: &FileState, now: &FileState, roots: &Roots) -> bool {
    if was.same_as(now) {
        return true;
    }
    if path != roots.home.join(CLAUDE_JSON) {
        return false;
    }
    match (&was.body, &now.body) {
        (Body::Bytes(a), Body::Bytes(b)) => match (claude_json_view(a), claude_json_view(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
        _ => false,
    }
}

fn remove_entry(path: &Path, now: &FileState) -> std::io::Result<()> {
    match (&now.body, fs::remove_file(path)) {
        // Un enlace a carpeta en Windows se borra como carpeta.
        (Body::Link(_), Err(_)) => fs::remove_dir(path),
        (_, r) => r,
    }
}

fn finding(path: &Path, change: Change, outcome: Outcome, q: Option<PathBuf>) -> Finding {
    Finding {
        path: path.to_path_buf(),
        change,
        outcome,
        quarantined: q,
    }
}

fn created(path: &Path, now: &FileState, q: &Quarantine, partial: bool) -> Finding {
    if partial {
        let why = "carpeta con demasiadas entradas, revisión truncada".to_string();
        return finding(path, Change::Created, Outcome::Kept(why), None);
    }
    let copy = match q.store(path, now) {
        Ok(c) => c,
        Err(e) => return finding(path, Change::Created, Outcome::Failed(e), None),
    };
    let outcome = match remove_entry(path, now) {
        Ok(()) => Outcome::Reverted,
        Err(e) => Outcome::Failed(e.to_string()),
    };
    finding(path, Change::Created, outcome, Some(copy))
}

fn restore(path: &Path, was: &FileState, now: Option<&FileState>) -> Outcome {
    let Body::Bytes(bytes) = &was.body else {
        let why = was
            .unprotected_reason()
            .unwrap_or_else(|| "sin copia".into());
        return Outcome::Kept(why);
    };
    if let Some(now) = now {
        match &now.body {
            Body::NotFile => return Outcome::Kept("ahora es una carpeta".into()),
            // Escribir a través de un enlace tocaría su destino: fuera primero.
            Body::Link(_) => {
                if let Err(e) = remove_entry(path, now) {
                    return Outcome::Failed(e.to_string());
                }
            }
            _ => {}
        }
    }
    let parent_ok = path.parent().map_or(Ok(()), fs::create_dir_all);
    match parent_ok.and_then(|()| fs::write(path, bytes)) {
        Ok(()) => Outcome::Reverted,
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

fn modified(path: &Path, was: &FileState, now: &FileState, q: &Quarantine) -> Finding {
    tracing::info!(ruta = %path.display(), antes = ?was.hash, despues = ?now.hash,
        "guardarraíl de Pupus: huella FNV-1a del fichero modificado");
    let copy = match q.store(path, now) {
        Ok(c) => Some(c),
        Err(e) if !matches!(now.body, Body::NotFile) => {
            return finding(path, Change::Modified, Outcome::Failed(e), None)
        }
        Err(_) => None,
    };
    finding(path, Change::Modified, restore(path, was, Some(now)), copy)
}

fn under_any(path: &Path, roots: &BTreeSet<&PathBuf>) -> bool {
    roots.iter().any(|r| path.starts_with(r))
}

/// Revisa las rutas protegidas contra `before` y deshace lo que cambió.
pub fn reconcile(before: &Snapshot, roots: &Roots) -> Report {
    let after = Snapshot::take_with(roots, Some(before));
    let q = Quarantine::new(roots);
    let partial: BTreeSet<&PathBuf> = before.truncated.iter().chain(&after.truncated).collect();
    let mut findings = Vec::new();
    for (path, now) in &after.files {
        match before.files.get(path) {
            None => findings.push(created(path, now, &q, under_any(path, &partial))),
            Some(was) if !equivalent(path, was, now, roots) => {
                findings.push(modified(path, was, now, &q));
            }
            Some(_) => {}
        }
    }
    for (path, was) in &before.files {
        // Si sigue en disco, la foto de después solo se cortó antes de verlo.
        if after.files.contains_key(path) || fs::symlink_metadata(path).is_ok() {
            continue;
        }
        findings.push(finding(
            path,
            Change::Deleted,
            restore(path, was, None),
            None,
        ));
    }
    findings.extend(new_dirs(before, &after, &partial));
    for f in &findings {
        tracing::warn!(ruta = %f.path.display(), cambio = ?f.change, resultado = ?f.outcome,
            "guardarraíl de Pupus: ruta protegida tocada por el turno");
    }
    Report { findings }
}

/// Carpetas que creó el turno, de la más honda a la menos: se borran si
/// quedaron vacías tras revertir sus ficheros.
fn new_dirs(before: &Snapshot, after: &Snapshot, partial: &BTreeSet<&PathBuf>) -> Vec<Finding> {
    after
        .dirs
        .iter()
        .rev()
        .filter(|d| !before.dirs.contains(*d) && !under_any(d, partial))
        .map(|d| {
            let outcome = match fs::remove_dir(d) {
                Ok(()) => Outcome::Reverted,
                Err(e) => Outcome::Kept(format!("no está vacía: {e}")),
            };
            finding(d, Change::DirCreated, outcome, None)
        })
        .collect()
}
