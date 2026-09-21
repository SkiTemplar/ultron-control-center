// Bitácora del proyecto — el historial de sesiones, a la vista.
//
// `session-summarize-previous.js` lleva desde 2026-09-11 escribiendo un
// resumen por sesión en `cockpit/projects/<id>/sessions/<sid>/summary.md`:
// temas, decisiones, pendientes y ficheros tocados, redactado por un modelo
// aparte. Hasta ahora sólo lo leía el hook de `SessionStart`, así que el dato
// existía y nadie podía verlo — el mandamiento 12 en estado puro.
//
// Este módulo lo expone como una lista navegable. El listado NO carga los
// cuerpos: con 19 sesiones en ultron son ~80 KB que la vista colapsada no
// necesita; `project_session_entry` trae uno entero cuando se despliega.
//
// Un `summary.md` con el frontmatter roto NO desaparece de la lista: cae a la
// fecha de modificación del fichero y se marca. Una sesión que no se ve es
// peor que una sesión mal fechada (mandamiento 11).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Tope del titular. Da para una frase reconocible sin romper la tarjeta.
const HEADLINE_MAX: usize = 120;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct SessionLogEntry {
    /// Id de la sesión de Claude Code (nombre de la carpeta).
    pub session_id: String,
    /// Inicio de la sesión, ISO-8601, extraído de `rango`.
    pub started_at: Option<String>,
    /// Duración en minutos, calculada del `rango`. `None` si no se pudo leer.
    pub duration_min: Option<i64>,
    /// Modelo que redactó el resumen.
    pub model: Option<String>,
    /// Cuándo se generó el resumen.
    pub generated_at: Option<String>,
    /// Primera línea de `## Temas`, recortada: de qué fue la sesión.
    pub headline: Option<String>,
    /// Ítems bajo `## Pendientes`.
    pub pending_count: usize,
    /// Secciones presentes, en el orden en que aparecen.
    pub sections: Vec<String>,
    /// Fecha de modificación del fichero (epoch), para ordenar cuando el
    /// frontmatter no trae `rango`.
    pub file_mtime: u64,
    /// `true` cuando el frontmatter no se pudo leer y los campos salen del
    /// propio fichero.
    pub degraded: bool,
}

// ---------------------------------------------------------------------------
// Parseo
// ---------------------------------------------------------------------------

/// Separa el frontmatter YAML del cuerpo. Devuelve `(frontmatter, cuerpo)`.
/// Sin frontmatter delimitado por `---`, todo es cuerpo.
fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    let trimmed = raw.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (None, trimmed);
    };
    let rest = rest.trim_start_matches(['\r', '\n']);
    match rest.find("\n---") {
        Some(end) => {
            let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
            (Some(&rest[..end]), body)
        }
        None => (None, trimmed),
    }
}

/// Valor de una clave del frontmatter (`clave: valor`, una por línea).
fn front_value<'a>(front: &'a str, key: &str) -> Option<&'a str> {
    front.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim();
        (!v.is_empty()).then_some(v)
    })
}

/// `rango: <inicio> .. <fin>` -> `(inicio, fin)`.
fn parse_range(raw: &str) -> Option<(String, String)> {
    let (a, b) = raw.split_once("..")?;
    let (a, b) = (a.trim(), b.trim());
    (!a.is_empty() && !b.is_empty()).then(|| (a.to_string(), b.to_string()))
}

/// Minutos entre dos instantes ISO-8601.
///
/// No hay chrono en este crate, así que se parsea el prefijo fijo
/// `YYYY-MM-DDTHH:MM` y se convierte a minutos absolutos con la cuenta de días
/// desde el año 0. Es exacto para el uso real (sesiones de horas, no de
/// milisegundos) y evita arrastrar una dependencia por una resta.
fn minutes_between(start: &str, end: &str) -> Option<i64> {
    let a = iso_to_minutes(start)?;
    let b = iso_to_minutes(end)?;
    (b >= a).then_some(b - a)
}

fn iso_to_minutes(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 16 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { iso.get(from..to)?.parse::<i64>().ok() };
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, min) = (num(11, 13)?, num(14, 16)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 {
        return None;
    }
    Some(days_from_civil(y, m, d) * 24 * 60 + h * 60 + min)
}

/// Días desde 0000-03-01, algoritmo civil de Howard Hinnant. Sólo se usa como
/// origen común para restar dos fechas, así que el desplazamiento da igual.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe
}

/// Títulos `## ...` en orden de aparición.
fn section_titles(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|l| l.strip_prefix("## "))
        .map(|t| t.trim().to_string())
        .collect()
}

/// Líneas de lista (`- `) directamente bajo la sección pedida.
fn section_items<'a>(body: &'a str, title: &str) -> Vec<&'a str> {
    let mut items = Vec::new();
    let mut inside = false;
    for line in body.lines() {
        if let Some(t) = line.strip_prefix("## ") {
            inside = t.trim() == title;
            continue;
        }
        if !inside {
            continue;
        }
        // Sólo el primer nivel: los sub-bullets indentados detallan al padre.
        if let Some(item) = line.strip_prefix("- ") {
            let item = item.trim();
            if !item.is_empty() {
                items.push(item);
            }
        }
    }
    items
}

/// Quita el marcado que no aporta en una línea de una tarjeta y recorta por
/// límite de caracteres (nunca a mitad de un carácter multibyte).
fn to_headline(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .filter(|c| !matches!(c, '`' | '*' | '_' | '[' | ']'))
        .collect();
    let clean = clean.trim();
    if clean.chars().count() <= HEADLINE_MAX {
        return clean.to_string();
    }
    let cut: String = clean.chars().take(HEADLINE_MAX).collect();
    // Corta en la última palabra entera para no dejar un fragmento.
    match cut.rfind(' ') {
        Some(i) if i > HEADLINE_MAX / 2 => format!("{}…", &cut[..i]),
        _ => format!("{cut}…"),
    }
}

/// Construye la entrada a partir del contenido del `summary.md`. Pura ->
/// unit-tested.
pub(crate) fn parse_entry(session_id: &str, raw: &str, file_mtime: u64) -> SessionLogEntry {
    let (front, body) = split_frontmatter(raw);

    let (started_at, duration_min) = front
        .and_then(|f| front_value(f, "rango"))
        .and_then(parse_range)
        .map(|(a, b)| {
            let mins = minutes_between(&a, &b);
            (Some(a), mins)
        })
        .unwrap_or((None, None));

    let headline = section_items(body, "Temas").first().map(|t| to_headline(t));

    SessionLogEntry {
        session_id: session_id.to_string(),
        started_at,
        duration_min,
        model: front
            .and_then(|f| front_value(f, "modelo"))
            .map(str::to_string),
        generated_at: front
            .and_then(|f| front_value(f, "generated_at"))
            .map(str::to_string),
        headline,
        pending_count: section_items(body, "Pendientes").len(),
        sections: section_titles(body),
        file_mtime,
        degraded: front.is_none(),
    }
}

// ---------------------------------------------------------------------------
// Lectura de disco
// ---------------------------------------------------------------------------

fn sessions_dir(project_id: &str) -> Result<PathBuf, String> {
    // Un id con separadores escaparía de cockpit/projects/ al componer la
    // ruta. Los ids del registro son slugs, así que rechazar es correcto.
    if project_id.is_empty()
        || project_id.contains(['/', '\\', ':'])
        || project_id.split('.').any(|s| s.is_empty())
    {
        return Err(format!("project id inválido: {project_id}"));
    }
    let home = dirs::home_dir().ok_or_else(|| "no HOME dir".to_string())?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("sessions"))
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Lista la bitácora de un proyecto, la sesión más reciente primero.
///
/// Un proyecto sin carpeta `sessions/` devuelve una lista vacía, no un error:
/// es el estado normal de un proyecto que todavía no se ha abierto desde que
/// existe el generador de resúmenes.
pub fn session_log_inner(project_id: &str) -> Result<Vec<SessionLogEntry>, String> {
    let dir = sessions_dir(project_id)?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut out: Vec<SessionLogEntry> = Vec::new();
    for entry in entries.flatten() {
        let summary = entry.path().join("summary.md");
        if !summary.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&summary) else {
            continue;
        };
        let session_id = entry.file_name().to_string_lossy().to_string();
        out.push(parse_entry(&session_id, &raw, mtime_of(&summary)));
    }

    // Por inicio de sesión cuando se conoce; el mtime del fichero sólo decide
    // entre las degradadas, que si no se hundirían siempre al final.
    out.sort_by(|a, b| {
        b.started_at
            .as_deref()
            .unwrap_or("")
            .cmp(a.started_at.as_deref().unwrap_or(""))
            .then(b.file_mtime.cmp(&a.file_mtime))
    });
    Ok(out)
}

/// Cuerpo completo de un resumen, para cuando la tarjeta se despliega.
pub fn session_entry_inner(project_id: &str, session_id: &str) -> Result<String, String> {
    if session_id.is_empty() || session_id.contains(['/', '\\', ':']) {
        return Err(format!("session id inválido: {session_id}"));
    }
    let path = sessions_dir(project_id)?
        .join(session_id)
        .join("summary.md");
    fs::read_to_string(&path).map_err(|e| format!("no se pudo leer el resumen: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Copia fiel de un summary.md real (ultron, 2026-09-21).
    const REAL: &str = "---\n\
session_id: 21da16c1-8e07-49b9-ac3a-1cd2ca325020\n\
rango: 2026-09-21T08:09:46.525Z .. 2026-09-21T11:24:24.280Z\n\
modelo: sonnet\n\
generated_at: 2026-09-21T15:04:21.671Z\n\
---\n\
\n\
## Temas\n\
- Aceleración del mini GitHub Desktop, medida sobre el repo ultron (1.089 commits).\n\
  - Abrir el modal: 113 ms y 3 comandos git → 45 ms y 1.\n\
- Revisión de código: 0 CRITICAL, 0 HIGH.\n\
\n\
## Decisiones\n\
- **Usuario:** acelerar el mini GitHub Desktop.\n\
\n\
## Pendientes\n\
- Verificación visual del usuario.\n\
- Detector EN (bloqueado).\n\
- `origin/iter-10` sigue sin decidir.\n\
\n\
## Ficheros/commits relevantes\n\
- `git_repo_snapshot`\n";

    #[test]
    fn reads_the_frontmatter_of_a_real_summary() {
        let e = parse_entry("sid", REAL, 42);
        assert_eq!(e.started_at.as_deref(), Some("2026-09-21T08:09:46.525Z"));
        assert_eq!(e.model.as_deref(), Some("sonnet"));
        assert_eq!(e.generated_at.as_deref(), Some("2026-09-21T15:04:21.671Z"));
        assert!(!e.degraded);
    }

    #[test]
    fn computes_the_duration_from_the_range() {
        let e = parse_entry("sid", REAL, 0);
        // 08:09 -> 11:24 = 3 h 15 min.
        assert_eq!(e.duration_min, Some(195));
    }

    #[test]
    fn duration_spans_midnight_and_month_ends() {
        assert_eq!(
            minutes_between("2026-09-21T23:30:00Z", "2026-09-22T00:15:00Z"),
            Some(45)
        );
        // 2026 no es bisiesto: del 28-feb al 1-mar van 2 horas.
        assert_eq!(
            minutes_between("2026-02-28T23:00:00Z", "2026-03-01T01:00:00Z"),
            Some(2 * 60)
        );
        // 2024 sí lo es, así que el 29 de febrero existe y suman 26 horas.
        assert_eq!(
            minutes_between("2024-02-28T23:00:00Z", "2024-03-01T01:00:00Z"),
            Some(26 * 60)
        );
    }

    #[test]
    fn a_backwards_or_unparseable_range_yields_no_duration() {
        assert_eq!(
            minutes_between("2026-09-21T11:00:00Z", "2026-09-21T08:00:00Z"),
            None
        );
        assert_eq!(minutes_between("ayer", "hoy"), None);
        assert_eq!(
            minutes_between("2026-13-01T00:00:00Z", "2026-13-02T00:00:00Z"),
            None
        );
    }

    #[test]
    fn headline_is_the_first_topic_without_markup() {
        let e = parse_entry("sid", REAL, 0);
        let h = e.headline.expect("titular");
        assert!(h.starts_with("Aceleración del mini GitHub Desktop"));
        assert!(!h.contains('`'));
    }

    /// Los sub-bullets detallan al padre: contarlos inflaría los pendientes.
    #[test]
    fn counts_only_top_level_pending_items() {
        let e = parse_entry("sid", REAL, 0);
        assert_eq!(e.pending_count, 3);
    }

    #[test]
    fn lists_the_sections_in_order() {
        let e = parse_entry("sid", REAL, 0);
        assert_eq!(
            e.sections,
            vec![
                "Temas".to_string(),
                "Decisiones".to_string(),
                "Pendientes".to_string(),
                "Ficheros/commits relevantes".to_string(),
            ]
        );
    }

    /// Caso negativo: sin frontmatter la entrada sigue existiendo, marcada.
    #[test]
    fn a_summary_without_frontmatter_degrades_instead_of_vanishing() {
        let e = parse_entry("sid", "## Temas\n- algo que se hizo\n", 1234);
        assert!(e.degraded);
        assert!(e.started_at.is_none());
        assert!(e.duration_min.is_none());
        assert_eq!(e.file_mtime, 1234);
        assert_eq!(e.headline.as_deref(), Some("algo que se hizo"));
    }

    #[test]
    fn an_empty_summary_still_produces_an_entry() {
        let e = parse_entry("sid", "", 7);
        assert!(e.degraded);
        assert!(e.headline.is_none());
        assert_eq!(e.pending_count, 0);
        assert!(e.sections.is_empty());
    }

    #[test]
    fn a_long_topic_is_cut_on_a_word_boundary() {
        let largo = "palabra ".repeat(40);
        let h = to_headline(&largo);
        assert!(
            h.chars().count() <= HEADLINE_MAX + 1,
            "{}",
            h.chars().count()
        );
        assert!(h.ends_with('…'));
        assert!(!h.contains("palabr…"));
    }

    /// Recortar por bytes partiría un carácter multibyte y entraría en pánico.
    #[test]
    fn headline_cut_is_safe_on_multibyte_text() {
        let largo = "ó".repeat(400);
        let h = to_headline(&largo);
        assert!(h.chars().count() <= HEADLINE_MAX + 1);
    }

    #[test]
    fn a_project_id_with_separators_is_rejected() {
        for malo in ["../otro", "a/b", "a\\b", "C:proyecto", ".."] {
            assert!(sessions_dir(malo).is_err(), "deberia rechazar: {malo}");
        }
        assert!(sessions_dir("ultron").is_ok());
        assert!(sessions_dir("risk-ranking").is_ok());
    }

    #[test]
    fn an_unknown_project_lists_empty_instead_of_failing() {
        let got = session_log_inner("proyecto-que-no-existe-ultron-test").expect("no debe fallar");
        assert!(got.is_empty());
    }

    #[test]
    fn entries_come_back_newest_first() {
        let mk = |sid: &str, inicio: &str| {
            parse_entry(
                sid,
                &format!("---\nrango: {inicio} .. {inicio}\n---\n\n## Temas\n- x\n"),
                0,
            )
        };
        let mut v = [
            mk("vieja", "2026-09-01T10:00:00Z"),
            mk("nueva", "2026-09-21T10:00:00Z"),
            mk("media", "2026-09-10T10:00:00Z"),
        ];
        v.sort_by(|a, b| {
            b.started_at
                .as_deref()
                .unwrap_or("")
                .cmp(a.started_at.as_deref().unwrap_or(""))
                .then(b.file_mtime.cmp(&a.file_mtime))
        });
        let ids: Vec<&str> = v.iter().map(|e| e.session_id.as_str()).collect();
        assert_eq!(ids, vec!["nueva", "media", "vieja"]);
    }
}

/// Lectura contra el disco real de esta maquina. Fuera de la suite (`#[ignore]`)
/// porque depende de que existan sesiones resumidas; se ejecuta a mano con
/// `cargo test --features qdrant reads_the_real_log -- --ignored --nocapture`
/// para comprobar el camino completo, no solo el parseo.
#[cfg(test)]
mod runtime_check {
    use super::*;

    #[test]
    #[ignore]
    fn reads_the_real_log_of_this_machine() {
        let entries = session_log_inner("ultron").expect("la bitacora debe leerse");
        println!("entradas: {}", entries.len());
        for e in entries.iter().take(5) {
            println!(
                "  {} | {} | {:?} min | {} pend | {}",
                e.started_at.as_deref().unwrap_or("sin fecha"),
                e.model.as_deref().unwrap_or("?"),
                e.duration_min,
                e.pending_count,
                e.headline.as_deref().unwrap_or("(sin titular)")
            );
        }
        assert!(!entries.is_empty(), "ultron tiene resumenes en disco");
        // Lo que de verdad importa: que el frontmatter se este leyendo.
        let con_fecha = entries.iter().filter(|e| e.started_at.is_some()).count();
        let con_titular = entries.iter().filter(|e| e.headline.is_some()).count();
        println!(
            "con fecha: {con_fecha}/{} · con titular: {con_titular}/{}",
            entries.len(),
            entries.len()
        );
        assert_eq!(con_fecha, entries.len(), "toda entrada real trae rango");
    }
}
