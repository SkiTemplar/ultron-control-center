// Mascota — guardarrail de persistencia para los turnos de Codex y Antigravity.
//
// Codex (`workspace-write`) y Antigravity (sandbox con autoaprobación) corren
// con la carpeta de usuario como cwd (decisión del usuario, 2026-10-19: no se
// aísla el directorio de trabajo). Una inyección de prompt en un fichero
// adjunto podría dejar ejecución persistente en settings de Claude Code,
// hooks, perfiles de shell, la carpeta de Inicio o credenciales. Este módulo
// fotografía una lista FIJA de esas rutas antes del turno y, al terminar:
//   * fichero modificado -> guarda en cuarentena lo que quedó y restaura la
//     versión de antes;
//   * fichero creado     -> lo guarda en cuarentena y lo borra;
//   * fichero borrado    -> lo restaura;
//   * carpeta creada     -> la borra si quedó vacía.
// La cuarentena va a `~/.ultron/cockpit/pupus-guardrail/<marca>/<ruta>` (en
// .gitignore), así que nada se destruye. Cada hallazgo se registra con
// `tracing::warn!` y el aviso se añade a la respuesta de Pupus. Los errores
// de restauración se enseñan en el aviso; nunca se tragan.
//
// Límites (medidos y fijados aquí):
//   * Ficheros de más de `MAX_FILE_BYTES` (1 MiB) o fuera del presupuesto
//     `MAX_TOTAL_BYTES` (64 MiB por foto) no se copian: se detecta su cambio
//     por tamaño y fecha, se ponen en cuarentena, pero NO se restauran (el
//     aviso lo dice). Es el caso de los ejecutables de `.ultron/bin`.
//   * Carpetas: hasta `MAX_DIR_DEPTH` niveles por debajo de la carpeta
//     protegida y `MAX_DIR_ENTRIES` entradas; si se trunca, lo nuevo en esa
//     carpeta se avisa pero no se borra. No se siguen enlaces simbólicos ni
//     se entra en `SKIPPED_DIRS` (índices que cambian solos y skills que no
//     se cargan).
//   * Perfiles de PowerShell: solo `*profile*.ps1` directamente en
//     `Documentos/WindowsPowerShell` y `Documentos/PowerShell`.
//
// ALCANCE REAL: es detección y reversión DESPUÉS del turno, no prevención.
// Lo que se escriba fuera de esta lista no se ve. Si otro proceso (o el
// usuario) edita legítimamente una de estas rutas durante un turno de Pupus,
// también se revierte: queda en cuarentena, no se pierde (incluye
// `~/.ultron/hooks`, `mods` y `scripts`, que son parte del repo: editarlos o un
// checkout durante un turno de Codex se deshace; y un redeploy de `.ultron/bin`
// no se revierte, pero deja una copia en cuarentena). `~/.claude.json`, que cada sesión de Claude Code
// reescribe a menudo, solo se revierte si cambian `mcpServers`, `hooks`,
// `allowedTools` o `enabledMcpjsonServers` (guardrail_revert.rs).
// Lo que un programa lanzado por el turno ejecute antes de que acabe (p. ej.
// un proceso en segundo plano) no se deshace.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Medido el 2026-11-02: la lista entera ocupa ~55 MiB, sin contar `.ultron/bin`
/// (ejecutables de más de 1 MiB, que no se copian). La foto vive en memoria solo
/// durante un turno de Codex o Antigravity.
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_DIR_DEPTH: usize = 5;
pub const MAX_DIR_ENTRIES: usize = 5_000;
/// `.codegraph`, `.git` y `__pycache__` cambian solos y no se cargan como
/// código de arranque; `_disabled` y `_archived` son skills que Claude Code no
/// carga (no desciende a subcarpetas).
const SKIPPED_DIRS: [&str; 5] = [
    ".codegraph",
    ".git",
    "__pycache__",
    "_disabled",
    "_archived",
];
const QUARANTINE_DIR: &str = ".ultron/cockpit/pupus-guardrail";

const HOME_FILES: [&str; 20] = [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude.json",
    ".claude/CLAUDE.md",
    ".claude/plugins/installed_plugins.json",
    ".claude/plugins/known_marketplaces.json",
    ".ultron/.env",
    ".ultron/cockpit/projects.json",
    ".codex/config.toml",
    ".codex/AGENTS.md",
    ".gemini/settings.json",
    ".gemini/GEMINI.md",
    ".gemini/antigravity/mcp_config.json",
    ".gemini/config/mcp_config.json",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".profile",
    ".zshrc",
    ".gitconfig",
];

/// Carpetas pequeñas y críticas: van antes que el resto para que nunca se
/// queden fuera del presupuesto.
const HOME_DIRS: [&str; 9] = [
    ".claude/hooks",
    ".claude/agents",
    ".claude/commands",
    ".claude/rules",
    ".ultron/hooks",
    ".ssh",
    ".codex/rules",
    ".config/fish",
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
];

const PS_PROFILE_DIRS: [&str; 2] = ["WindowsPowerShell", "PowerShell"];

/// Carpetas grandes, también con ejecución persistente: los hooks de los mods
/// (`CLAUDE_CODE_PLUGIN_DIRS`, docs/MODS.md), scripts, plugins y skills. Van las
/// últimas: lo que no quepa en el presupuesto se detecta y se avisa, pero no se
/// restaura. De `.claude/plugins` solo `cache`, que es lo que se carga:
/// `marketplaces` y `data` cambian solos.
const BULK_DIRS: [&str; 6] = [
    ".ultron/scripts",
    ".claude/plugins/cache",
    ".claude/skills",
    ".ultron/mods",
    ".ultron/bin",
    ".codex/plugins",
];

/// Raíces de las rutas protegidas. Inyectables para que los tests usen una
/// carpeta temporal y nunca toquen la carpeta de usuario real.
#[derive(Debug, Clone)]
pub struct Roots {
    pub home: PathBuf,
    /// Documentos (puede estar redirigida a OneDrive); sin ella, `home/Documents`.
    pub documents: Option<PathBuf>,
}

impl Roots {
    pub fn from_system() -> Option<Self> {
        let home = dirs::home_dir()?;
        Some(Self {
            documents: dirs::document_dir(),
            home,
        })
    }

    fn documents(&self) -> PathBuf {
        self.documents
            .clone()
            .unwrap_or_else(|| self.home.join("Documents"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    PsProfile,
}

impl Filter {
    fn accepts(self, name: &str) -> bool {
        match self {
            Filter::All => true,
            Filter::PsProfile => {
                let n = name.to_ascii_lowercase();
                n.contains("profile") && n.ends_with(".ps1")
            }
        }
    }
}

#[derive(Debug, Clone)]
enum Target {
    File(PathBuf),
    Dir(PathBuf, Filter),
}

fn targets(roots: &Roots) -> Vec<Target> {
    let mut t: Vec<Target> = HOME_FILES
        .iter()
        .map(|r| Target::File(roots.home.join(r)))
        .collect();
    t.extend(
        HOME_DIRS
            .iter()
            .map(|r| Target::Dir(roots.home.join(r), Filter::All)),
    );
    let docs = roots.documents();
    t.extend(
        PS_PROFILE_DIRS
            .iter()
            .map(|r| Target::Dir(docs.join(r), Filter::PsProfile)),
    );
    t.extend(
        BULK_DIRS
            .iter()
            .map(|r| Target::Dir(roots.home.join(r), Filter::All)),
    );
    t
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Body {
    Bytes(Vec<u8>),
    TooLarge,
    OverBudget,
    Link(PathBuf),
    NotFile,
    Unreadable(String),
}

#[derive(Debug, Clone)]
struct FileState {
    size: u64,
    mtime: Option<SystemTime>,
    /// FNV-1a de 64 bits del contenido (solo si se leyó); para el registro.
    hash: Option<u64>,
    body: Body,
}

impl FileState {
    fn kind(&self) -> u8 {
        match self.body {
            Body::Link(_) => 1,
            Body::NotFile => 2,
            _ => 0,
        }
    }

    /// Mismo contenido: bytes si están los dos; si no, tamaño y fecha.
    fn same_as(&self, other: &FileState) -> bool {
        if self.kind() != other.kind() {
            return false;
        }
        match (&self.body, &other.body) {
            (Body::Bytes(a), Body::Bytes(b)) => a == b,
            (Body::Link(a), Body::Link(b)) => a == b,
            _ => self.size == other.size && self.mtime == other.mtime,
        }
    }

    fn unprotected_reason(&self) -> Option<String> {
        match &self.body {
            Body::TooLarge => Some(format!("más de {} MiB", MAX_FILE_BYTES / (1024 * 1024))),
            Body::OverBudget => Some(format!(
                "fuera del presupuesto de {} MiB por foto",
                MAX_TOTAL_BYTES / (1024 * 1024)
            )),
            Body::Link(_) => Some("enlace simbólico".into()),
            Body::NotFile => Some("no es un fichero".into()),
            Body::Unreadable(e) => Some(format!("no se pudo leer: {e}")),
            Body::Bytes(_) => None,
        }
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Foto de las rutas protegidas.
#[derive(Debug, Default)]
pub struct Snapshot {
    files: BTreeMap<PathBuf, FileState>,
    dirs: BTreeSet<PathBuf>,
    truncated: Vec<PathBuf>,
    stored: u64,
}

impl Snapshot {
    pub fn take(roots: &Roots) -> Snapshot {
        Self::take_with(roots, None)
    }

    /// `prior`: la foto de antes; sus ficheros copiados se releen siempre
    /// (aunque se acabe el presupuesto) para comparar byte a byte.
    fn take_with(roots: &Roots, prior: Option<&Snapshot>) -> Snapshot {
        let mut s = Snapshot::default();
        for t in targets(roots) {
            match t {
                Target::File(p) => s.scan_file_target(&p, prior),
                Target::Dir(p, f) => s.scan_dir_target(&p, f, prior),
            }
        }
        s
    }

    /// Rutas presentes que esta foto no puede restaurar, con el motivo.
    pub fn limits(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .files
            .iter()
            .filter_map(|(p, f)| {
                f.unprotected_reason()
                    .map(|r| format!("{}: {r}", p.display()))
            })
            .collect();
        out.extend(self.truncated.iter().map(|p| {
            format!(
                "{}: más de {MAX_DIR_ENTRIES} entradas, revisión truncada",
                p.display()
            )
        }));
        out
    }

    fn scan_file_target(&mut self, path: &Path, prior: Option<&Snapshot>) {
        match fs::symlink_metadata(path) {
            Ok(m) => self.record(path, &m, prior),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => self.record_unreadable(path, &e),
        }
    }

    fn scan_dir_target(&mut self, root: &Path, filter: Filter, prior: Option<&Snapshot>) {
        let meta = match fs::symlink_metadata(root) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(e) => return self.record_unreadable(root, &e),
        };
        if !meta.is_dir() {
            // Un fichero (o enlace) donde va la carpeta protegida.
            return self.record(root, &meta, prior);
        }
        if filter == Filter::All {
            self.dirs.insert(root.to_path_buf());
        }
        let max_depth = if filter == Filter::All {
            MAX_DIR_DEPTH
        } else {
            1
        };
        let mut budget = MAX_DIR_ENTRIES;
        if !self.scan_dir(root, 1, max_depth, filter, &mut budget, prior) {
            self.truncated.push(root.to_path_buf());
        }
    }

    /// Devuelve `false` si se agotó el cupo de entradas.
    fn scan_dir(
        &mut self,
        dir: &Path,
        level: usize,
        max_depth: usize,
        filter: Filter,
        budget: &mut usize,
        prior: Option<&Snapshot>,
    ) -> bool {
        let entries = match fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(e) => {
                self.record_unreadable(dir, &e);
                return true;
            }
        };
        let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        paths.sort();
        for p in paths {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let meta = match fs::symlink_metadata(&p) {
                Ok(m) => m,
                Err(e) => {
                    self.record_unreadable(&p, &e);
                    continue;
                }
            };
            if meta.is_dir() {
                if filter != Filter::All || SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if *budget == 0 {
                    return false;
                }
                *budget -= 1;
                self.dirs.insert(p.clone());
                if level < max_depth
                    && !self.scan_dir(&p, level + 1, max_depth, filter, budget, prior)
                {
                    return false;
                }
                continue;
            }
            if !filter.accepts(&name) {
                continue;
            }
            if *budget == 0 {
                return false;
            }
            *budget -= 1;
            self.record(&p, &meta, prior);
        }
        true
    }

    fn record_unreadable(&mut self, path: &Path, e: &io::Error) {
        let state = FileState {
            size: 0,
            mtime: None,
            hash: None,
            body: Body::Unreadable(e.to_string()),
        };
        self.files.insert(path.to_path_buf(), state);
    }

    fn record(&mut self, path: &Path, meta: &fs::Metadata, prior: Option<&Snapshot>) {
        let size = meta.len();
        let mtime = meta.modified().ok();
        let body = if meta.file_type().is_symlink() {
            Body::Link(fs::read_link(path).unwrap_or_default())
        } else if !meta.is_file() {
            Body::NotFile
        } else if size > MAX_FILE_BYTES {
            Body::TooLarge
        } else {
            let had_copy = prior
                .and_then(|p| p.files.get(path))
                .is_some_and(|f| matches!(f.body, Body::Bytes(_)));
            if !had_copy && self.stored + size > MAX_TOTAL_BYTES {
                Body::OverBudget
            } else {
                match fs::read(path) {
                    Ok(b) => {
                        self.stored += b.len() as u64;
                        Body::Bytes(b)
                    }
                    Err(e) => Body::Unreadable(e.to_string()),
                }
            }
        };
        let hash = match &body {
            Body::Bytes(b) => Some(fnv1a(b)),
            _ => None,
        };
        let state = FileState {
            size,
            mtime,
            hash,
            body,
        };
        self.files.insert(path.to_path_buf(), state);
    }
}

#[path = "guardrail_revert.rs"]
mod revert;

use revert::reconcile;

/// Guardarrail de un turno: foto al crearlo, revisión y reversión en `finish`.
pub struct Guard {
    roots: Option<Roots>,
    before: Option<Snapshot>,
}

impl Guard {
    pub fn start() -> Guard {
        match Roots::from_system() {
            Some(r) => Self::start_at(r),
            None => {
                tracing::warn!("guardarrail de Pupus: no se encontró la carpeta de usuario");
                Guard {
                    roots: None,
                    before: None,
                }
            }
        }
    }

    pub fn start_at(roots: Roots) -> Guard {
        let before = Snapshot::take(&roots);
        for l in before.limits() {
            tracing::warn!(limite = %l, "guardarrail de Pupus: ruta protegida sin copia");
        }
        Guard {
            roots: Some(roots),
            before: Some(before),
        }
    }

    /// Aviso para el usuario si el turno tocó algo protegido (o si el
    /// guardarrail no pudo actuar); `None` si no pasó nada.
    pub fn finish(self) -> Option<String> {
        let (Some(roots), Some(before)) = (self.roots, self.before) else {
            return Some(
                "Guardarrail de Pupus inactivo: no se encontró la carpeta de usuario, \
                 así que no se revisaron los ficheros protegidos tras este turno."
                    .into(),
            );
        };
        reconcile(&before, &roots).notice(&roots)
    }
}

/// Un turno con guardarraíl a la vez, en todo el proceso.
static TURN: Mutex<()> = Mutex::new(());

/// Foto, turno y revisión bajo un cerrojo global. Solapados (`close()` deja
/// abrir otro chat con el turno anterior en marcha), la foto del segundo
/// incluiría lo que el primero acaba revirtiendo, y el segundo lo repondría
/// creyendo que restaura el estado bueno. El segundo espera a que acabe el
/// primero: hasta 3 min (`CLI_TIMEOUT` de chat.rs).
pub fn serialized_turn<T>(
    start: impl FnOnce() -> Guard,
    run: impl FnOnce() -> T,
) -> (T, Option<String>) {
    let _turn = TURN.lock().unwrap_or_else(|p| p.into_inner());
    let guard = start();
    let out = run();
    (out, guard.finish())
}

#[cfg(test)]
#[path = "tests_guardrail.rs"]
mod tests;
