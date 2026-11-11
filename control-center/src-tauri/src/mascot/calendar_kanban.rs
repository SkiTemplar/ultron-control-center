// Mascota — cada entrega del calendario, una tarjeta en el kanban de su
// asignatura (cero tokens).
//
// Tras cada descarga (calendar.rs), cada entrega próxima con asignatura
// conocida crea una tarjeta en la columna de pendientes del primer proyecto
// de esa asignatura en curso.json, con la fecha en el título y las etiquetas
// `entrega`, `vence:AAAA-MM-DD` y `cal:<uid>`.
//
// No se duplica: el registro .tmp/mascot-calendar-kanban.json guarda los UID
// ya llevados, así que una tarjeta archivada o borrada a mano no vuelve; si
// el registro se pierde, la etiqueta `cal:<uid>` del tablero hace de red.
// Si Blackboard cambia la fecha, la tarjeta viva se actualiza (`plan_updates`):
// etiqueta `vence:` y título, salvo que el usuario lo haya retitulado.
// Una entrega sin asignatura (ninguna palabra clave la delata) no crea nada
// y se queda en el calendario de Pupus con su título.

use std::collections::BTreeSet;
use std::path::PathBuf;

use chrono::Local;

use super::calendar::normalize;
use super::calendar_fetch::CachedItem;
use super::course::{self, Subject};
use crate::kanban::{self, CardPartial, ColumnRole};

const TAG_PREFIX: &str = "cal:";
const DUE_TAG_PREFIX: &str = "vence:";

/// Lo que va al kanban: proyecto y tarjeta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCard {
    pub uid: String,
    pub project: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
}

/// Asignatura de una entrega: la que lista su UID; si no, la que ya trae
/// resuelta y, si curso.json ha ganado palabras clave desde la descarga, la
/// de su título.
fn subject_of<'a>(item: &CachedItem, subjects: &'a [Subject]) -> Option<&'a Subject> {
    course::by_uid(subjects, &item.uid)
        .or_else(|| subjects.iter().find(|s| s.code == item.subject))
        .or_else(|| course::find(subjects, &normalize(&item.title)))
}

/// Tarjeta de una entrega. Pura salvo la zona horaria local.
pub fn card_for(item: &CachedItem, subject: &Subject, project: &str) -> NewCard {
    let due = item.due.with_timezone(&Local);
    let when = if item.all_day {
        due.format("%d/%m").to_string()
    } else {
        due.format("%d/%m %H:%M").to_string()
    };
    NewCard {
        uid: item.uid.clone(),
        project: project.to_string(),
        title: format!("Entrega {}: {} · {when}", subject.code, item.title),
        description: format!(
            "Entrega de {} ({}) con fecha {when}. Tarjeta creada por Pupus desde el calendario de la universidad.",
            subject.code, subject.name
        ),
        tags: vec![
            "entrega".into(),
            format!("vence:{}", due.format("%Y-%m-%d")),
            format!("{TAG_PREFIX}{}", item.uid),
        ],
    }
}

/// Tarjetas que faltan: entregas con asignatura y proyecto que no estén ya
/// en `done` (registro y etiquetas del tablero). Pura.
pub fn plan(items: &[CachedItem], subjects: &[Subject], done: &BTreeSet<String>) -> Vec<NewCard> {
    items
        .iter()
        .filter(|i| !i.uid.is_empty() && !done.contains(&i.uid))
        .filter_map(|i| {
            let s = subject_of(i, subjects)?;
            let project = s.project.as_deref()?;
            Some(card_for(i, s, project))
        })
        .collect()
}

/// Cambio de fecha que hay que llevar a una tarjeta ya creada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardUpdate {
    pub card_id: String,
    pub project: String,
    /// `None`: el usuario retituló la tarjeta; su título no se pisa.
    pub title: Option<String>,
    pub tags: Vec<String>,
}

/// Actualización de una tarjeta si su entrega cambió de fecha. Pura.
fn update_for(card: &kanban::Card, fresh: &NewCard, prefix: &str) -> Option<CardUpdate> {
    let due = fresh.tags.iter().find(|t| t.starts_with(DUE_TAG_PREFIX))?;
    let same_due = card.tags.contains(due);
    let title =
        (card.title != fresh.title && card.title.starts_with(prefix)).then(|| fresh.title.clone());
    if same_due && title.is_none() {
        return None;
    }
    let tags = card
        .tags
        .iter()
        .filter(|t| !t.starts_with(DUE_TAG_PREFIX))
        .cloned()
        .chain(std::iter::once(due.clone()))
        .collect();
    Some(CardUpdate {
        card_id: card.id.clone(),
        project: fresh.project.clone(),
        title,
        tags,
    })
}

/// Tarjetas de `board` cuya entrega cambió de fecha en el calendario. Las
/// borradas a mano no vuelven (no están en el tablero) y las terminadas no se
/// tocan. Pura salvo la zona horaria local.
pub fn plan_updates(
    items: &[CachedItem],
    subjects: &[Subject],
    project: &str,
    board: &kanban::KanbanBoard,
) -> Vec<CardUpdate> {
    let done_cols: BTreeSet<&str> = board
        .columns
        .iter()
        .filter(|c| c.role == ColumnRole::Done)
        .map(|c| c.id.as_str())
        .collect();
    items
        .iter()
        .filter(|i| !i.uid.is_empty())
        .filter_map(|i| {
            let s = subject_of(i, subjects).filter(|s| s.project.as_deref() == Some(project))?;
            let tag = format!("{TAG_PREFIX}{}", i.uid);
            let card = board
                .cards
                .iter()
                .find(|c| c.tags.contains(&tag) && !done_cols.contains(c.column_id.as_str()))?;
            let prefix = format!("Entrega {}: {} · ", s.code, i.title);
            update_for(card, &card_for(i, s, project), &prefix)
        })
        .collect()
}

fn apply_update(u: CardUpdate) -> Result<(), String> {
    let patch = kanban::CardPatch {
        title: u.title,
        description: None,
        agent: None,
        prompt_template: None,
        cwd: None,
        project: None,
        tags: Some(u.tags),
    };
    kanban::update_card(&u.project, &u.card_id, patch).map(|_| ())
}

fn ledger_path() -> Option<PathBuf> {
    crate::ultron_root()
        .ok()
        .map(|r| r.join(".tmp").join("mascot-calendar-kanban.json"))
}

fn load_ledger() -> BTreeSet<String> {
    ledger_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<BTreeSet<String>>(&s).ok())
        .unwrap_or_default()
}

fn save_ledger(uids: &BTreeSet<String>) -> Result<(), String> {
    let path = ledger_path().ok_or("sin carpeta de ULTRON")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(uids).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("guardar {}: {e}", path.display()))
}

/// UID que ya tienen tarjeta en el tablero (etiqueta `cal:<uid>`).
fn uids_on_board(board: &kanban::KanbanBoard) -> impl Iterator<Item = String> + '_ {
    board
        .cards
        .iter()
        .flat_map(|c| c.tags.iter())
        .filter_map(|t| t.strip_prefix(TAG_PREFIX).map(str::to_string))
}

/// Crea las tarjetas que faltan. Devuelve cuántas creó; un tablero que no
/// se puede leer o escribir no para a los demás (el error se devuelve al
/// final y esas entregas se reintentan en la descarga siguiente).
pub fn sync(items: &[CachedItem], subjects: &[Subject]) -> Result<usize, String> {
    let mut done = load_ledger();
    let mut created = 0;
    let mut errors = Vec::new();
    let projects: BTreeSet<&str> = subjects
        .iter()
        .filter_map(|s| s.project.as_deref())
        .collect();
    for project in projects {
        match kanban::load(project) {
            Ok(board) => {
                done.extend(uids_on_board(&board));
                let updates = plan_updates(items, subjects, project, &board);
                errors.extend(
                    updates
                        .into_iter()
                        .filter_map(|u| apply_update(u).err())
                        .map(|e| format!("{project}: {e}")),
                );
            }
            Err(e) => errors.push(format!("{project}: {e}")),
        }
    }
    for card in plan(items, subjects, &done) {
        match create(&card) {
            Ok(()) => {
                done.insert(card.uid.clone());
                created += 1;
            }
            Err(e) => errors.push(format!("{}: {e}", card.project)),
        }
    }
    save_ledger(&done)?;
    if errors.is_empty() {
        Ok(created)
    } else {
        Err(format!("{created} creadas; fallos: {}", errors.join("; ")))
    }
}

fn create(card: &NewCard) -> Result<(), String> {
    let board = kanban::load(&card.project)?;
    let column = board
        .columns
        .iter()
        .find(|c| c.role == ColumnRole::Todo)
        .ok_or("el tablero no tiene columna de pendientes")?;
    kanban::create_card(
        &card.project,
        &column.id,
        CardPartial {
            title: card.title.clone(),
            description: card.description.clone(),
            agent: None,
            prompt_template: None,
            cwd: None,
            project: None,
            tags: card.tags.clone(),
        },
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn item(uid: &str, subject: &str, title: &str) -> CachedItem {
        CachedItem {
            uid: uid.into(),
            subject: subject.into(),
            title: title.into(),
            due: Utc.with_ymd_and_hms(2026, 11, 9, 22, 55, 0).unwrap(),
            all_day: false,
        }
    }

    fn subjects() -> Vec<Subject> {
        let mut isw = Subject::new("ISW", "Ingeniería del Software", &["uml"]);
        isw.project = Some("isw-proyecto".into());
        let sin_proyecto = Subject::new("DVJ", "Diseño de Videojuegos", &["gdd"]);
        vec![isw, sin_proyecto]
    }

    #[test]
    fn una_entrega_con_asignatura_y_proyecto_crea_su_tarjeta() {
        let cards = plan(
            &[item("u1", "ISW", "Entrega 2 - UML")],
            &subjects(),
            &BTreeSet::new(),
        );
        assert_eq!(cards.len(), 1);
        let c = &cards[0];
        assert_eq!(c.project, "isw-proyecto");
        assert!(
            c.title.starts_with("Entrega ISW: Entrega 2 - UML · "),
            "{}",
            c.title
        );
        assert!(c.tags.contains(&"cal:u1".to_string()));
        assert!(c.tags.iter().any(|t| t.starts_with("vence:2026-11-")));
    }

    #[test]
    fn el_titulo_resuelve_la_asignatura_si_la_cache_no_la_traia() {
        // Descargada antes de añadir la palabra clave: la caché guardó el título.
        let cards = plan(
            &[item("u2", "Entrega 3 - UML", "Entrega 3 - UML")],
            &subjects(),
            &BTreeSet::new(),
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].project, "isw-proyecto");
    }

    #[test]
    fn el_uid_listado_corrige_una_asignatura_mal_resuelta() {
        let mut s = subjects();
        s[0].uids = vec!["bb-1".into()];
        // La caché la había resuelto como DVJ (sin proyecto); el UID la lleva a ISW.
        let cards = plan(&[item("bb-1", "DVJ", "Actividad 2")], &s, &BTreeSet::new());
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].project, "isw-proyecto");
    }

    fn board_with(cards: Vec<kanban::Card>) -> kanban::KanbanBoard {
        let mut b = crate::kanban::board_io::default_board("isw-proyecto");
        b.cards = cards;
        b
    }

    /// Tablero con la tarjeta que `sync` habría creado para `i`, en la columna
    /// de `role` de ese mismo tablero.
    fn board_of(role: ColumnRole, i: &CachedItem) -> kanban::KanbanBoard {
        let subs = subjects();
        let c = card_for(i, &subs[0], "isw-proyecto");
        let mut board = board_with(vec![]);
        let col = board.columns.iter().find(|k| k.role == role).unwrap();
        let card: kanban::Card = serde_json::from_value(serde_json::json!({
            "id": "c1", "column_id": col.id, "title": c.title, "description": c.description,
            "tags": c.tags, "order": 0, "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }))
        .unwrap();
        board.cards = vec![card];
        board
    }

    fn moved(i: &CachedItem, days: i64) -> CachedItem {
        CachedItem {
            due: i.due + chrono::Duration::days(days),
            ..i.clone()
        }
    }

    #[test]
    fn un_cambio_de_fecha_llega_a_la_tarjeta_viva() {
        let viejo = item("u1", "ISW", "Entrega 2 - UML");
        let nuevo = moved(&viejo, 7);
        let mut b = board_of(ColumnRole::Todo, &viejo);
        b.cards[0].tags.push("mia".into());
        let ups = plan_updates(
            std::slice::from_ref(&nuevo),
            &subjects(),
            "isw-proyecto",
            &b,
        );
        assert_eq!(ups.len(), 1);
        let u = &ups[0];
        assert_eq!(u.card_id, "c1");
        let due = nuevo
            .due
            .with_timezone(&Local)
            .format("vence:%Y-%m-%d")
            .to_string();
        assert!(u.tags.contains(&due), "{:?}", u.tags);
        assert_eq!(
            u.tags.iter().filter(|t| t.starts_with("vence:")).count(),
            1,
            "la fecha vieja no se queda: {:?}",
            u.tags
        );
        assert!(
            u.tags.contains(&"mia".to_string()),
            "las etiquetas propias siguen"
        );
        let when = nuevo
            .due
            .with_timezone(&Local)
            .format("%d/%m %H:%M")
            .to_string();
        assert!(
            u.title.as_deref().unwrap().ends_with(&when),
            "{:?}",
            u.title
        );
        // Caso negativo: sin cambio de fecha no se toca nada.
        assert!(plan_updates(&[viejo], &subjects(), "isw-proyecto", &b).is_empty());
    }

    #[test]
    fn el_cambio_de_hora_el_mismo_dia_actualiza_el_titulo() {
        let viejo = item("u1", "ISW", "Entrega 2 - UML");
        let nuevo = CachedItem {
            due: viejo.due - chrono::Duration::minutes(5),
            ..viejo.clone()
        };
        let b = board_of(ColumnRole::Todo, &viejo);
        let ups = plan_updates(&[nuevo], &subjects(), "isw-proyecto", &b);
        assert_eq!(ups.len(), 1);
        assert!(ups[0].title.is_some());
    }

    #[test]
    fn un_titulo_cambiado_a_mano_no_se_pisa_pero_la_fecha_si() {
        let viejo = item("u1", "ISW", "Entrega 2 - UML");
        let mut b = board_of(ColumnRole::Todo, &viejo);
        b.cards[0].title = "UML, la buena".into();
        let ups = plan_updates(&[moved(&viejo, 3)], &subjects(), "isw-proyecto", &b);
        assert_eq!(ups.len(), 1);
        assert_eq!(ups[0].title, None);
        assert!(ups[0].tags.iter().any(|t| t.starts_with("vence:")));
    }

    #[test]
    fn terminadas_borradas_y_de_otro_proyecto_no_se_tocan() {
        let viejo = item("u1", "ISW", "Entrega 2 - UML");
        let nuevo = moved(&viejo, 7);
        let hecha = board_of(ColumnRole::Done, &viejo);
        assert!(plan_updates(
            std::slice::from_ref(&nuevo),
            &subjects(),
            "isw-proyecto",
            &hecha
        )
        .is_empty());
        // Borrada a mano: no está en el tablero y no vuelve.
        let vacio = board_with(vec![]);
        assert!(plan_updates(
            std::slice::from_ref(&nuevo),
            &subjects(),
            "isw-proyecto",
            &vacio
        )
        .is_empty());
        let viva = board_of(ColumnRole::Todo, &viejo);
        assert!(plan_updates(&[nuevo], &subjects(), "otro", &viva).is_empty());
    }

    #[test]
    fn no_duplica_ni_inventa() {
        let done: BTreeSet<String> = ["u1".to_string()].into();
        let items = [
            item("u1", "ISW", "Entrega 2 - UML"),
            item("u3", "Actividad 2", "Actividad 2"),
            item("u4", "DVJ", "GDD final"),
            item("", "ISW", "sin uid"),
        ];
        // u1 ya está; u3 no tiene asignatura; u4 no tiene proyecto; sin uid no se puede deduplicar.
        assert!(plan(&items, &subjects(), &done).is_empty());
    }
}
