//! Laboratorio TFG: detección determinista y explicable de patrones de texto IA.
//!
//! Fuente de verdad: `~/.ultron/docs/research/patrones-texto-ia.json` (catálogo
//! de investigación del usuario). Este módulo NO define patrones propios: solo
//! ejecuta las `senales_ejecutables` (léxicas y regex) que el catálogo declara.
//!
//! Wiring pendiente (lo hace otra tarea, este archivo no toca `lib.rs`):
//!   1. `mod tfg_lab;` en `lib.rs`
//!   2. registrar `tfg_lab::tfg_catalog_load` y `tfg_lab::tfg_detect` en el
//!      `invoke_handler`.

use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Contrato con la UI (cerrado: la UI ya consume estas formas)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct TfgMatch {
    pub pattern: String,  // campo "nombre" del patrón
    pub rule: String,     // "lexico:<valor>" o "regex:<nota-o-valor>"
    pub evidence: String, // fragmento matcheado con ~30 chars de contexto por lado
    pub start: usize,     // offset byte del inicio del match en el texto original
    pub end: usize,
    pub correction: String, // campo "correccion" del patrón (vacío si no tiene)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TfgReport {
    pub matches: Vec<TfgMatch>,
    pub patterns_hit: usize, // nº de patrones distintos con >=1 match
    pub total_patterns_scanned: usize, // nº de patrones con senales_ejecutables no vacías
    pub words: usize,        // palabras del texto de entrada
    pub density_per_100w: f32, // matches.len() * 100 / words (0 si words == 0)
}

// ---------------------------------------------------------------------------
// Rutas y carga del catálogo
// ---------------------------------------------------------------------------

fn ruta_catalogo() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("docs")
        .join("research")
        .join("patrones-texto-ia.json"))
}

fn cargar_catalogo() -> Result<serde_json::Value, String> {
    let ruta = ruta_catalogo()?;
    let crudo = std::fs::read_to_string(&ruta)
        .map_err(|e| format!("No se pudo leer {}: {e}", ruta.display()))?;
    serde_json::from_str(&crudo).map_err(|e| format!("JSON inválido en {}: {e}", ruta.display()))
}

// ---------------------------------------------------------------------------
// Núcleo de detección (puro: recibe el catálogo como Value → testeable en
// hermético con un catálogo sintético, sin depender del archivo real)
// ---------------------------------------------------------------------------

/// Regla ya compilada, lista para escanear. Se compilan todas UNA vez por
/// invocación (no por línea ni por match) para que un texto de ~100KB fluya.
struct ReglaCompilada {
    patron_idx: usize,
    etiqueta: String,
    re: regex::Regex,
}

/// Convierte las `senales_ejecutables` del catálogo en regex compiladas.
///
/// - "lexico" de UNA palabra → `(?i)\b<término-escapado>\b` (límites de palabra).
/// - "lexico" de varias palabras → `(?i)<frase-escapada>` (contains, sin \b).
/// - "regex" → se compila tal cual viene del catálogo.
///
/// Una regex inválida en el catálogo NO tira el comando: se salta en silencio.
/// El contrato `TfgReport` es cerrado (la UI ya lo consume) y no admite un
/// campo de warnings, así que el fallo de compilación se degrada a "esta señal
/// no aporta matches"; el catálogo se corrige en su propio archivo, no aquí.
fn compilar_reglas(patrones: &[serde_json::Value]) -> Vec<ReglaCompilada> {
    let mut reglas = Vec::new();
    for (patron_idx, patron) in patrones.iter().enumerate() {
        let senales = match patron.get("senales_ejecutables").and_then(|v| v.as_array()) {
            Some(s) => s,
            None => continue,
        };
        for senal in senales {
            let tipo = senal.get("tipo").and_then(|v| v.as_str()).unwrap_or("");
            let valor = senal.get("valor").and_then(|v| v.as_str()).unwrap_or("");
            if valor.is_empty() {
                continue;
            }
            let nota = senal.get("nota").and_then(|v| v.as_str()).unwrap_or("");
            let (fuente, etiqueta) = match tipo {
                "lexico" => {
                    let escapado = regex::escape(valor);
                    let fuente = if valor.split_whitespace().count() == 1 {
                        format!(r"(?i)\b{escapado}\b")
                    } else {
                        format!("(?i){escapado}")
                    };
                    (fuente, format!("lexico:{valor}"))
                }
                "regex" => {
                    let referencia = if nota.is_empty() { valor } else { nota };
                    (valor.to_string(), format!("regex:{referencia}"))
                }
                // Tipo desconocido: el catálogo manda, pero solo hay dos tipos
                // ejecutables definidos; cualquier otro se ignora.
                _ => continue,
            };
            if let Ok(re) = regex::Regex::new(&fuente) {
                reglas.push(ReglaCompilada {
                    patron_idx,
                    etiqueta,
                    re,
                });
            }
        }
    }
    reglas
}

/// Extrae el fragmento matcheado con ~30 chars de contexto por lado,
/// ajustando a límites de char UTF-8 para no partir un carácter multibyte.
fn extraer_evidencia(texto: &str, inicio: usize, fin: usize) -> String {
    const CONTEXTO: usize = 30;
    let mut desde = inicio.saturating_sub(CONTEXTO);
    while desde > 0 && !texto.is_char_boundary(desde) {
        desde -= 1;
    }
    let mut hasta = fin.saturating_add(CONTEXTO).min(texto.len());
    while hasta < texto.len() && !texto.is_char_boundary(hasta) {
        hasta += 1;
    }
    texto[desde..hasta].to_string()
}

/// Núcleo puro de detección: escanea `texto` contra los patrones del catálogo.
fn detectar_con_catalogo(catalogo: &serde_json::Value, texto: &str) -> TfgReport {
    let vacio: Vec<serde_json::Value> = Vec::new();
    let patrones = catalogo
        .get("patrones")
        .and_then(|v| v.as_array())
        .unwrap_or(&vacio);

    let total_patterns_scanned = patrones
        .iter()
        .filter(|p| {
            p.get("senales_ejecutables")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false)
        })
        .count();

    let reglas = compilar_reglas(patrones);

    let mut matches: Vec<TfgMatch> = Vec::new();
    let mut patron_con_match = vec![false; patrones.len()];

    for regla in &reglas {
        let patron = &patrones[regla.patron_idx];
        let nombre = patron.get("nombre").and_then(|v| v.as_str()).unwrap_or("");
        let correccion = patron
            .get("correccion")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        for m in regla.re.find_iter(texto) {
            patron_con_match[regla.patron_idx] = true;
            matches.push(TfgMatch {
                pattern: nombre.to_string(),
                rule: regla.etiqueta.clone(),
                evidence: extraer_evidencia(texto, m.start(), m.end()),
                start: m.start(),
                end: m.end(),
                correction: correccion.to_string(),
            });
        }
    }

    // Orden estable por posición en el texto: la UI pinta los hallazgos en
    // orden de lectura sin tener que reordenar.
    matches.sort_by_key(|m| (m.start, m.end));

    let words = texto.split_whitespace().count();
    let density_per_100w = if words == 0 {
        0.0
    } else {
        matches.len() as f32 * 100.0 / words as f32
    };

    TfgReport {
        patterns_hit: patron_con_match.iter().filter(|h| **h).count(),
        total_patterns_scanned,
        words,
        density_per_100w,
        matches,
    }
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

/// Devuelve el catálogo completo tal cual está en disco (la UI lo renderiza
/// entero: patrones, deteccion, escritura, universidades_es, fuentes).
#[tauri::command]
pub async fn tfg_catalog_load() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(cargar_catalogo)
        .await
        .map_err(|e| e.to_string())?
}

/// Escanea `text` contra las señales ejecutables del catálogo y devuelve el
/// informe de matches con evidencia y densidad por 100 palabras.
#[tauri::command]
pub async fn tfg_detect(text: String) -> Result<TfgReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let catalogo = cargar_catalogo()?;
        Ok(detectar_con_catalogo(&catalogo, &text))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tests herméticos (catálogo sintético inline, sin tocar el archivo real)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Catálogo sintético mínimo: un patrón léxico (término de una palabra +
    /// frase multi-palabra), un patrón regex con una regex válida y una
    /// inválida a propósito, y un patrón sin señales ejecutables.
    fn catalogo_sintetico() -> serde_json::Value {
        serde_json::json!({
            "patrones": [
                {
                    "nombre": "Patron lexico",
                    "correccion": "usar verbos concretos",
                    "senales_ejecutables": [
                        { "tipo": "lexico", "valor": "delve", "nota": "termino de una palabra" },
                        { "tipo": "lexico", "valor": "align with", "nota": "frase multi-palabra" }
                    ]
                },
                {
                    "nombre": "Patron estructural",
                    "senales_ejecutables": [
                        { "tipo": "regex", "valor": "(?i)\\bno es\\b[^.]{0,60}\\bsino\\b", "nota": "paralelismo negativo" },
                        { "tipo": "regex", "valor": "([", "nota": "regex invalida a proposito" }
                    ]
                },
                {
                    "nombre": "Patron sin senales",
                    "correccion": "",
                    "senales_ejecutables": []
                }
            ]
        })
    }

    #[test]
    fn positivo_detecta_senales_conocidas() {
        let catalogo = catalogo_sintetico();
        let texto = "Queremos delve en el tema y align with la meta. Esto no es un resumen, sino un análisis.";
        let informe = detectar_con_catalogo(&catalogo, texto);

        assert_eq!(informe.matches.len(), 3);
        assert_eq!(informe.patterns_hit, 2);
        // El patron sin senales no cuenta como escaneado.
        assert_eq!(informe.total_patterns_scanned, 2);
        assert!(informe.density_per_100w > 0.0);

        // Cada match apunta al patron correcto y sus offsets son fieles al texto original.
        let lexicos: Vec<&TfgMatch> = informe
            .matches
            .iter()
            .filter(|m| m.pattern == "Patron lexico")
            .collect();
        assert_eq!(lexicos.len(), 2);
        assert!(lexicos.iter().any(|m| m.rule == "lexico:delve"));
        assert!(lexicos.iter().any(|m| m.rule == "lexico:align with"));
        assert_eq!(lexicos[0].correction, "usar verbos concretos");

        let estructural = informe
            .matches
            .iter()
            .find(|m| m.pattern == "Patron estructural")
            .expect("la regex valida debe matchear");
        assert_eq!(estructural.rule, "regex:paralelismo negativo");
        // Sin campo "correccion" en el patron -> cadena vacia.
        assert_eq!(estructural.correction, "");

        for m in &informe.matches {
            assert!(m.end > m.start && m.end <= texto.len());
            assert!(m.evidence.contains(&texto[m.start..m.end]));
        }
    }

    #[test]
    fn lexico_una_palabra_respeta_limites_de_palabra() {
        let catalogo = catalogo_sintetico();
        // "delves" NO debe matchear el termino "delve" (limite \b).
        let informe = detectar_con_catalogo(&catalogo, "The author delves deeper here.");
        assert!(informe.matches.is_empty());
        assert_eq!(informe.patterns_hit, 0);
    }

    #[test]
    fn negativo_texto_humano_sin_senales() {
        let catalogo = catalogo_sintetico();
        let texto = "Ayer fui al mercado del barrio y compré tomates. Mi hermana vino a cenar y hablamos de la huerta.";
        let informe = detectar_con_catalogo(&catalogo, texto);
        assert!(informe.matches.is_empty());
        assert_eq!(informe.patterns_hit, 0);
        assert_eq!(informe.density_per_100w, 0.0);
        assert!(informe.words > 0);
    }

    #[test]
    fn texto_vacio_sin_division_por_cero() {
        let catalogo = catalogo_sintetico();
        let informe = detectar_con_catalogo(&catalogo, "");
        assert_eq!(informe.words, 0);
        assert_eq!(informe.density_per_100w, 0.0);
        assert!(informe.matches.is_empty());
    }

    #[test]
    fn regex_invalida_no_rompe_el_escaneo() {
        // Patron cuya UNICA senal es una regex invalida: se salta en silencio,
        // pero sigue contando como patron escaneado (senales no vacias).
        let catalogo = serde_json::json!({
            "patrones": [
                {
                    "nombre": "Solo regex rota",
                    "senales_ejecutables": [
                        { "tipo": "regex", "valor": "([", "nota": "invalida" }
                    ]
                }
            ]
        });
        let informe = detectar_con_catalogo(&catalogo, "texto cualquiera con contenido normal");
        assert!(informe.matches.is_empty());
        assert_eq!(informe.patterns_hit, 0);
        assert_eq!(informe.total_patterns_scanned, 1);
    }

    #[test]
    fn evidencia_multibyte_no_panica() {
        let catalogo = catalogo_sintetico();
        // Caracteres multibyte a ambos lados del match: el recorte de ~30 bytes
        // de contexto debe ajustarse a limites de char sin panic.
        let texto = format!("{} delve {}", "á".repeat(40), "é".repeat(40));
        let informe = detectar_con_catalogo(&catalogo, &texto);
        assert_eq!(informe.matches.len(), 1);
        let m = &informe.matches[0];
        assert_eq!(&texto[m.start..m.end], "delve");
        assert!(m.evidence.contains("delve"));
    }

    #[test]
    fn catalogo_sin_lista_de_patrones_devuelve_informe_vacio() {
        let informe = detectar_con_catalogo(&serde_json::json!({}), "un texto normal");
        assert_eq!(informe.total_patterns_scanned, 0);
        assert!(informe.matches.is_empty());
        assert_eq!(informe.density_per_100w, 0.0);
    }
}
