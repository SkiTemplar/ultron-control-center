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
    pub rol: String,        // "senal" (cuenta para la densidad) o "aviso" (solo se lista)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TfgReport {
    pub matches: Vec<TfgMatch>,
    pub patterns_hit: usize, // nº de patrones distintos con >=1 match
    pub total_patterns_scanned: usize, // nº de patrones con senales_ejecutables no vacías
    pub words: usize,        // palabras del texto de entrada
    pub density_per_100w: f32, // senales_total * 100 / words (0 si words == 0); NO cuenta avisos
    pub senales_total: usize, // matches de rol "senal"
    pub avisos_total: usize, // matches de rol "aviso" (p. ej. tricolon)
    pub veredicto: String,   // "probable_ia" | "sin_indicios" | "no_concluyente"
    pub motivo_no_concluyente: Option<String>, // "pocas_palabras" | "densidad_ambigua"
}

// ---------------------------------------------------------------------------
// Veredicto por densidad (decidido por el usuario 2026-09-11)
// ---------------------------------------------------------------------------
//
// Gemelo de `computeVerdict` en hooks/scripts/lib/ai-text-detector.js. Ver el
// comentario de ese archivo para el detalle de cómo se ajustaron estos
// valores (leave-one-out sobre docs/research/corpus/, gitignorado, medido
// 2026-09-11: 23 IA / 6 humanos, ambos por debajo del mínimo de 30 para
// fiarse del ajuste sin reservas — ver `scripts/ai-text-eval.mjs`).
pub const MIN_WORDS: usize = 400;
pub const DENSITY_THRESHOLD: f32 = 0.12;
pub const DENSITY_BAND: f32 = 0.03;

/// Tres estados a partir de palabras y densidad (señales/100 palabras, sin
/// contar las de rol "aviso"). Overrides opcionales para bancos de medición.
pub fn calcular_veredicto(
    palabras: usize,
    densidad_por_100: f32,
    min_palabras: Option<usize>,
    umbral: Option<f32>,
    banda: Option<f32>,
) -> &'static str {
    let min_palabras = min_palabras.unwrap_or(MIN_WORDS);
    let umbral = umbral.unwrap_or(DENSITY_THRESHOLD);
    let banda = banda.unwrap_or(DENSITY_BAND);
    if palabras < min_palabras {
        return "no_concluyente";
    }
    if densidad_por_100 >= umbral + banda {
        return "probable_ia";
    }
    if densidad_por_100 < umbral - banda {
        return "sin_indicios";
    }
    "no_concluyente"
}

// ---------------------------------------------------------------------------
// Rutas y carga del catálogo
// ---------------------------------------------------------------------------

fn ruta_catalogo() -> Result<PathBuf, String> {
    Ok(crate::maria_root()?
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
    /// Regla ejecutable: o una regex del catálogo, o una señal estructural
    /// (`tipo: "heuristica"`) implementada en `tfg_heuristics`.
    motor: Motor,
    /// "senal" (cuenta para la densidad) o "aviso" (solo se lista). Vive en
    /// el patrón, no en la señal suelta: ver `compilar_reglas`.
    rol: &'static str,
    /// "es"/"en" restringe la regla a ese idioma del texto; "*" (o ausente en
    /// el catálogo, compatibilidad) la deja correr siempre. Vive en el
    /// patrón, igual que `rol`. Ver `detectar_con_catalogo` para el filtrado.
    idioma: String,
}

enum Motor {
    Regex(regex::Regex),
    /// Id de heurística, p. ej. "tricolon" o "monotonia_frases".
    Heuristica(String),
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
/// Vuelve un término léxico insensible a las tildes: cada vocal pasa a una
/// clase con todas sus variantes. Motivo medido (2026-08-15): el catálogo
/// escribe "en conclusión" y el texto real —borradores, material pegado desde
/// un PDF, gente que no acentúa— dice "en conclusion", y la señal no disparaba.
/// Era la causa común de varios falsos negativos. La eñe NO se toca: volverla
/// `[nñ]` confundiría "ano" con "año". Gemelo de `acentoInsensible` en
/// `hooks/scripts/lib/ai-text-detector.js`.
fn acento_insensible(fuente: &str) -> String {
    let mut out = String::with_capacity(fuente.len());
    for ch in fuente.chars() {
        // `to_lowercase` Unicode y no `to_ascii_lowercase`: con el ASCII, una
        // vocal acentuada MAYÚSCULA ("Ánimo", "Éxito") no bajaba y la señal
        // quedaba fuera de la clase (medido 2026-08-15).
        let base = ch.to_lowercase().next().unwrap_or(ch);
        let clase = match base {
            'a' | 'á' | 'à' | 'â' | 'ä' => Some("[aáàâä]"),
            'e' | 'é' | 'è' | 'ê' | 'ë' => Some("[eéèêë]"),
            'i' | 'í' | 'ì' | 'î' | 'ï' => Some("[iíìîï]"),
            'o' | 'ó' | 'ò' | 'ô' | 'ö' => Some("[oóòôö]"),
            'u' | 'ú' | 'ù' | 'û' | 'ü' => Some("[uúùûü]"),
            _ => None,
        };
        match clase {
            Some(c) => out.push_str(c),
            None => out.push(ch),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Detección de idioma del texto (campo "idioma" del catálogo, 2026-09-14)
// ---------------------------------------------------------------------------

/// Ratio de stopwords ES vs EN. Heurística deliberadamente simple (sin crate
/// nueva): decide qué subconjunto de `senales_ejecutables` marcadas
/// "es"/"en"/"*" tiene sentido ejecutar sobre ESTE texto, no un detector de
/// idioma de propósito general (no reconoce mezcla real ni terceros idiomas).
/// Con texto corto o sin stopwords reconocibles cae a "es": el catálogo nació
/// pensando en TFG en español y ese es el sesgo más seguro sin evidencia
/// clara. Gemelo EXACTO de `detectarIdioma` en
/// `hooks/scripts/lib/ai-text-detector.js` (mismas listas de stopwords).
const STOPWORDS_ES: &[&str] = &[
    "el", "la", "los", "las", "de", "del", "en", "y", "a", "que", "un", "una", "unos", "unas",
    "es", "son", "por", "para", "con", "no", "se", "su", "sus", "como", "más", "mas", "pero",
    "este", "esta", "estos", "estas", "al", "lo", "le", "les", "muy", "también", "tambien",
    "entre", "sobre", "sin", "ya", "o", "porque", "cuando", "donde", "sí", "si", "nos", "ha",
    "han",
];
const STOPWORDS_EN: &[&str] = &[
    "the", "of", "and", "a", "to", "in", "is", "are", "that", "for", "on", "with", "as", "this",
    "it", "by", "an", "be", "was", "were", "from", "or", "but", "not", "have", "has", "at",
    "their", "which", "these", "those", "its", "we", "you", "they", "been", "can", "will", "into",
];

/// Devuelve "es" o "en". Empate o sin evidencia -> "es" (ver comentario de arriba).
fn detectar_idioma(texto: &str) -> &'static str {
    let minusculas = texto.to_lowercase();
    let mut es = 0usize;
    let mut en = 0usize;
    for token in minusculas.split(|c: char| !c.is_alphabetic()) {
        if token.is_empty() {
            continue;
        }
        if STOPWORDS_ES.contains(&token) {
            es += 1;
        } else if STOPWORDS_EN.contains(&token) {
            en += 1;
        }
    }
    if en > es {
        "en"
    } else {
        "es"
    }
}

fn compilar_reglas(patrones: &[serde_json::Value]) -> Vec<ReglaCompilada> {
    let mut reglas = Vec::new();
    for (patron_idx, patron) in patrones.iter().enumerate() {
        let senales = match patron.get("senales_ejecutables").and_then(|v| v.as_array()) {
            Some(s) => s,
            None => continue,
        };
        // "rol" vive en el patrón entero (no señal a señal): el catálogo
        // declara de una vez que un patrón es contextual (p. ej. tricolon),
        // no cablea la excepción por nombre aquí. Gemelo de la lectura en
        // `compileRules` de ai-text-detector.js.
        let rol: &'static str = if patron.get("rol").and_then(|v| v.as_str()) == Some("aviso") {
            "aviso"
        } else {
            "senal"
        };
        // "idioma" vive igual en el patrón entero (no señal a señal). Ausente
        // en el catálogo -> "*" (compatibilidad con catálogos sin el campo).
        // Gemelo de la lectura en `compileRules` de ai-text-detector.js.
        let idioma = patron
            .get("idioma")
            .and_then(|v| v.as_str())
            .unwrap_or("*")
            .to_string();
        for senal in senales {
            let tipo = senal.get("tipo").and_then(|v| v.as_str()).unwrap_or("");
            let valor = senal.get("valor").and_then(|v| v.as_str()).unwrap_or("");
            if valor.is_empty() {
                continue;
            }
            let nota = senal.get("nota").and_then(|v| v.as_str()).unwrap_or("");
            let (fuente, etiqueta) = match tipo {
                "lexico" => {
                    let escapado = acento_insensible(&regex::escape(valor));
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
                // Señal estructural: la resuelve tfg_heuristics, no una regex.
                // Una id que este binario no conozca se salta igual que una
                // regex que no compila (el catálogo puede ir por delante).
                "heuristica" => {
                    if crate::tfg_heuristics::existe(valor) {
                        reglas.push(ReglaCompilada {
                            patron_idx,
                            etiqueta: format!("heuristica:{valor}"),
                            motor: Motor::Heuristica(valor.to_string()),
                            rol,
                            idioma: idioma.clone(),
                        });
                    }
                    continue;
                }
                // Tipo desconocido: el catálogo manda; cualquier otro se ignora.
                _ => continue,
            };
            if let Ok(re) = regex::Regex::new(&fuente) {
                reglas.push(ReglaCompilada {
                    patron_idx,
                    etiqueta,
                    motor: Motor::Regex(re),
                    rol,
                    idioma: idioma.clone(),
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

    // Idioma del texto: solo corren (y cuentan como escaneados) los patrones
    // cuyo campo "idioma" es "*"/ausente o coincide con este. Gemelo de la
    // misma regla en `scan()` de ai-text-detector.js.
    let idioma_texto = detectar_idioma(texto);

    let total_patterns_scanned = patrones
        .iter()
        .filter(|p| {
            let tiene_senales = p
                .get("senales_ejecutables")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let idioma_patron = p.get("idioma").and_then(|v| v.as_str()).unwrap_or("*");
            tiene_senales && (idioma_patron == "*" || idioma_patron == idioma_texto)
        })
        .count();

    let reglas: Vec<ReglaCompilada> = compilar_reglas(patrones)
        .into_iter()
        .filter(|r| r.idioma == "*" || r.idioma == idioma_texto)
        .collect();

    let mut matches: Vec<TfgMatch> = Vec::new();
    let mut patron_con_match = vec![false; patrones.len()];

    for regla in &reglas {
        let patron = &patrones[regla.patron_idx];
        let nombre = patron.get("nombre").and_then(|v| v.as_str()).unwrap_or("");
        let correccion = patron
            .get("correccion")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let tramos: Vec<(usize, usize)> = match &regla.motor {
            Motor::Regex(re) => re.find_iter(texto).map(|m| (m.start(), m.end())).collect(),
            Motor::Heuristica(id) => crate::tfg_heuristics::ejecutar(id, texto)
                .unwrap_or_default()
                .into_iter()
                .map(|s| (s.start, s.end))
                .collect(),
        };
        for (inicio, fin) in tramos {
            patron_con_match[regla.patron_idx] = true;
            matches.push(TfgMatch {
                pattern: nombre.to_string(),
                rule: regla.etiqueta.clone(),
                evidence: extraer_evidencia(texto, inicio, fin),
                start: inicio,
                end: fin,
                correction: correccion.to_string(),
                rol: regla.rol.to_string(),
            });
        }
    }

    // Orden estable por posición en el texto: la UI pinta los hallazgos en
    // orden de lectura sin tener que reordenar.
    matches.sort_by_key(|m| (m.start, m.end));

    let words = texto.split_whitespace().count();
    let senales_total = matches.iter().filter(|m| m.rol == "senal").count();
    let avisos_total = matches.iter().filter(|m| m.rol == "aviso").count();
    // La densidad NO cuenta los avisos (p. ej. tricolon): ver `calcular_veredicto`
    // y el comentario de `DENSITY_THRESHOLD` para el porqué.
    let density_per_100w = if words == 0 {
        0.0
    } else {
        senales_total as f32 * 100.0 / words as f32
    };
    let veredicto = calcular_veredicto(words, density_per_100w, None, None, None);
    let motivo_no_concluyente = if veredicto == "no_concluyente" {
        Some(
            if words < MIN_WORDS {
                "pocas_palabras"
            } else {
                "densidad_ambigua"
            }
            .to_string(),
        )
    } else {
        None
    };

    TfgReport {
        patterns_hit: patron_con_match.iter().filter(|h| **h).count(),
        total_patterns_scanned,
        words,
        density_per_100w,
        senales_total,
        avisos_total,
        veredicto: veredicto.to_string(),
        motivo_no_concluyente,
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

    // --- Filtro por idioma (campo "idioma" del catalogo, 2026-09-14) -------

    const MARCADOR: &str = "marcadorxyzunico";

    fn catalogo_idioma() -> serde_json::Value {
        serde_json::json!({
            "patrones": [
                {
                    "nombre": "Patron solo espanol",
                    "idioma": "es",
                    "senales_ejecutables": [
                        { "tipo": "lexico", "valor": MARCADOR }
                    ]
                },
                {
                    "nombre": "Patron independiente de idioma",
                    "idioma": "*",
                    "senales_ejecutables": [
                        { "tipo": "lexico", "valor": MARCADOR }
                    ]
                },
                {
                    "nombre": "Patron sin campo idioma",
                    "senales_ejecutables": [
                        { "tipo": "lexico", "valor": MARCADOR }
                    ]
                }
            ]
        })
    }

    /// Texto genuinamente inglés (para que `detectar_idioma` lo clasifique
    /// como "en" de verdad, no solo por opts forzados: aquí no hay overrides).
    fn texto_ingles_con_marcador() -> String {
        format!(
            "This is a sample sentence that contains the {MARCADOR} token for testing purposes in this document."
        )
    }

    #[test]
    fn idioma_patron_es_no_dispara_sobre_texto_en_ingles() {
        let catalogo = catalogo_idioma();
        let informe = detectar_con_catalogo(&catalogo, &texto_ingles_con_marcador());
        let del_patron: Vec<_> = informe
            .matches
            .iter()
            .filter(|m| m.pattern == "Patron solo espanol")
            .collect();
        assert!(
            del_patron.is_empty(),
            "el patron 'es' no debe disparar sobre texto en ingles: {del_patron:?}"
        );
    }

    #[test]
    fn idioma_patron_comodin_dispara_en_ambos_idiomas() {
        let catalogo = catalogo_idioma();
        let texto_es = format!(
            "Este es un texto de prueba que contiene el marcador {MARCADOR} para verificar."
        );
        let informe_es = detectar_con_catalogo(&catalogo, &texto_es);
        let informe_en = detectar_con_catalogo(&catalogo, &texto_ingles_con_marcador());
        let hit_es = informe_es
            .matches
            .iter()
            .any(|m| m.pattern == "Patron independiente de idioma");
        let hit_en = informe_en
            .matches
            .iter()
            .any(|m| m.pattern == "Patron independiente de idioma");
        assert!(
            hit_es && hit_en,
            "el patron '*' debe disparar en es Y en en (es={hit_es} en={hit_en})"
        );
    }

    #[test]
    fn idioma_patron_sin_campo_se_trata_como_comodin() {
        let catalogo = catalogo_idioma();
        let texto_es = format!(
            "Este es un texto de prueba que contiene el marcador {MARCADOR} para verificar."
        );
        let informe_es = detectar_con_catalogo(&catalogo, &texto_es);
        let informe_en = detectar_con_catalogo(&catalogo, &texto_ingles_con_marcador());
        let hit_es = informe_es
            .matches
            .iter()
            .any(|m| m.pattern == "Patron sin campo idioma");
        let hit_en = informe_en
            .matches
            .iter()
            .any(|m| m.pattern == "Patron sin campo idioma");
        assert!(
            hit_es && hit_en,
            "un patron sin campo 'idioma' debe comportarse como '*' (compatibilidad): es={hit_es} en={hit_en}"
        );
    }

    #[test]
    fn detectar_idioma_positivo_es_y_en() {
        let es = detectar_idioma(
            "El sistema analiza los datos y presenta los resultados de la investigación en el capítulo siguiente.",
        );
        assert_eq!(es, "es");
        let en = detectar_idioma(
            "The system analyzes the data and presents the results of the research in the following chapter.",
        );
        assert_eq!(en, "en");
    }

    /// Caso NEGATIVO: sin stopwords reconocibles de ningún idioma, cae al
    /// default "es" y NO se inventa "en" por defecto.
    #[test]
    fn detectar_idioma_negativo_sin_evidencia_cae_a_es() {
        let sin_evidencia = detectar_idioma("Qdrant E5-large RRF FTS5 CPU GPU JSON");
        assert_eq!(sin_evidencia, "es");
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

    fn raiz_repo() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("raiz del repo")
            .to_path_buf()
    }

    /// Los TRES estados del veredicto por densidad, leídos del fixture
    /// compartido (`veredicto_casos`). Gemelo de la misma sección consumida
    /// por el selftest JS de `computeVerdict` — ambos leen el mismo JSON.
    #[test]
    fn veredicto_tres_estados_desde_fixture() {
        let fixture_path = raiz_repo().join("scripts/fixtures/catalog-cases.json");
        let fixture_raw = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|e| panic!("falta {}: {e}", fixture_path.display()));
        let fixture: serde_json::Value = serde_json::from_str(&fixture_raw).expect("fixture json");
        let casos = fixture["veredicto_casos"]
            .as_array()
            .expect("veredicto_casos");
        assert!(casos.len() >= 6, "fixture de veredicto insuficiente");

        for caso in casos {
            let nombre = caso["nombre"].as_str().unwrap_or_default();
            let words = caso["words"].as_u64().unwrap_or_default() as usize;
            let density = caso["density"].as_f64().unwrap_or_default() as f32;
            let esperado = caso["esperado"].as_str().unwrap_or_default();
            let obtenido = calcular_veredicto(words, density, None, None, None);
            assert_eq!(
                obtenido, esperado,
                "[{nombre}] words={words} density={density}: esperado {esperado}, obtenido {obtenido}"
            );
        }
    }

    /// El rol "aviso" del catálogo (tricolon) se detecta y se lista, pero NO
    /// cuenta para `senales_total`/`density_per_100w`; un patrón "senal"
    /// normal sigue contando. Lee `rol_casos` del fixture compartido contra
    /// el CATÁLOGO REAL (no el sintético): el rol es un dato del catálogo de
    /// producción, no de un fixture de prueba.
    #[test]
    fn rol_desde_fixture_no_cuenta_avisos_para_densidad() {
        let raiz = raiz_repo();
        let fixture_raw = std::fs::read_to_string(raiz.join("scripts/fixtures/catalog-cases.json"))
            .expect("fixture json");
        let fixture: serde_json::Value = serde_json::from_str(&fixture_raw).expect("fixture json");
        let catalogo_raw =
            std::fs::read_to_string(raiz.join("docs/research/patrones-texto-ia.json"))
                .expect("catalogo real");
        let catalogo: serde_json::Value =
            serde_json::from_str(&catalogo_raw).expect("catalogo json");

        let casos = fixture["rol_casos"].as_array().expect("rol_casos");
        assert!(!casos.is_empty(), "fixture de rol vacío");

        for caso in casos {
            let patron_nombre = caso["patron"].as_str().unwrap_or_default();
            let texto = caso["texto"].as_str().unwrap_or_default();
            let rol_esperado = caso["rol_esperado"].as_str().unwrap_or_default();
            let informe = detectar_con_catalogo(&catalogo, texto);
            let del_patron: Vec<&TfgMatch> = informe
                .matches
                .iter()
                .filter(|m| m.pattern == patron_nombre)
                .collect();
            assert!(
                !del_patron.is_empty(),
                "[{patron_nombre}] no disparó sobre: {texto}"
            );
            for m in &del_patron {
                assert_eq!(
                    m.rol, rol_esperado,
                    "[{patron_nombre}] rol esperado {rol_esperado}, obtenido {}",
                    m.rol
                );
            }
            if rol_esperado == "aviso" {
                // El aviso se lista (avisos_total lo cuenta) pero NO entra en
                // senales_total ni en la densidad que alimenta el veredicto.
                assert_eq!(
                    informe.senales_total, 0,
                    "[{patron_nombre}] un aviso no debe contar como senal"
                );
                assert!(informe.avisos_total > 0);
                assert_eq!(informe.density_per_100w, 0.0);
            } else {
                assert!(
                    informe.senales_total > 0,
                    "[{patron_nombre}] debe contar como senal"
                );
            }
        }
    }
}
