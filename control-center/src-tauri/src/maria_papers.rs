// mar.ia — buscador de papers para el TFG (Semantic Scholar + OpenAlex).
//
// El usuario los pidio el 2026-09-19: se los han recomendado para sacar
// literatura del TFG. Aqui se consultan LOS DOS y se fusiona el resultado,
// porque no cubren lo mismo: Semantic Scholar va mejor en informatica y trae
// el "influential citation count"; OpenAlex tiene mas cobertura fuera del
// ingles y marca mejor el acceso abierto.
//
// LIMITES DECLARADOS (mandamiento 13):
//   * Sin clave de API. Ambas tienen cuota publica y pueden devolver 429 si se
//     abusa; cuando pasa, se dice cual fallo en vez de enseñar media lista
//     como si fuera todo lo que hay.
//   * NO se manda ningun dato personal. OpenAlex pide un `mailto` para su
//     "polite pool" y aqui se deja vacio a proposito: mas cuota no vale
//     regalar el correo del usuario a un tercero.
//   * Lo que se devuelve son METADATOS y, cuando existe, el enlace al PDF de
//     acceso abierto. No se descarga nada.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(20);
const UA: &str = "maria-tfg/1.0 (buscador de literatura academica)";

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Paper {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub venue: String,
    pub abstract_text: String,
    pub citations: i64,
    pub doi: String,
    /// Pagina del paper (landing page).
    pub url: String,
    /// PDF de acceso abierto, si lo hay.
    pub pdf_url: String,
    pub open_access: bool,
    /// De donde salio: "semanticscholar", "openalex" o "ambas".
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Busqueda {
    pub papers: Vec<Paper>,
    /// Fuentes que fallaron, con el motivo. Vacio = las dos contestaron.
    pub fallos: Vec<String>,
}

/// Normaliza un DOI para comparar: minusculas y sin el prefijo de la URL.
/// Pura.
#[must_use]
pub fn normaliza_doi(raw: &str) -> String {
    let d = raw.trim().to_lowercase();
    for pre in ["https://doi.org/", "http://doi.org/", "doi:"] {
        if let Some(resto) = d.strip_prefix(pre) {
            return resto.trim().to_string();
        }
    }
    d
}

/// Clave con la que se decide si dos resultados son el MISMO paper.
///
/// DOI si lo hay; si no, el titulo reducido a letras y numeros. Sin esto, cada
/// paper aparecia dos veces (una por fuente) con el titulo escrito distinto.
/// Pura.
#[must_use]
pub fn clave_dedupe(p: &Paper) -> String {
    let doi = normaliza_doi(&p.doi);
    if !doi.is_empty() {
        return format!("doi:{doi}");
    }
    let t: String = p
        .title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    format!("t:{t}")
}

/// Une los resultados de las dos fuentes sin repetir y ordenados por citas.
///
/// Cuando el mismo paper viene de las dos, se queda el registro mas COMPLETO
/// campo a campo (una fuente suele traer resumen y la otra el PDF abierto) y
/// se marca como "ambas". Pura: se testea sin red.
#[must_use]
pub fn fusionar(listas: Vec<Vec<Paper>>) -> Vec<Paper> {
    let mut por_clave: HashMap<String, Paper> = HashMap::new();
    let mut orden: Vec<String> = Vec::new();
    for lista in listas {
        for p in lista {
            let k = clave_dedupe(&p);
            match por_clave.get_mut(&k) {
                Some(ya) => {
                    if ya.abstract_text.is_empty() {
                        ya.abstract_text = p.abstract_text.clone();
                    }
                    if ya.pdf_url.is_empty() {
                        ya.pdf_url = p.pdf_url.clone();
                    }
                    if ya.doi.is_empty() {
                        ya.doi = p.doi.clone();
                    }
                    if ya.venue.is_empty() {
                        ya.venue = p.venue.clone();
                    }
                    if ya.authors.is_empty() {
                        ya.authors = p.authors.clone();
                    }
                    if ya.year.is_none() {
                        ya.year = p.year;
                    }
                    ya.open_access = ya.open_access || p.open_access;
                    // Las citas no se suman: son el mismo paper contado por
                    // dos sitios. Se queda la cifra mas alta y ya.
                    ya.citations = ya.citations.max(p.citations);
                    if ya.source != p.source {
                        ya.source = "ambas".into();
                    }
                }
                None => {
                    orden.push(k.clone());
                    por_clave.insert(k, p);
                }
            }
        }
    }
    let mut out: Vec<Paper> = orden
        .into_iter()
        .filter_map(|k| por_clave.remove(&k))
        .collect();
    out.sort_by(|a, b| b.citations.cmp(&a.citations));
    out
}

fn texto(v: &serde_json::Value, clave: &str) -> String {
    v.get(clave)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Convierte la respuesta de Semantic Scholar. Pura: se testea con un JSON
/// de ejemplo, sin red.
#[must_use]
pub fn parse_semanticscholar(raw: &serde_json::Value) -> Vec<Paper> {
    let Some(items) = raw.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|it| {
            let oa = it.get("openAccessPdf").and_then(|o| o.get("url"));
            Paper {
                title: texto(it, "title"),
                authors: it
                    .get("authors")
                    .and_then(|a| a.as_array())
                    .map(|a| a.iter().map(|x| texto(x, "name")).collect())
                    .unwrap_or_default(),
                year: it.get("year").and_then(serde_json::Value::as_i64),
                venue: texto(it, "venue"),
                abstract_text: texto(it, "abstract"),
                citations: it
                    .get("citationCount")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0),
                doi: it
                    .get("externalIds")
                    .map(|e| texto(e, "DOI"))
                    .unwrap_or_default(),
                url: texto(it, "url"),
                pdf_url: oa.and_then(|u| u.as_str()).unwrap_or("").to_string(),
                open_access: oa.is_some(),
                source: "semanticscholar".into(),
            }
        })
        .filter(|p| !p.title.is_empty())
        .collect()
}

/// Convierte la respuesta de OpenAlex. Pura.
///
/// OpenAlex guarda el resumen como indice invertido (`abstract_inverted_index`:
/// palabra -> posiciones), asi que hay que reconstruirlo.
#[must_use]
pub fn parse_openalex(raw: &serde_json::Value) -> Vec<Paper> {
    let Some(items) = raw.get("results").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|it| {
            let oa = it.get("open_access");
            let pdf = it
                .get("best_oa_location")
                .and_then(|l| l.get("pdf_url"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            Paper {
                title: texto(it, "display_name"),
                authors: it
                    .get("authorships")
                    .and_then(|a| a.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.get("author"))
                            .map(|x| texto(x, "display_name"))
                            .collect()
                    })
                    .unwrap_or_default(),
                year: it
                    .get("publication_year")
                    .and_then(serde_json::Value::as_i64),
                venue: it
                    .get("primary_location")
                    .and_then(|l| l.get("source"))
                    .map(|s| texto(s, "display_name"))
                    .unwrap_or_default(),
                abstract_text: reconstruye_resumen(it.get("abstract_inverted_index")),
                citations: it
                    .get("cited_by_count")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0),
                doi: texto(it, "doi"),
                url: texto(it, "id"),
                pdf_url: pdf,
                open_access: oa
                    .and_then(|o| o.get("is_oa"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                source: "openalex".into(),
            }
        })
        .filter(|p| !p.title.is_empty())
        .collect()
}

/// Rehace el texto del resumen desde el indice invertido de OpenAlex. Pura.
#[must_use]
pub fn reconstruye_resumen(idx: Option<&serde_json::Value>) -> String {
    let Some(obj) = idx.and_then(|v| v.as_object()) else {
        return String::new();
    };
    let mut palabras: Vec<(u64, &str)> = Vec::new();
    for (palabra, posiciones) in obj {
        let Some(ps) = posiciones.as_array() else {
            continue;
        };
        for p in ps {
            if let Some(n) = p.as_u64() {
                palabras.push((n, palabra.as_str()));
            }
        }
    }
    palabras.sort_by_key(|(n, _)| *n);
    palabras
        .into_iter()
        .map(|(_, w)| w)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Clave de API desde el entorno o el `.env` de mar.ia (de donde las lee el
/// resto del sistema). Vacio = se va al pool compartido.
fn clave(var: &str) -> String {
    if let Ok(v) = std::env::var(var) {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    let env_file = crate::maria_paths::home().join(".env");
    std::fs::read_to_string(env_file)
        .ok()
        .and_then(|t| {
            t.lines()
                .map(str::trim)
                .find_map(|l| l.strip_prefix(&format!("{var}="))
                    .map(|v| v.trim().trim_matches('"').to_string()))
        })
        .unwrap_or_default()
}

fn cliente() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(UA)
        .build()
        .map_err(|e| format!("cliente http: {e}"))
}

fn pide(url: &str) -> Result<serde_json::Value, String> {
    pide_con(url, None)
}

/// Igual, con cabecera de clave opcional.
fn pide_con(url: &str, api_key: Option<&str>) -> Result<serde_json::Value, String> {
    let mut req = cliente()?.get(url);
    if let Some(k) = api_key.filter(|k| !k.is_empty()) {
        req = req.header("x-api-key", k);
    }
    let resp = req.send().map_err(|e| format!("{e}"))?;
    let estado = resp.status();
    if !estado.is_success() {
        // 429 es lo habitual sin clave: se dice tal cual en vez de devolver
        // una lista vacia que parece "no hay resultados".
        return Err(format!("HTTP {estado}"));
    }
    resp.json().map_err(|e| format!("respuesta ilegible: {e}"))
}

/// Busca en las dos fuentes. Bloqueante: el comando lo lanza en su hilo.
pub fn buscar(consulta: &str, limite: usize) -> Busqueda {
    let q = consulta.trim();
    if q.is_empty() {
        return Busqueda {
            papers: Vec::new(),
            fallos: vec!["no me has dicho que buscar".into()],
        };
    }
    let limite = limite.clamp(1, 50);
    let enc = urlencoding_simple(q);
    let mut fallos = Vec::new();
    let mut listas = Vec::new();

    let ss = format!(
        "https://api.semanticscholar.org/graph/v1/paper/search?query={enc}&limit={limite}\
         &fields=title,abstract,year,venue,citationCount,externalIds,url,openAccessPdf,authors"
    );
    let k_ss = clave("SEMANTIC_SCHOLAR_API_KEY");
    match pide_con(&ss, Some(&k_ss)) {
        Ok(v) => listas.push(parse_semanticscholar(&v)),
        // Sin clave, el pool compartido devuelve 429 en rafagas: medido el
        // 2026-09-19. Se dice cual fallo y como arreglarlo, no se calla.
        Err(e) if e.contains("429") && k_ss.is_empty() => fallos.push(
            "Semantic Scholar: HTTP 429 (pool compartido saturado). Pon una clave en              Ajustes → API Keys para tener ritmo propio."
                .into(),
        ),
        Err(e) => fallos.push(format!("Semantic Scholar: {e}")),
    }

    let oa = format!(
        "https://api.openalex.org/works?search={enc}&per-page={limite}\
         &select=id,doi,display_name,publication_year,cited_by_count,authorships,\
primary_location,open_access,best_oa_location,abstract_inverted_index"
    );
    let k_oa = clave("OPENALEX_API_KEY");
    let oa = if k_oa.is_empty() {
        oa
    } else {
        format!("{oa}&api_key={}", urlencoding_simple(&k_oa))
    };
    match pide(&oa) {
        Ok(v) => listas.push(parse_openalex(&v)),
        Err(e) => fallos.push(format!("OpenAlex: {e}")),
    }

    Busqueda {
        papers: fusionar(listas),
        fallos,
    }
}

/// Codifica una consulta para la query. Se hace a mano para no anadir una
/// dependencia por tres caracteres. Pura.
#[must_use]
pub fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn maria_papers_search(query: String, limit: Option<usize>) -> Result<Busqueda, String> {
    tauri::async_runtime::spawn_blocking(move || buscar(&query, limit.unwrap_or(15)))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paper(titulo: &str, doi: &str, citas: i64, fuente: &str) -> Paper {
        Paper {
            title: titulo.into(),
            doi: doi.into(),
            citations: citas,
            source: fuente.into(),
            ..Paper::default()
        }
    }

    #[test]
    fn el_doi_se_normaliza_para_comparar() {
        assert_eq!(normaliza_doi("https://doi.org/10.1/AB"), "10.1/ab");
        assert_eq!(normaliza_doi("  DOI:10.1/ab "), "10.1/ab");
        assert_eq!(normaliza_doi("10.1/ab"), "10.1/ab");
        assert_eq!(normaliza_doi(""), "");
    }

    #[test]
    fn el_mismo_paper_por_dos_fuentes_sale_una_vez() {
        let a = paper("Attention Is All You Need", "10.1/x", 1000, "semanticscholar");
        let b = paper("attention is all you need", "https://doi.org/10.1/X", 1200, "openalex");
        let out = fusionar(vec![vec![a], vec![b]]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "ambas");
        // Las citas NO se suman: es el mismo paper contado dos veces.
        assert_eq!(out[0].citations, 1200);
    }

    #[test]
    fn sin_doi_se_deduplica_por_titulo() {
        let a = paper("Un Título: Con Puntuación", "", 5, "semanticscholar");
        let b = paper("un titulo con puntuacion", "", 7, "openalex");
        // Caso negativo del dedupe por titulo: las tildes SI cuentan, asi que
        // estos dos no son el mismo y deben salir por separado. Fusionarlos
        // seria esconder un resultado real.
        assert_eq!(fusionar(vec![vec![a], vec![b]]).len(), 2);
    }

    #[test]
    fn los_resultados_salen_por_citas() {
        let out = fusionar(vec![vec![
            paper("a", "10.1/a", 3, "openalex"),
            paper("b", "10.1/b", 50, "openalex"),
            paper("c", "10.1/c", 12, "openalex"),
        ]]);
        assert_eq!(
            out.iter().map(|p| p.citations).collect::<Vec<_>>(),
            vec![50, 12, 3]
        );
    }

    #[test]
    fn se_lee_la_respuesta_de_semantic_scholar() {
        let raw = json!({"data":[{
            "title":"Deep Learning","year":2015,"venue":"Nature",
            "abstract":"Un resumen.","citationCount":42,
            "externalIds":{"DOI":"10.1038/nature14539"},
            "url":"https://www.semanticscholar.org/paper/x",
            "openAccessPdf":{"url":"https://ejemplo/x.pdf"},
            "authors":[{"name":"LeCun"},{"name":"Bengio"}]
        }]});
        let p = &parse_semanticscholar(&raw)[0];
        assert_eq!(p.title, "Deep Learning");
        assert_eq!(p.authors, vec!["LeCun", "Bengio"]);
        assert_eq!(p.citations, 42);
        assert!(p.open_access);
        assert_eq!(p.pdf_url, "https://ejemplo/x.pdf");
    }

    #[test]
    fn una_respuesta_vacia_o_rara_no_revienta() {
        // Caso negativo: si la API cambia de forma, el buscador tiene que
        // devolver cero resultados, no tirar la pestaña.
        assert!(parse_semanticscholar(&json!({})).is_empty());
        assert!(parse_semanticscholar(&json!({"data":"no es una lista"})).is_empty());
        assert!(parse_openalex(&json!({"results":[{"display_name":""}]})).is_empty());
        assert!(parse_openalex(&json!(null)).is_empty());
    }

    #[test]
    fn se_rehace_el_resumen_invertido_de_openalex() {
        let idx = json!({"El": [0], "gato": [1], "duerme": [2, 4], "y": [3]});
        assert_eq!(reconstruye_resumen(Some(&idx)), "El gato duerme y duerme");
        assert_eq!(reconstruye_resumen(None), "");
        assert_eq!(reconstruye_resumen(Some(&json!("no es un objeto"))), "");
    }

    #[test]
    fn la_consulta_se_codifica_para_la_url() {
        assert_eq!(urlencoding_simple("deep learning"), "deep%20learning");
        assert_eq!(urlencoding_simple("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoding_simple("niño"), "ni%C3%B1o");
        assert_eq!(urlencoding_simple("ok-1_2.3~"), "ok-1_2.3~");
    }

    #[test]
    fn una_consulta_vacia_no_llama_a_nadie() {
        let b = buscar("   ", 10);
        assert!(b.papers.is_empty());
        assert_eq!(b.fallos.len(), 1);
    }
}
