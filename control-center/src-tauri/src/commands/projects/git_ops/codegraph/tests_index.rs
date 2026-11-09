// Tests de las lecturas del índice de CodeGraph contra un `.db` real.
//
// `fixtures/mini.db` es un índice de CodeGraph 1.6.0 generado con
// `codegraph init` sobre `fixtures/mini-src/` (3 ficheros: `crates/routing.rs`,
// `src/main.ts`, `src/router.ts`; 13 nodos y 19 aristas). Para regenerarlo:
// copiar `mini-src/` a una carpeta temporal, `codegraph init --yes` dentro y
// copiar `.codegraph/codegraph.db` aquí. Está en modo WAL, como los índices
// reales, así que el test lo copia a una carpeta escribible antes de abrirlo.

use std::path::{Path, PathBuf};

use super::index_db::{is_home_dir, locate_index, open_index, open_index_file, NOT_INDEXED};
use super::summary_of;
use super::view::*;

const MINI_DB: &[u8] = include_bytes!("fixtures/mini.db");

/// Proyecto temporal con el índice de fixture en `.codegraph/codegraph.db`.
fn mini_project() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cg = tmp.path().join(".codegraph");
    std::fs::create_dir_all(&cg).expect("mkdir .codegraph");
    std::fs::write(cg.join("codegraph.db"), MINI_DB).expect("write fixture");
    let path = tmp.path().to_string_lossy().into_owned();
    (tmp, path)
}

fn id_of(conn: &rusqlite::Connection, name: &str, file: &str) -> String {
    conn.query_row(
        "SELECT id FROM nodes WHERE name = ?1 AND file_path = ?2",
        [name, file],
        |r| r.get(0),
    )
    .expect("nodo de fixture")
}

#[test]
fn summary_lee_conteos_lenguajes_y_frescura_reales() {
    let (_tmp, path) = mini_project();
    let s = summary_of(&open_index(&path).unwrap()).unwrap();
    assert_eq!((s.files, s.nodes, s.edges), (3, 13, 19));
    assert_eq!(
        s.languages,
        vec![("typescript".to_string(), 2), ("rust".to_string(), 1)]
    );
    assert!(
        s.last_indexed_at.unwrap_or(0) > 0,
        "{:?}",
        s.last_indexed_at
    );
}

#[test]
fn sin_indice_da_un_error_explicito() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().to_string_lossy().into_owned();
    assert_eq!(open_index(&path).err().as_deref(), Some(NOT_INDEXED));
    let falta = tmp.path().join("no-existe").to_string_lossy().into_owned();
    assert!(open_index(&falta).err().unwrap().contains("no existe"));
    assert!(!super::codegraph_is_indexed(path));
}

#[test]
fn un_db_sin_el_esquema_de_codegraph_se_rechaza() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("otro.db");
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE nodes (id TEXT);")
        .unwrap();
    let err = open_index_file(&db).err().unwrap();
    assert!(err.contains("esquema de CodeGraph"), "{err}");
}

#[test]
fn la_carpeta_personal_no_cuenta_como_indice() {
    let (_tmp, path) = mini_project();
    let home = PathBuf::from(&path);
    assert!(is_home_dir(Path::new(&path), Some(&home)));
    let err = locate_index(&path, Some(&home)).unwrap_err();
    assert!(err.contains("carpeta personal"), "{err}");
    assert!(
        locate_index(&path, None).is_ok(),
        "sin home conocido se lee el índice"
    );
}

#[test]
fn el_indice_se_abre_en_solo_lectura() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    let err = conn
        .execute("DELETE FROM nodes", [])
        .unwrap_err()
        .to_string();
    assert!(err.to_lowercase().contains("readonly"), "{err}");
}

#[test]
fn files_lista_ficheros_y_modulos_con_simbolos() {
    let (_tmp, path) = mini_project();
    let list = list_files(&open_index(&path).unwrap()).unwrap();
    assert_eq!(list.total_files, 3);
    assert!(!list.truncated);
    let paths: Vec<&str> = list.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["crates/routing.rs", "src/main.ts", "src/router.ts"]);
    // routing.rs: route, pick, Router y first (el nodo `file` no cuenta).
    assert_eq!(list.files[0].symbols, 4);
    // main.ts: Dispatcher, run y main (ni el `file` ni el `import`).
    assert_eq!(list.files[1].symbols, 3);
    assert!(list.files.iter().all(|f| f.node_id.is_some()));
    let src = list.modules.iter().find(|m| m.path == "src").unwrap();
    assert_eq!((src.files, src.symbols), (2, 5));
    assert_eq!(list.modules[0].path, "src", "ordenados por símbolos");
}

#[test]
fn search_prioriza_la_coincidencia_exacta_y_respeta_el_limite() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    let hits = search_symbols(&conn, "route", None).unwrap();
    assert!(hits.len() >= 2, "{hits:?}");
    assert!(hits.iter().take(2).all(|n| n.name == "route"));
    assert!(hits.iter().all(|n| n.kind != "import"));
    assert_eq!(search_symbols(&conn, "ROUTE", Some(1)).unwrap().len(), 1);
    // Los comodines de LIKE se buscan literalmente.
    assert!(search_symbols(&conn, "%", None).unwrap().is_empty());
    assert!(search_symbols(&conn, "no_existe_xyz", None)
        .unwrap()
        .is_empty());
}

#[test]
fn search_rechaza_busquedas_vacias_o_enormes() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    assert!(search_symbols(&conn, "   ", None)
        .unwrap_err()
        .contains("vacía"));
    let larga = "a".repeat(MAX_QUERY_CHARS + 1);
    assert!(search_symbols(&conn, &larga, None).is_err());
}

#[test]
fn neighborhood_devuelve_llamadas_en_ambos_sentidos() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    let route = id_of(&conn, "route", "crates/routing.rs");
    let g = neighborhood(&conn, &route, Some(1), None).unwrap();
    assert_eq!(g.center, route);
    assert_eq!(g.nodes[0].id, route, "el centro va primero");
    let names: Vec<&str> = g.nodes.iter().map(|n| n.name.as_str()).collect();
    // Llama a pick, la llama first y la contiene routing.rs.
    for esperado in ["pick", "first", "routing.rs"] {
        assert!(names.contains(&esperado), "{names:?}");
    }
    assert!(g
        .edges
        .iter()
        .any(|e| e.kind == "calls" && e.source == route));
    assert!(g
        .edges
        .iter()
        .any(|e| e.kind == "calls" && e.target == route));
    assert!(!g.truncated);
    let ids: std::collections::HashSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(g
        .edges
        .iter()
        .all(|e| ids.contains(e.source.as_str()) && ids.contains(e.target.as_str())));
}

#[test]
fn neighborhood_a_mas_profundidad_alcanza_mas_nodos() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    let route = id_of(&conn, "route", "crates/routing.rs");
    let d1 = neighborhood(&conn, &route, Some(1), None).unwrap();
    let d2 = neighborhood(&conn, &route, Some(2), None).unwrap();
    assert!(
        d2.nodes.len() > d1.nodes.len(),
        "{} vs {}",
        d2.nodes.len(),
        d1.nodes.len()
    );
    assert!(d2.nodes.iter().any(|n| n.name == "Router"));
    let d9 = neighborhood(&conn, &route, Some(99), None).unwrap();
    assert_eq!(d9.depth, MAX_DEPTH, "la profundidad se acota");
}

#[test]
fn neighborhood_respeta_el_tope_de_nodos() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    let file = id_of(&conn, "routing.rs", "crates/routing.rs");
    let g = neighborhood(&conn, &file, Some(2), Some(3)).unwrap();
    assert_eq!(g.nodes.len(), 3);
    assert!(g.truncated, "el recorte tiene que decirse");
    let sin_tope = neighborhood(&conn, &file, Some(2), Some(10_000)).unwrap();
    assert!(sin_tope.nodes.len() <= MAX_NODES);
}

#[test]
fn neighborhood_de_un_simbolo_inexistente_falla() {
    let (_tmp, path) = mini_project();
    let conn = open_index(&path).unwrap();
    let err = neighborhood(&conn, "function:no-existe", None, None).unwrap_err();
    assert!(err.contains("no existe en el índice"), "{err}");
    assert!(neighborhood(&conn, "  ", None, None)
        .unwrap_err()
        .contains("falta"));
}

/// Criterio medible del visor sobre un índice real (no corre por defecto):
///
/// ```text
/// ULTRON_CODEGRAPH_PROJECT=<ruta del repo ULTRON> \
///   cargo test --features finance codegraph_vecindario_de_route_en_un_indice_real -- --ignored --nocapture
/// ```
///
/// Busca `route` en `ai_router/` y exige ≥ 1 arista y ≤ el tope de nodos.
#[test]
#[ignore = "necesita ULTRON_CODEGRAPH_PROJECT con un índice real"]
fn codegraph_vecindario_de_route_en_un_indice_real() {
    let path = std::env::var("ULTRON_CODEGRAPH_PROJECT").expect("ULTRON_CODEGRAPH_PROJECT");
    let conn = open_index(&path).expect("índice del proyecto");
    let hits = search_symbols(&conn, "route", Some(MAX_SEARCH as u32)).unwrap();
    let route = hits
        .iter()
        .find(|n| n.name == "route" && n.file_path.contains("ai_router"))
        .expect("route en ai_router");
    let g = neighborhood(&conn, &route.id, None, None).unwrap();
    println!(
        "route ({}:{}) -> {} nodos, {} aristas, truncado={}",
        route.file_path,
        route.start_line,
        g.nodes.len(),
        g.edges.len(),
        g.truncated
    );
    assert!(!g.edges.is_empty(), "al menos una arista");
    assert!(g.nodes.len() <= DEFAULT_NODES, "tope de nodos");
}
