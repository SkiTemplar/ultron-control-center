// Mascota — lector mínimo de iCalendar (RFC 5545), puro y con tests.
//
// Solo lo que hace falta para las entregas: VEVENT y VTODO con su UID,
// SUMMARY, CATEGORIES, DESCRIPTION y la fecha (DUE si existe; si no,
// DTSTART). Despliega líneas plegadas (CRLF + espacio o tabulador) y
// deshace los escapes \\ \; \, \n.
//
// Fechas: «YYYYMMDD» es de todo el día y cuenta como el final de ese día
// en la hora local; «…T…Z» es UTC; con TZID o flotante se interpreta en la
// zona local del equipo. Límite declarado: con un TZID distinto de la zona
// del equipo la hora sale desplazada (sin chrono-tz no hay base de zonas).
// Se ignoran VTIMEZONE y las líneas mal formadas.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};

const DESCRIPTION_HEAD: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct IcsItem {
    pub uid: String,
    pub summary: String,
    pub categories: String,
    pub description_head: String,
    pub due: DateTime<Utc>,
    pub all_day: bool,
    /// Viene de un VTODO (una tarea: siempre es algo que entregar).
    pub todo: bool,
}

/// Junta las líneas plegadas (RFC 5545 §3.1).
pub fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        match (line.strip_prefix([' ', '\t']), out.last_mut()) {
            (Some(rest), Some(prev)) => prev.push_str(rest),
            _ => out.push(line.to_string()),
        }
    }
    out
}

/// Deshace los escapes de un valor de texto.
pub fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(o) => out.push(o),
            None => out.push('\\'),
        }
    }
    out
}

/// «NOMBRE;PARAM=x:VALOR» → (NOMBRE, «;PARAM=x», VALOR). Los dos puntos
/// dentro de comillas no cortan.
fn split_property(line: &str) -> Option<(String, &str, &str)> {
    let mut quoted = false;
    let colon = line.char_indices().find_map(|(i, c)| {
        if c == '"' {
            quoted = !quoted;
        }
        (c == ':' && !quoted).then_some(i)
    })?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let name_end = head.find(';').unwrap_or(head.len());
    Some((
        head[..name_end].to_ascii_uppercase(),
        &head[name_end..],
        value,
    ))
}

fn local_to_utc(naive: NaiveDateTime) -> Option<DateTime<Utc>> {
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.with_timezone(&Utc))
}

/// Fecha de DTSTART/DUE: (instante, todo el día).
pub fn parse_date(params: &str, value: &str) -> Option<(DateTime<Utc>, bool)> {
    let v = value.trim();
    let all_day = params.to_ascii_uppercase().contains("VALUE=DATE") && !v.contains('T');
    if all_day || (v.len() == 8 && v.chars().all(|c| c.is_ascii_digit())) {
        let d = NaiveDate::parse_from_str(&v[..8.min(v.len())], "%Y%m%d").ok()?;
        let end = d.and_time(NaiveTime::from_hms_opt(23, 59, 59)?);
        return local_to_utc(end).map(|t| (t, true));
    }
    if let Some(utc) = v.strip_suffix('Z') {
        let n = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&n), false));
    }
    let n = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    local_to_utc(n).map(|t| (t, false))
}

#[derive(Default)]
struct Draft {
    uid: String,
    summary: String,
    categories: String,
    description: String,
    start: Option<(DateTime<Utc>, bool)>,
    due: Option<(DateTime<Utc>, bool)>,
}

impl Draft {
    fn set(&mut self, name: &str, params: &str, value: &str) {
        match name {
            "UID" => self.uid = value.trim().to_string(),
            "SUMMARY" => self.summary = unescape(value).trim().to_string(),
            "CATEGORIES" => self.categories = unescape(value).trim().to_string(),
            "DESCRIPTION" => self.description = unescape(value),
            "DTSTART" => self.start = parse_date(params, value),
            "DUE" => self.due = parse_date(params, value),
            _ => {}
        }
    }

    fn finish(self, todo: bool) -> Option<IcsItem> {
        let (due, all_day) = self.due.or(self.start)?;
        Some(IcsItem {
            uid: self.uid,
            summary: self.summary,
            categories: self.categories,
            description_head: self.description.chars().take(DESCRIPTION_HEAD).collect(),
            due,
            all_day,
            todo,
        })
    }
}

/// Eventos y tareas con fecha del calendario.
pub fn parse_ics(text: &str) -> Vec<IcsItem> {
    let mut out = Vec::new();
    let mut cur: Option<(Draft, bool)> = None;
    for line in unfold(text) {
        let Some((name, params, value)) = split_property(&line) else {
            continue;
        };
        let block = value.trim().to_ascii_uppercase();
        match name.as_str() {
            "BEGIN" if block == "VEVENT" || block == "VTODO" => {
                cur = Some((Draft::default(), block == "VTODO"));
            }
            "END" if block == "VEVENT" || block == "VTODO" => {
                out.extend(cur.take().and_then(|(d, todo)| d.finish(todo)));
            }
            _ => {
                if let Some((d, _)) = cur.as_mut() {
                    d.set(&name, params, value);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    const FIXTURE: &str = include_str!("fixtures/calendar/uni-anon.ics");

    fn by_uid<'a>(items: &'a [IcsItem], uid: &str) -> &'a IcsItem {
        items
            .iter()
            .find(|i| i.uid == uid)
            .unwrap_or_else(|| panic!("falta {uid}"))
    }

    #[test]
    fn despliega_lineas_y_deshace_escapes() {
        let lines = unfold("SUMMARY:Entrega de la\r\n  práctica\r\nX:y");
        assert_eq!(lines[0], "SUMMARY:Entrega de la práctica");
        assert_eq!(unescape(r"a\, b\; c\\d\ne"), "a, b; c\\d\ne");
    }

    #[test]
    fn lee_fechas_de_todo_el_dia_utc_y_locales() {
        let items = parse_ics(FIXTURE);
        let day = by_uid(&items, "demo-002@example.invalid");
        assert!(day.all_day);
        let local = day.due.with_timezone(&Local);
        assert_eq!((local.hour(), local.minute()), (23, 59));
        let z = by_uid(&items, "demo-001@example.invalid");
        assert_eq!(z.due.to_rfc3339(), "2030-03-10T22:59:00+00:00");
        let tz = by_uid(&items, "demo-003@example.invalid");
        assert_eq!(
            tz.due.with_timezone(&Local).hour(),
            18,
            "TZID en la zona local"
        );
    }

    #[test]
    fn una_tarea_usa_due_y_conserva_texto_plegado() {
        let items = parse_ics(FIXTURE);
        let todo = by_uid(&items, "demo-004@example.invalid");
        assert_eq!(todo.summary, "XYZ2 — Memoria final, versión 2");
        assert_eq!(todo.due.to_rfc3339(), "2030-03-12T10:00:00+00:00");
        assert!(todo.todo);
        assert!(!by_uid(&items, "demo-001@example.invalid").todo);
    }

    #[test]
    fn ignora_zonas_horarias_y_lineas_rotas() {
        let items = parse_ics(
            "BEGIN:VTIMEZONE\nDTSTART:20300101T000000\nEND:VTIMEZONE\nbasura sin dos puntos\n",
        );
        assert!(items.is_empty());
        assert!(parse_date("", "no-es-fecha").is_none());
    }
}
