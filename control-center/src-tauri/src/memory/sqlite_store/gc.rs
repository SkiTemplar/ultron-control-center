//! Mantenimiento a 90 dias de `brain.db` (F1.8, decision del 2026-09-11).
//!
//! Contexto: `brain.db` pesa 126 MB y `memory_events` aporta ~79 MB de payload
//! (before_json/after_json de cada mutacion). La decision fue NO archivar el log
//! a otra base, sino aplicar dos reglas con ventana de 90 dias:
//!
//!   1. Decaimiento: un item ACTIVE sin recall ni modificacion en la ventana
//!      pasa a `stale` (no se borra; sale del retriever y del indice denso).
//!   2. Poda del log: los `memory_events` de items en `deprecated`/`rejected`
//!      anteriores a la ventana se borran. Los eventos de items activos o stale
//!      quedan intactos: el event-sourcing sigue completo para lo vivo.
//!   3. Poda del log sin item (ampliacion del 2026-09-11, tras medir que la
//!      regla 2 solo alcanzaba 2,9 MB de los 126): eventos anteriores a la
//!      ventana que NO cuelgan de ningun item de `memory_items`, sea porque
//!      nacieron con `memory_id` NULL (telemetria de recall/creacion: 50.706
//!      filas, ~45 MB, el 74 % del log) o porque su item ya no esta (archivado
//!      en `memory_items_archive` o borrado por `forget`: 9.524 filas). Sin
//!      item no reconstruyen nada: no son event-sourcing, son rastro.
//!
//! Aqui vive SOLO el SQL (funciones sobre `&Connection`, testeables contra una
//! base en memoria). La transicion de status la aplica `MemoryService::gc` por
//! el camino probado `set_status`, unico escritor de memoria persistente.
//!
//! Señal de recall (regla 1): `memory_items.last_accessed_at`, que escribe
//! `touch_injected` desde el recall unificado (`recall_unified::engine`) cuando
//! un item entra en un context pack. Esa columna se sella con
//! `strftime('%s','now')` — SEGUNDOS — mientras `updated_at` es epoch-millis,
//! asi que toda comparacion pasa por [`LAST_ACCESS_MS`], que normaliza ambas
//! unidades. Alcance real: la telemetria arranco el 2026-08-28, de modo que un
//! `last_accessed_at` NULL significa "sin recall desde que existe la señal", no
//! "sin recall en 90 dias" (mandamiento 13).

use rusqlite::{named_params, Connection};

use crate::memory::MemoryError;

/// `last_accessed_at` normalizado a epoch-millis. La columna se escribe en
/// segundos (`strftime('%s','now')` en `touch_injected`); el umbral 1e11 separa
/// ambas escalas sin ambiguedad practica (1e11 ms = 1973; 1e11 s = año 5138),
/// asi que una migracion futura a millis no rompe esta comparacion.
const LAST_ACCESS_MS: &str =
    "(CASE WHEN last_accessed_at > 100000000000 THEN last_accessed_at ELSE last_accessed_at * 1000 END)";

/// Statuses cuyos eventos son podables por la regla 2.
const PRUNABLE_STATUSES: &str = "('deprecated','rejected')";

/// Tamaño del fichero segun SQLite: `page_count * page_size`. Es la medida que
/// se compara antes/despues para decidir si compensa un VACUUM.
pub fn db_size_bytes(conn: &Connection) -> Result<i64, MemoryError> {
    let pages: i64 = pragma_i64(conn, "page_count")?;
    let page_size: i64 = pragma_i64(conn, "page_size")?;
    Ok(pages * page_size)
}

/// Bytes ya reservados por el fichero pero libres (`freelist_count * page_size`).
/// Un DELETE no encoge el fichero: pasa paginas a la freelist. Este es el ahorro
/// que un VACUUM devolveria al sistema de ficheros, y por tanto el estimador
/// honesto para el umbral de los 10 MB.
pub fn freelist_bytes(conn: &Connection) -> Result<i64, MemoryError> {
    let free: i64 = pragma_i64(conn, "freelist_count")?;
    let page_size: i64 = pragma_i64(conn, "page_size")?;
    Ok(free * page_size)
}

fn pragma_i64(conn: &Connection, pragma: &str) -> Result<i64, MemoryError> {
    conn.query_row(&format!("PRAGMA {pragma}"), [], |r| r.get(0))
        .map_err(|e| MemoryError::RemoteUnavailable(format!("PRAGMA {pragma}: {e}")))
}

/// Regla 1 — ids de items ACTIVE que no se han recuperado ni modificado desde
/// `cutoff_ms`. Solo lee: no muta nada.
///
/// Protegidos (nunca se marcan): `pinned` y `validated_by_user`, la misma
/// proteccion que aplica el sweep por edad `mark_stale_aged`.
pub fn select_decayed_active_ids(
    conn: &Connection,
    cutoff_ms: i64,
) -> Result<Vec<String>, MemoryError> {
    let sql = format!(
        "SELECT id FROM memory_items \
         WHERE status = 'active' AND pinned = 0 AND validated_by_user = 0 \
           AND updated_at < :cutoff \
           AND (last_accessed_at IS NULL OR {LAST_ACCESS_MS} < :cutoff) \
         ORDER BY updated_at ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MemoryError::RemoteUnavailable(format!("select_decayed prepare: {e}")))?;
    let ids = stmt
        .query_map(named_params! { ":cutoff": cutoff_ms }, |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| MemoryError::RemoteUnavailable(format!("select_decayed query: {e}")))?
        .flatten()
        .collect();
    Ok(ids)
}

/// Desglose de la poda del log por motivo. Los tres criterios son disjuntos por
/// construccion (un evento o tiene item vivo, o no tiene `memory_id`, o apunta a
/// un id inexistente), asi que su suma es el total borrado.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct EventPruneCounts {
    /// Regla 2 — eventos de items en `deprecated`/`rejected`.
    pub status_dead: usize,
    /// Regla 3a — eventos con `memory_id` NULL (telemetria suelta).
    pub no_item: usize,
    /// Regla 3b — eventos cuyo `memory_id` ya no existe en `memory_items`.
    pub orphan: usize,
}

impl EventPruneCounts {
    #[must_use]
    pub fn total(&self) -> usize {
        self.status_dead + self.no_item + self.orphan
    }
}

/// Reglas 2 y 3 — poda del log. Borra los `memory_events` anteriores a
/// `cutoff_ms` que ya no sirven para reconstruir nada; con `dry_run` solo
/// cuenta. Devuelve el desglose por motivo.
///
/// Deliberadamente NO toca los eventos de items `active` o `stale`: mientras el
/// item exista y no este muerto, su historia queda entera. El pin y la
/// validacion del usuario viajan dentro de esos statuses (un item pinned esta
/// ACTIVE), de modo que su rastro tampoco se poda.
pub fn prune_events(
    conn: &Connection,
    cutoff_ms: i64,
    dry_run: bool,
) -> Result<EventPruneCounts, MemoryError> {
    let status_dead = format!(
        "created_at < :cutoff AND memory_id IN \
         (SELECT id FROM memory_items WHERE status IN {PRUNABLE_STATUSES})"
    );
    let no_item = "created_at < :cutoff AND memory_id IS NULL".to_string();
    let orphan = "created_at < :cutoff AND memory_id IS NOT NULL \
                  AND memory_id NOT IN (SELECT id FROM memory_items)"
        .to_string();
    Ok(EventPruneCounts {
        status_dead: apply_prune(conn, &status_dead, cutoff_ms, dry_run)?,
        no_item: apply_prune(conn, &no_item, cutoff_ms, dry_run)?,
        orphan: apply_prune(conn, &orphan, cutoff_ms, dry_run)?,
    })
}

/// Cuenta (dry-run) o borra las filas de `memory_events` que casan con `filtro`.
fn apply_prune(
    conn: &Connection,
    filtro: &str,
    cutoff_ms: i64,
    dry_run: bool,
) -> Result<usize, MemoryError> {
    if dry_run {
        let n: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM memory_events WHERE {filtro}"),
                named_params! { ":cutoff": cutoff_ms },
                |r| r.get(0),
            )
            .map_err(|e| MemoryError::RemoteUnavailable(format!("prune_events count: {e}")))?;
        return Ok(usize::try_from(n).unwrap_or(0));
    }
    let n = conn
        .execute(
            &format!("DELETE FROM memory_events WHERE {filtro}"),
            named_params! { ":cutoff": cutoff_ms },
        )
        .map_err(|e| MemoryError::RemoteUnavailable(format!("prune_events delete: {e}")))?;
    Ok(n)
}

/// Compacta el fichero. `brain.db` esta en `auto_vacuum = NONE` (verificado en
/// la base real: `PRAGMA auto_vacuum` = 0), donde `incremental_vacuum` es un
/// no-op silencioso, asi que la unica compactacion efectiva es VACUUM completo.
/// Puede fallar si otro proceso (daemon, GUI) tiene la base abierta: el error se
/// devuelve al llamante en vez de tragarse (mandamiento 11).
pub fn vacuum(conn: &Connection) -> Result<(), MemoryError> {
    conn.execute_batch("VACUUM;")
        .map_err(|e| MemoryError::RemoteUnavailable(format!("VACUUM: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::{MemoryItem, MemoryType, Scope, Source, Status};
    use crate::memory::sqlite_store::{apply_schema, get_item, insert_item};

    const DIA_MS: i64 = 86_400_000;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        apply_schema(&c).expect("schema");
        c
    }

    /// Item con `updated_at`/`last_accessed_at` controlados. `acceso_s` va en
    /// SEGUNDOS a proposito: es la unidad real que escribe `touch_injected`.
    fn item(
        c: &Connection,
        id: &str,
        status: Status,
        updated_ms: i64,
        acceso_s: Option<i64>,
    ) -> String {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::AssistantInferred,
            status,
        );
        it.id = id.to_string();
        it.summary = Some(format!("item {id}"));
        it.updated_at = updated_ms;
        it.last_accessed_at = acceso_s;
        insert_item(c, &it).expect("insert");
        it.id
    }

    fn evento(c: &Connection, id: &str, memory_id: Option<&str>, created_at: i64) {
        c.execute(
            "INSERT INTO memory_events (id, event_type, memory_id, actor, created_at) \
             VALUES (?1, 'updated', ?2, 'system', ?3)",
            rusqlite::params![id, memory_id, created_at],
        )
        .expect("insert event");
    }

    fn eventos_vivos(c: &Connection) -> Vec<String> {
        let mut stmt = c
            .prepare("SELECT id FROM memory_events ORDER BY id")
            .unwrap();
        let out = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect();
        out
    }

    // -- Regla 1: decaimiento ------------------------------------------------

    #[test]
    fn decaimiento_marca_activo_viejo_y_nunca_recuperado() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        let corte = ahora - 90 * DIA_MS;
        item(&c, "viejo", Status::Active, ahora - 100 * DIA_MS, None);
        let ids = select_decayed_active_ids(&c, corte).unwrap();
        assert_eq!(ids, vec!["viejo".to_string()]);
    }

    #[test]
    fn decaimiento_respeta_la_ventana_de_90_dias() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        let corte = ahora - 90 * DIA_MS;
        // 89 dias sin tocar: dentro de la ventana, no decae.
        item(&c, "dentro", Status::Active, ahora - 89 * DIA_MS, None);
        // 91 dias: fuera de la ventana, decae.
        item(&c, "fuera", Status::Active, ahora - 91 * DIA_MS, None);
        let ids = select_decayed_active_ids(&c, corte).unwrap();
        assert_eq!(ids, vec!["fuera".to_string()], "el corte es estricto a 90d");
    }

    #[test]
    fn un_recall_reciente_salva_al_item_aunque_no_se_haya_editado() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        let corte = ahora - 90 * DIA_MS;
        // Sin editar desde hace 200 dias, pero recuperado hace 5 (en SEGUNDOS,
        // como lo sella touch_injected): sigue en uso, no decae.
        item(
            &c,
            "recuperado",
            Status::Active,
            ahora - 200 * DIA_MS,
            Some((ahora - 5 * DIA_MS) / 1000),
        );
        // Recuperado por ultima vez hace 200 dias: decae.
        item(
            &c,
            "olvidado",
            Status::Active,
            ahora - 200 * DIA_MS,
            Some((ahora - 200 * DIA_MS) / 1000),
        );
        let ids = select_decayed_active_ids(&c, corte).unwrap();
        assert_eq!(ids, vec!["olvidado".to_string()]);
    }

    #[test]
    fn decaimiento_no_toca_no_activos_ni_protegidos() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        let corte = ahora - 90 * DIA_MS;
        let viejo = ahora - 300 * DIA_MS;
        item(&c, "deprecado", Status::Deprecated, viejo, None);
        item(&c, "ya-stale", Status::Stale, viejo, None);
        item(&c, "pendiente", Status::Pending, viejo, None);

        let mut fijado = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        );
        fijado.id = "fijado".into();
        fijado.updated_at = viejo;
        fijado.pinned = true;
        insert_item(&c, &fijado).unwrap();

        let mut validado = MemoryItem::new(
            MemoryType::Fact,
            Scope::Project,
            Source::UserExplicit,
            Status::Active,
        );
        validado.id = "validado".into();
        validado.updated_at = viejo;
        validado.validated_by_user = true;
        insert_item(&c, &validado).unwrap();

        assert!(
            select_decayed_active_ids(&c, corte).unwrap().is_empty(),
            "solo decaen ACTIVE sin pin ni validacion del usuario"
        );
    }

    #[test]
    fn seleccionar_candidatos_no_muta_nada() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        item(&c, "viejo", Status::Active, ahora - 300 * DIA_MS, None);
        let _ = select_decayed_active_ids(&c, ahora - 90 * DIA_MS).unwrap();
        let it = get_item(&c, "viejo").unwrap().expect("sigue ahi");
        assert_eq!(it.status, Status::Active, "la seleccion es de solo lectura");
    }

    // -- Regla 2: poda del log ----------------------------------------------

    /// Escenario compartido por los tests de poda: un evento viejo de cada
    /// familia + los controles recientes.
    fn escenario_poda(c: &Connection, ahora: i64) {
        let viejo = ahora - 120 * DIA_MS;
        item(c, "muerto", Status::Deprecated, viejo, None);
        item(c, "rechazado", Status::Rejected, viejo, None);
        item(c, "vivo", Status::Active, viejo, None);
        item(c, "dormido", Status::Stale, viejo, None);

        evento(c, "e1-muerto-viejo", Some("muerto"), viejo);
        evento(c, "e2-rechazado-viejo", Some("rechazado"), viejo);
        evento(c, "e3-muerto-reciente", Some("muerto"), ahora - DIA_MS);
        evento(c, "e4-vivo-viejo", Some("vivo"), viejo);
        evento(c, "e5-dormido-viejo", Some("dormido"), viejo);
        evento(c, "e6-sin-item-viejo", None, viejo);
        evento(c, "e7-sin-item-reciente", None, ahora - DIA_MS);
        evento(c, "e8-huerfano-viejo", Some("ya-no-existe"), viejo);
        evento(
            c,
            "e9-huerfano-reciente",
            Some("ya-no-existe"),
            ahora - DIA_MS,
        );
    }

    #[test]
    fn poda_borra_lo_muerto_lo_suelto_y_lo_huerfano_pero_nunca_lo_vivo() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        escenario_poda(&c, ahora);

        let n = prune_events(&c, ahora - 90 * DIA_MS, false).unwrap();
        assert_eq!(n.status_dead, 2, "regla 2: deprecated + rejected");
        assert_eq!(n.no_item, 1, "regla 3a: memory_id NULL");
        assert_eq!(n.orphan, 1, "regla 3b: item inexistente");
        assert_eq!(n.total(), 4);
        assert_eq!(
            eventos_vivos(&c),
            vec![
                "e3-muerto-reciente".to_string(),
                "e4-vivo-viejo".to_string(),
                "e5-dormido-viejo".to_string(),
                "e7-sin-item-reciente".to_string(),
                "e9-huerfano-reciente".to_string(),
            ],
            "los eventos de items vivos (active/stale) y todo lo reciente se conservan"
        );
    }

    #[test]
    fn la_regla_3_no_toca_eventos_de_un_item_vivo_por_muy_viejos_que_sean() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        let antiguo = ahora - 3650 * DIA_MS;
        item(&c, "vivo", Status::Active, antiguo, None);
        item(&c, "fijado", Status::Active, antiguo, None);
        item(&c, "dormido", Status::Stale, antiguo, None);
        evento(&c, "a-vivo", Some("vivo"), antiguo);
        evento(&c, "b-fijado", Some("fijado"), antiguo);
        evento(&c, "c-dormido", Some("dormido"), antiguo);

        let n = prune_events(&c, ahora - 90 * DIA_MS, false).unwrap();
        assert_eq!(
            n.total(),
            0,
            "tener item vivo basta para conservar el evento"
        );
        assert_eq!(eventos_vivos(&c).len(), 3);
    }

    #[test]
    fn la_ventana_tambien_protege_a_los_eventos_sin_item() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        // 89 dias: dentro de la ventana. 91: fuera.
        evento(&c, "dentro-null", None, ahora - 89 * DIA_MS);
        evento(&c, "fuera-null", None, ahora - 91 * DIA_MS);
        evento(&c, "dentro-huerfano", Some("fantasma"), ahora - 89 * DIA_MS);
        evento(&c, "fuera-huerfano", Some("fantasma"), ahora - 91 * DIA_MS);

        let n = prune_events(&c, ahora - 90 * DIA_MS, false).unwrap();
        assert_eq!((n.no_item, n.orphan), (1, 1));
        assert_eq!(
            eventos_vivos(&c),
            vec!["dentro-huerfano".to_string(), "dentro-null".to_string()],
            "el corte de 90d aplica igual a la telemetria suelta"
        );
    }

    #[test]
    fn poda_en_dry_run_cuenta_pero_no_escribe() {
        let c = conn();
        let ahora = 1_800_000_000_000_i64;
        escenario_poda(&c, ahora);
        let antes = eventos_vivos(&c);

        let n = prune_events(&c, ahora - 90 * DIA_MS, true).unwrap();
        assert_eq!(
            (n.status_dead, n.no_item, n.orphan, n.total()),
            (2, 1, 1, 4),
            "el dry-run reporta lo que borraria, con su desglose"
        );
        assert_eq!(eventos_vivos(&c), antes, "el dry-run no borra ni un evento");
    }

    // -- Medida del fichero --------------------------------------------------

    #[test]
    fn el_tamano_declarado_sale_de_page_count_por_page_size() {
        let c = conn();
        let bytes = db_size_bytes(&c).unwrap();
        let page_size: i64 = c
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .expect("page_size");
        assert!(bytes > 0 && bytes % page_size == 0);
        assert_eq!(
            freelist_bytes(&c).unwrap() % page_size,
            0,
            "la freelist se mide en paginas enteras"
        );
    }
}
