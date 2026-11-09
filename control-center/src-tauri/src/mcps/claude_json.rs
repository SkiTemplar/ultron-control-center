// mcps/claude_json.rs — Escritura de `mcpServers` en ~/.claude.json.
//
// H14 (2026-10-17): Add/Edit/Delete de la pestaña MCPs escribían en
// `~/.claude/settings.json.mcpServers`, que Claude Code no lee para MCP. El
// ámbito de usuario real es el `mcpServers` de primer nivel de
// `~/.claude.json`, un fichero que Claude Code reescribe a menudo (historial,
// proyectos, contadores). Reglas de escritura:
//
// - Ida y vuelta sobre `serde_json::Value`: se conservan todas las claves,
//   conocidas o no. Sin `preserve_order` en serde_json las claves salen en
//   orden alfabético; el contenido es el mismo.
// - Un fichero que no parsea NO se toca (nunca se pisa un JSON corrupto).
// - Copia de seguridad de los bytes leídos antes de escribir, y escritura
//   atómica (temporal en la misma carpeta + rename).
// - Concurrencia optimista: justo antes de escribir se relee el fichero; si
//   Claude Code lo cambió entre medias, se reaplica la mutación sobre el
//   contenido nuevo (hasta `MAX_ATTEMPTS`) en vez de pisar su cambio.
// - Permisos (2026-10-17): `~/.claude.json` lleva tokens OAuth y claves de
//   MCP. En Unix la copia de seguridad y el temporal se crean con modo 0o600
//   y el temporal recibe los permisos del original antes del rename, así que
//   el fichero final conserva los que tenía. En Windows `Permissions` solo
//   lleva el bit de solo lectura: los ficheros nuevos heredan las ACL de la
//   carpeta del perfil (`%USERPROFILE%`, solo el usuario, SYSTEM y
//   administradores), que es lo mismo que protege al original.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Serializa las mutaciones de este proceso. La relectura optimista solo
/// detecta escritores externos (Claude Code): dos comandos de la app que
/// muten a la vez pasarían ambos la relectura y el último rename borraría
/// el cambio del primero, que ya habría respondido «éxito».
static MUTATE_LOCK: Mutex<()> = Mutex::new(());
/// Sufijo único del temporal: dos escrituras del mismo proceso no comparten
/// fichero aunque coincidan en el tiempo.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Intentos de la concurrencia optimista antes de rendirse.
const MAX_ATTEMPTS: usize = 3;
/// Copias de seguridad de este módulo que se conservan.
const MAX_BACKUPS: usize = 20;
const BACKUP_PREFIX: &str = "claude.json.mcp.";

pub(super) struct ClaudeJsonStore {
    path: PathBuf,
    backup_dir: PathBuf,
}

impl ClaudeJsonStore {
    /// `~/.claude.json` con copias en `~/.ultron/backups/claude-json/` (la
    /// misma carpeta que usan las cuentas multi-token).
    pub(super) fn user() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
        Ok(Self::at(
            home.join(".claude.json"),
            home.join(".ultron").join("backups").join("claude-json"),
        ))
    }

    pub(super) fn at(path: PathBuf, backup_dir: PathBuf) -> Self {
        Self { path, backup_dir }
    }

    fn read_raw(&self) -> Result<Option<String>, String> {
        match fs::read_to_string(&self.path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("leer {}: {e}", self.path.display())),
        }
    }

    fn parse(&self, raw: Option<&str>) -> Result<serde_json::Value, String> {
        let Some(raw) = raw else {
            return Ok(serde_json::Value::Object(serde_json::Map::new()));
        };
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
            format!(
                "{} no es JSON válido ({e}); no se modifica",
                self.path.display()
            )
        })?;
        if !value.is_object() {
            return Err(format!("{} no es un objeto JSON", self.path.display()));
        }
        Ok(value)
    }

    /// Entrada `mcpServers[name]` de primer nivel, tal cual (con `env`).
    pub(super) fn server(&self, name: &str) -> Result<Option<serde_json::Value>, String> {
        let raw = self.read_raw()?;
        let root = self.parse(raw.as_deref())?;
        Ok(root.get("mcpServers").and_then(|v| v.get(name)).cloned())
    }

    /// Aplica `f` al objeto `mcpServers` de primer nivel y guarda. Devuelve
    /// la ruta de la copia de seguridad (`None` si el fichero no existía).
    /// `f` puede ejecutarse más de una vez (reintento optimista).
    pub(super) fn mutate<F>(&self, mut f: F) -> Result<Option<String>, String>
    where
        F: FnMut(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>,
    {
        // Un pánico previo con el candado tomado no invalida el fichero: cada
        // pasada relee del disco, así que se sigue con el candado envenenado.
        let _guard = MUTATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..MAX_ATTEMPTS {
            let raw = self.read_raw()?;
            let mut root = self.parse(raw.as_deref())?;
            let servers = root
                .as_object_mut()
                .ok_or_else(|| "~/.claude.json no es un objeto JSON".to_string())?
                .entry("mcpServers".to_string())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
                .as_object_mut()
                .ok_or_else(|| "mcpServers no es un objeto".to_string())?;
            f(servers)?;

            let mut body =
                serde_json::to_string_pretty(&root).map_err(|e| format!("serializar: {e}"))?;
            if raw.as_deref().is_some_and(|r| r.ends_with('\n')) {
                body.push('\n');
            }
            // Releer justo antes de escribir: si cambió, se reintenta.
            if self.read_raw()? != raw {
                continue;
            }
            let backup = match raw.as_deref() {
                Some(r) => Some(self.write_backup(r)?),
                None => None,
            };
            self.write_atomic(&body)?;
            return Ok(backup.map(|p| p.display().to_string()));
        }
        Err(format!(
            "{} cambió {MAX_ATTEMPTS} veces mientras se guardaba; reinténtalo",
            self.path.display()
        ))
    }

    fn write_backup(&self, raw: &str) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.backup_dir).map_err(|e| format!("mkdir backups: {e}"))?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
        let backup = self.backup_dir.join(format!("{BACKUP_PREFIX}{stamp}.bak"));
        write_private(&backup, raw).map_err(|e| format!("backup: {e}"))?;
        prune_backups(&self.backup_dir, MAX_BACKUPS);
        Ok(backup)
    }

    fn write_atomic(&self, body: &str) -> Result<(), String> {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = self
            .path
            .with_extension(format!("json.mcp-tmp.{}.{seq}", std::process::id()));
        write_private(&tmp, body).map_err(|e| format!("escribir temporal: {e}"))?;
        // Los permisos del original pasan al temporal: el rename no debe
        // dejar el fichero final más abierto (ni más cerrado) que estaba.
        let copied = match fs::metadata(&self.path) {
            Ok(meta) => fs::set_permissions(&tmp, meta.permissions())
                .map_err(|e| format!("copiar permisos al temporal: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("leer permisos de {}: {e}", self.path.display())),
        };
        if let Err(e) = copied {
            discard_tmp(&tmp);
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, &self.path) {
            discard_tmp(&tmp);
            return Err(format!("rename atómico de {}: {e}", self.path.display()));
        }
        Ok(())
    }
}

/// Escribe `contents` en un fichero solo legible por el usuario: modo 0o600 en
/// Unix (también si ya existía); en Windows, las ACL heredadas del perfil.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // `mode` solo actúa al crear: un fichero previo se cierra igual.
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents)
    }
}

/// Borra un temporal fallido. Si heredó el solo lectura del original, en
/// Windows `remove_file` fallaría: primero se quita el bit.
fn discard_tmp(tmp: &Path) {
    if let Ok(meta) = fs::metadata(tmp) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(tmp, perms);
        }
    }
    let _ = fs::remove_file(tmp);
}

/// Borra las copias más antiguas de este módulo por encima de `keep`. Las
/// de las cuentas multi-token (otro prefijo) no se tocan.
fn prune_backups(dir: &Path, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let mut ours: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(BACKUP_PREFIX) && n.ends_with(".bak"))
        })
        .collect();
    if ours.len() <= keep {
        return;
    }
    // El sello `%Y%m%d-%H%M%S%.3f` ordena igual como texto que como fecha.
    ours.sort();
    let excess = ours.len() - keep;
    for p in ours.into_iter().take(excess) {
        if let Err(e) = fs::remove_file(&p) {
            tracing::debug!(path = %p.display(), error = %e, "no se pudo podar la copia");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tmp: &tempfile::TempDir) -> ClaudeJsonStore {
        ClaudeJsonStore::at(tmp.path().join(".claude.json"), tmp.path().join("backups"))
    }

    #[test]
    fn mutate_keeps_unknown_keys_and_backs_up() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(&tmp);
        let original = r#"{"numStartups": 42, "projects": {"C:/x": {"mcpServers": {"p": {"command": "node"}}}}, "mcpServers": {"a": {"command": "node", "extra": true}}}"#;
        fs::write(tmp.path().join(".claude.json"), original).unwrap();

        let backup = s
            .mutate(|servers| {
                servers.insert(
                    "b".into(),
                    serde_json::json!({"command": "npx", "args": []}),
                );
                Ok(())
            })
            .expect("mutate")
            .expect("backup path");

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(tmp.path().join(".claude.json")).unwrap())
                .unwrap();
        assert_eq!(after["numStartups"], 42);
        assert_eq!(
            after["projects"]["C:/x"]["mcpServers"]["p"]["command"],
            "node"
        );
        assert_eq!(after["mcpServers"]["a"]["extra"], true);
        assert_eq!(after["mcpServers"]["b"]["command"], "npx");
        assert_eq!(fs::read_to_string(backup).unwrap(), original);
    }

    /// Unix: el fichero final conserva el modo del original y la copia de
    /// seguridad queda en 0o600 (antes, permisos por defecto: 0o644 con la
    /// umask habitual, legible por otros usuarios).
    #[cfg(unix)]
    #[test]
    fn mutate_keeps_original_mode_and_backup_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let s = store(&tmp);
        let path = tmp.path().join(".claude.json");
        fs::write(&path, r#"{"mcpServers": {}}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let backup = s
            .mutate(|servers| {
                servers.insert("x".into(), serde_json::json!({"command": "npx"}));
                Ok(())
            })
            .unwrap()
            .expect("backup path");
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o640);
        assert_eq!(mode(Path::new(&backup)), 0o600);
    }

    #[test]
    fn corrupt_file_is_never_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(&tmp);
        fs::write(tmp.path().join(".claude.json"), "{ roto").unwrap();
        let res = s.mutate(|servers| {
            servers.insert("b".into(), serde_json::json!({}));
            Ok(())
        });
        assert!(res.is_err());
        assert_eq!(
            fs::read_to_string(tmp.path().join(".claude.json")).unwrap(),
            "{ roto"
        );
    }

    #[test]
    fn closure_error_leaves_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(&tmp);
        let original = r#"{"mcpServers": {"a": {"command": "node"}}}"#;
        fs::write(tmp.path().join(".claude.json"), original).unwrap();
        let res = s.mutate(|_| Err("no".to_string()));
        assert!(res.is_err());
        assert_eq!(
            fs::read_to_string(tmp.path().join(".claude.json")).unwrap(),
            original
        );
        assert!(!tmp.path().join("backups").exists());
    }

    #[test]
    fn missing_file_is_created_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store(&tmp);
        let backup = s
            .mutate(|servers| {
                servers.insert("a".into(), serde_json::json!({"command": "node"}));
                Ok(())
            })
            .expect("mutate");
        assert!(backup.is_none());
        assert_eq!(
            s.server("a").unwrap().unwrap()["command"],
            serde_json::json!("node")
        );
    }

    #[test]
    fn concurrent_change_is_reapplied_not_lost() {
        // Simula a Claude Code escribiendo entre la lectura y la escritura:
        // la primera pasada de la mutación cambia el fichero por detrás.
        let tmp = tempfile::tempdir().unwrap();
        let s = store(&tmp);
        let path = tmp.path().join(".claude.json");
        fs::write(&path, r#"{"mcpServers": {}, "counter": 1}"#).unwrap();
        let mut first = true;
        s.mutate(|servers| {
            if first {
                first = false;
                fs::write(&path, r#"{"mcpServers": {}, "counter": 2}"#).unwrap();
            }
            servers.insert("b".into(), serde_json::json!({"command": "node"}));
            Ok(())
        })
        .expect("mutate");
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["counter"], 2, "se perdió el cambio concurrente");
        assert_eq!(after["mcpServers"]["b"]["command"], "node");
    }

    #[test]
    fn concurrent_mutations_in_process_lose_nothing() {
        // Sin el candado, dos hilos pasan la relectura con el mismo contenido
        // y el último rename borra la clave del otro (o comparten temporal).
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".claude.json");
        fs::write(&path, r#"{"mcpServers": {}}"#).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                let backups = tmp.path().join("backups");
                std::thread::spawn(move || {
                    ClaudeJsonStore::at(path, backups).mutate(|servers| {
                        servers.insert(format!("s{i}"), serde_json::json!({"command": "node"}));
                        Ok(())
                    })
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("mutate");
        }
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let servers = after["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 8, "se perdió alguna alta: {servers:?}");
    }

    #[test]
    fn prune_keeps_only_newest_of_our_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for i in 0..5 {
            fs::write(
                dir.join(format!("{BACKUP_PREFIX}2026010{i}-000000.000.bak")),
                "x",
            )
            .unwrap();
        }
        fs::write(dir.join("claude.json.20260101-000000.bak"), "ajena").unwrap();
        prune_backups(dir, 2);
        let mut left: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left.len(), 3);
        assert!(left.contains(&"claude.json.20260101-000000.bak".to_string()));
        assert!(left.contains(&format!("{BACKUP_PREFIX}20260104-000000.000.bak")));
        assert!(left.contains(&format!("{BACKUP_PREFIX}20260103-000000.000.bak")));
    }
}
