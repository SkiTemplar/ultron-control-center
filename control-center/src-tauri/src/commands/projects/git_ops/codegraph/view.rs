// commands/projects/git_ops/codegraph/view.rs — Lecturas del visor CodeGraph.
//
// Alimentan el visor de la tarjeta CodeGraph de ProjectWorkspace (pilar 3 del
// GOAL: «ver el grafo, no lanzar sesiones»): ficheros y módulos con su conteo
// de símbolos, búsqueda de símbolos y vecindario de un símbolo. Todo es de
// solo lectura y con topes duros para que un índice grande (el de ULTRON
// tiene ~30 000 nodos y ~100 000 aristas) no produzca respuestas enormes.

use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::index_db::{clip, open_index, query_err};

/// Tope de ficheros en la lista (los módulos se agregan sobre todos).
pub(crate) const MAX_FILES: usize = 2_000;
/// Tope de módulos (carpetas) en la lista.
pub(crate) const MAX_MODULES: usize = 500;
/// Resultados de búsqueda por defecto y máximos.
pub(crate) const DEFAULT_SEARCH: usize = 30;
pub(crate) const MAX_SEARCH: usize = 50;
/// Longitud máxima de la búsqueda.
pub(crate) const MAX_QUERY_CHARS: usize = 200;
/// Nodos del vecindario por defecto y máximos.
pub(crate) const DEFAULT_NODES: usize = 60;
pub(crate) const MAX_NODES: usize = 150;
/// Profundidad del vecindario por defecto y máxima.
pub(crate) const DEFAULT_DEPTH: u32 = 1;
pub(crate) const MAX_DEPTH: u32 = 3;
/// Aristas leídas por nodo (un fichero grande o un helper muy usado tienen
/// cientos) y aristas totales devueltas.
pub(crate) const MAX_EDGES_PER_NODE: usize = 200;
pub(crate) const MAX_EDGES: usize = 600;
/// Recorte de firmas y nombres cualificados.
const MAX_TEXT_CHARS: usize = 300;

/// Tipos de nodo que no cuentan como símbolo: el propio fichero y cada
/// sentencia `import` (son miles y no aportan al visor).
const NON_SYMBOL_KINDS: &str = "'file', 'import'";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CgFile {
    pub path: String,
    pub language: String,
    pub symbols: i64,
    /// Nodo `file` del índice: punto de entrada para abrir su vecindario.
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CgModule {
    /// Carpeta relativa a la raíz del proyecto («.» para la raíz).
    pub path: String,
    pub files: i64,
    pub symbols: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CgFileList {
    pub files: Vec<CgFile>,
    pub modules: Vec<CgModule>,
    pub total_files: i64,
    /// true si se recortó la lista de ficheros o la de módulos.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CgNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub file_path: String,
    pub language: String,
    pub start_line: i64,
    pub end_line: i64,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CgEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub line: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CgNeighborhood {
    pub center: String,
    pub depth: u32,
    pub nodes: Vec<CgNode>,
    pub edges: Vec<CgEdge>,
    /// true si algún tope (nodos, aristas por nodo o aristas totales) recortó
    /// el resultado.
    pub truncated: bool,
}

const NODE_COLUMNS: &str =
    "id, kind, name, qualified_name, file_path, language, start_line, end_line, signature";

fn node_from_row(r: &Row<'_>) -> rusqlite::Result<CgNode> {
    Ok(CgNode {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        qualified_name: clip(r.get(3)?, MAX_TEXT_CHARS),
        file_path: r.get(4)?,
        language: r.get(5)?,
        start_line: r.get(6)?,
        end_line: r.get(7)?,
        signature: r
            .get::<_, Option<String>>(8)?
            .map(|s| clip(s, MAX_TEXT_CHARS)),
    })
}

// ── Ficheros y módulos ─────────────────────────────────────────────────────

/// Carpeta de un fichero relativo («.» si cuelga de la raíz).
fn module_of(path: &str) -> String {
    match path.replace('\\', "/").rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => dir.to_string(),
        _ => ".".to_string(),
    }
}

pub(crate) fn list_files(conn: &Connection) -> Result<CgFileList, String> {
    let sql = format!(
        "SELECT f.path, f.language, \
           (SELECT COUNT(*) FROM nodes n WHERE n.file_path = f.path AND n.kind NOT IN ({NON_SYMBOL_KINDS})), \
           (SELECT n.id FROM nodes n WHERE n.file_path = f.path AND n.kind = 'file' LIMIT 1) \
         FROM files f ORDER BY f.path"
    );
    let mut stmt = conn.prepare(&sql).map_err(query_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CgFile {
                path: r.get(0)?,
                language: r.get(1)?,
                symbols: r.get(2)?,
                node_id: r.get(3)?,
            })
        })
        .map_err(query_err)?;

    let mut files = Vec::new();
    let mut modules: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut total_files = 0_i64;
    for row in rows {
        let file = row.map_err(query_err)?;
        total_files += 1;
        let entry = modules.entry(module_of(&file.path)).or_insert((0, 0));
        *entry = (entry.0 + 1, entry.1 + file.symbols);
        if files.len() < MAX_FILES {
            files.push(file);
        }
    }
    let modules_truncated = modules.len() > MAX_MODULES;
    let modules = top_modules(modules);
    Ok(CgFileList {
        truncated: total_files as usize > files.len() || modules_truncated,
        files,
        modules,
        total_files,
    })
}

/// Módulos ordenados por número de símbolos (descendente) y recortados.
fn top_modules(modules: BTreeMap<String, (i64, i64)>) -> Vec<CgModule> {
    let mut list: Vec<CgModule> = modules
        .into_iter()
        .map(|(path, (files, symbols))| CgModule {
            path,
            files,
            symbols,
        })
        .collect();
    list.sort_by(|a, b| b.symbols.cmp(&a.symbols).then_with(|| a.path.cmp(&b.path)));
    list.truncate(MAX_MODULES);
    list
}

// ── Búsqueda ───────────────────────────────────────────────────────────────

/// Escapa los comodines de LIKE para que la búsqueda sea literal.
fn like_escape(query: &str) -> String {
    query
        .chars()
        .flat_map(|c| match c {
            '\\' | '%' | '_' => vec!['\\', c],
            _ => vec![c],
        })
        .collect()
}

pub(crate) fn validate_query(query: &str) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("la búsqueda está vacía".to_string());
    }
    if q.chars().count() > MAX_QUERY_CHARS {
        return Err(format!("la búsqueda supera {MAX_QUERY_CHARS} caracteres"));
    }
    Ok(q.to_string())
}

/// Busca símbolos por nombre o nombre cualificado (sin distinguir mayúsculas
/// en ASCII). Orden: coincidencia exacta, prefijo, resto; luego nombre corto.
pub(crate) fn search_symbols(
    conn: &Connection,
    query: &str,
    limit: Option<u32>,
) -> Result<Vec<CgNode>, String> {
    let q = validate_query(query)?;
    let limit = limit.map_or(DEFAULT_SEARCH, |l| (l as usize).clamp(1, MAX_SEARCH));
    let escaped = like_escape(&q);
    let sql = format!(
        "SELECT {NODE_COLUMNS} FROM nodes \
         WHERE kind != 'import' \
           AND (name LIKE ?1 ESCAPE '\\' OR qualified_name LIKE ?1 ESCAPE '\\') \
         ORDER BY CASE WHEN lower(name) = lower(?2) THEN 0 \
                       WHEN name LIKE ?3 ESCAPE '\\' THEN 1 ELSE 2 END, \
                  length(name), file_path, start_line \
         LIMIT ?4"
    );
    let mut stmt = conn.prepare(&sql).map_err(query_err)?;
    let rows = stmt
        .query_map(
            params![
                format!("%{escaped}%"),
                q,
                format!("{escaped}%"),
                limit as i64
            ],
            node_from_row,
        )
        .map_err(query_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(query_err)
}

// ── Vecindario ─────────────────────────────────────────────────────────────

fn load_node(conn: &Connection, id: &str) -> Result<Option<CgNode>, String> {
    let sql = format!("SELECT {NODE_COLUMNS} FROM nodes WHERE id = ?1");
    conn.query_row(&sql, [id], node_from_row)
        .optional()
        .map_err(query_err)
}

/// Aristas que entran o salen de `id`, con un tope por nodo. Devuelve también
/// si el tope recortó algo.
fn edges_of(conn: &Connection, id: &str) -> Result<(Vec<(i64, CgEdge)>, bool), String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT id, source, target, kind, line FROM edges WHERE source = ?1 \
             UNION ALL \
             SELECT id, source, target, kind, line FROM edges WHERE target = ?1 AND source != ?1 \
             LIMIT ?2",
        )
        .map_err(query_err)?;
    let rows = stmt
        .query_map(params![id, (MAX_EDGES_PER_NODE + 1) as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                CgEdge {
                    source: r.get(1)?,
                    target: r.get(2)?,
                    kind: r.get(3)?,
                    line: r.get(4)?,
                },
            ))
        })
        .map_err(query_err)?;
    let mut edges = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(query_err)?;
    let clipped = edges.len() > MAX_EDGES_PER_NODE;
    edges.truncate(MAX_EDGES_PER_NODE);
    Ok((edges, clipped))
}

/// Estado del recorrido en anchura: nodos en orden de descubrimiento y
/// aristas vistas (por id, sin duplicados).
struct Walk {
    order: Vec<String>,
    seen: HashSet<String>,
    edge_ids: HashSet<i64>,
    edges: Vec<CgEdge>,
    truncated: bool,
}

impl Walk {
    fn new(center: &str) -> Self {
        Walk {
            order: vec![center.to_string()],
            seen: HashSet::from([center.to_string()]),
            edge_ids: HashSet::new(),
            edges: Vec::new(),
            truncated: false,
        }
    }

    /// Visita las aristas de `id`; devuelve los nodos nuevos descubiertos.
    fn expand(
        &mut self,
        conn: &Connection,
        id: &str,
        max_nodes: usize,
    ) -> Result<Vec<String>, String> {
        let (edges, clipped) = edges_of(conn, id)?;
        self.truncated |= clipped;
        let mut discovered = Vec::new();
        for (edge_id, edge) in edges {
            let other = if edge.source == id {
                &edge.target
            } else {
                &edge.source
            };
            if !self.seen.contains(other) {
                if self.order.len() >= max_nodes {
                    self.truncated = true;
                    continue;
                }
                self.seen.insert(other.clone());
                self.order.push(other.clone());
                discovered.push(other.clone());
            }
            if self.edge_ids.insert(edge_id) {
                self.edges.push(edge);
            }
        }
        Ok(discovered)
    }
}

/// Nodos y aristas a distancia ≤ `depth` de `node_id`, en ambos sentidos,
/// con tope de nodos. Solo se devuelven aristas cuyos dos extremos están en
/// el resultado.
pub(crate) fn neighborhood(
    conn: &Connection,
    node_id: &str,
    depth: Option<u32>,
    max_nodes: Option<u32>,
) -> Result<CgNeighborhood, String> {
    let id = node_id.trim();
    if id.is_empty() {
        return Err("falta el identificador del símbolo".to_string());
    }
    let depth = depth.unwrap_or(DEFAULT_DEPTH).clamp(1, MAX_DEPTH);
    let max_nodes = max_nodes.map_or(DEFAULT_NODES, |n| (n as usize).clamp(1, MAX_NODES));
    let center =
        load_node(conn, id)?.ok_or_else(|| format!("el símbolo no existe en el índice: {id}"))?;

    let mut walk = Walk::new(&center.id);
    let mut frontier = vec![center.id.clone()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for current in &frontier {
            next.extend(walk.expand(conn, current, max_nodes)?);
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    finish(conn, center, depth, walk)
}

fn finish(
    conn: &Connection,
    center: CgNode,
    depth: u32,
    walk: Walk,
) -> Result<CgNeighborhood, String> {
    let mut nodes = vec![center.clone()];
    for id in walk.order.iter().skip(1) {
        // Una arista colgante (destino borrado sin cascada) no tumba el visor:
        // el nodo se omite y sus aristas caen con él.
        if let Some(node) = load_node(conn, id)? {
            nodes.push(node);
        }
    }
    let present: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let mut edges: Vec<CgEdge> = walk
        .edges
        .into_iter()
        .filter(|e| present.contains(e.source.as_str()) && present.contains(e.target.as_str()))
        .collect();
    let mut truncated = walk.truncated;
    if edges.len() > MAX_EDGES {
        edges.truncate(MAX_EDGES);
        truncated = true;
    }
    Ok(CgNeighborhood {
        center: center.id,
        depth,
        nodes,
        edges,
        truncated,
    })
}

// ── Comandos Tauri ─────────────────────────────────────────────────────────

/// Corre una lectura del índice fuera del hilo de IPC: el índice de un repo
/// grande ocupa cientos de MB y una consulta fría puede tardar.
async fn with_index<T, F>(path: String, read: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_index(&path)?;
        read(&conn)
    })
    .await
    .map_err(|e| format!("codegraph: la lectura se interrumpió: {e}"))?
}

/// Ficheros y módulos del índice con su conteo de símbolos.
#[tauri::command]
pub async fn codegraph_files(path: String) -> Result<CgFileList, String> {
    with_index(path, list_files).await
}

/// Búsqueda de símbolos por nombre.
#[tauri::command]
pub async fn codegraph_search(
    path: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<CgNode>, String> {
    with_index(path, move |conn| search_symbols(conn, &query, limit)).await
}

/// Vecindario de un símbolo a profundidad `depth` (1-3) con tope de nodos.
#[tauri::command]
pub async fn codegraph_neighborhood(
    path: String,
    node_id: String,
    depth: Option<u32>,
    max_nodes: Option<u32>,
) -> Result<CgNeighborhood, String> {
    with_index(path, move |conn| {
        neighborhood(conn, &node_id, depth, max_nodes)
    })
    .await
}
