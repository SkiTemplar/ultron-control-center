//! tfg_heuristics.rs — señales ESTRUCTURALES del detector de texto IA.
//!
//! Gemelo Rust de `hooks/scripts/lib/ai-text-heuristics.js`. El catálogo
//! (`docs/research/patrones-texto-ia.json`) es la fuente única y declara estas
//! señales como `{ "tipo": "heuristica", "valor": "<id>" }`; aquí viven las
//! implementaciones que consume la pestaña Lab, y en el .js las que consume el
//! hook PostToolUse. Ambas TIENEN que dar el mismo veredicto, y hay dos tests
//! que lo vigilan: `conformidad_con_el_fixture_compartido` (este lado aprueba
//! los mismos casos que mide `scripts/catalog-coverage.js`) y sobre todo
//! `paridad_real_con_el_matcher_js`, que EJECUTA el módulo JS vía
//! `scripts/heuristics-spans.mjs` y compara los spans uno a uno. El primero
//! solo demuestra que los dos aprueban el mismo examen; el segundo es el que
//! detecta que se han separado fuera de él.
//!
//! Por qué existen: hasta 2026-08-15 el catálogo solo sabía ejecutar léxicos y
//! regex, así que todo lo que un LLM delata en la FORMA (frases de longitud
//! clonada, párrafos calibrados, puntuación lisa, cadenas de sinónimos para no
//! repetir el sujeto) estaba declarado pero inerte.

use std::sync::OnceLock;

use regex::Regex;

/// Tramo de texto que justifica una señal (offsets en bytes, como `regex`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

// ---------------------------------------------------------------------------
// Segmentación
// ---------------------------------------------------------------------------

struct Segmento {
    texto: String,
    start: usize,
    end: usize,
}

/// Trocea en frases por `.`, `!`, `?`, `;` y saltos de línea, conservando los
/// offsets del original. Misma frontera que el `splitSentences` del JS.
fn frases(texto: &str) -> Vec<Segmento> {
    let mut out = Vec::new();
    let mut inicio = 0usize;
    let bytes = texto.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        let corta = matches!(b, b'.' | b'!' | b'?' | b';' | b'\n');
        if !corta {
            continue;
        }
        empujar_segmento(texto, inicio, i + 1, &mut out);
        inicio = i + 1;
    }
    if inicio < texto.len() {
        empujar_segmento(texto, inicio, texto.len(), &mut out);
    }
    out
}

fn empujar_segmento(texto: &str, desde: usize, hasta: usize, out: &mut Vec<Segmento>) {
    if desde >= hasta || hasta > texto.len() {
        return;
    }
    if !texto.is_char_boundary(desde) || !texto.is_char_boundary(hasta) {
        return;
    }
    let bruto = &texto[desde..hasta];
    let recortado = bruto.trim();
    if recortado.is_empty() {
        return;
    }
    let offset = bruto.find(recortado).unwrap_or(0);
    out.push(Segmento {
        texto: recortado.to_string(),
        start: desde + offset,
        end: desde + offset + recortado.len(),
    });
}

fn parrafos(texto: &str) -> Vec<Segmento> {
    let mut out = Vec::new();
    let mut inicio = 0usize;
    let separador = Regex::new(r"\n[ \t]*\n").expect("separador de parrafos valido");
    for m in separador.find_iter(texto) {
        empujar_segmento(texto, inicio, m.start(), &mut out);
        inicio = m.end();
    }
    empujar_segmento(texto, inicio, texto.len(), &mut out);
    out
}

fn palabras(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Señales por cada 100 palabras. Los umbrales de acumulación son de densidad y
/// no de conteo: con un umbral absoluto, un texto lo bastante largo dispara
/// cualquier señal (medido sobre prosa humana de 2.000 palabras, 2026-08-15).
fn densidad(hits: usize, texto: &str) -> f64 {
    let total = palabras(texto);
    if total == 0 {
        return 0.0;
    }
    (hits as f64 * 100.0) / total as f64
}

/// Coeficiente de variación (desviación típica / media). 0 = longitudes clon.
fn coef_variacion(valores: &[usize]) -> f64 {
    if valores.len() < 2 {
        return f64::INFINITY;
    }
    let n = valores.len() as f64;
    let media = valores.iter().sum::<usize>() as f64 / n;
    if media == 0.0 {
        return f64::INFINITY;
    }
    let var = valores
        .iter()
        .map(|v| {
            let d = *v as f64 - media;
            d * d
        })
        .sum::<f64>()
        / n;
    var.sqrt() / media
}

// ---------------------------------------------------------------------------
// Heurísticas
// ---------------------------------------------------------------------------

fn monotonia_frases(texto: &str) -> Vec<Span> {
    let fs: Vec<Segmento> = frases(texto)
        .into_iter()
        .filter(|f| palabras(&f.texto) >= 2)
        .collect();
    if fs.len() < 4 {
        return Vec::new();
    }
    let longitudes: Vec<usize> = fs.iter().map(|f| palabras(&f.texto)).collect();
    if coef_variacion(&longitudes) >= 0.30 {
        return Vec::new();
    }
    vec![Span {
        start: fs[0].start,
        end: fs[fs.len() - 1].end,
    }]
}

fn uniformidad_parrafos(texto: &str) -> Vec<Span> {
    let ps: Vec<Segmento> = parrafos(texto)
        .into_iter()
        .filter(|p| palabras(&p.texto) >= 25)
        .collect();
    if ps.len() < 3 {
        return Vec::new();
    }
    let longitudes: Vec<usize> = ps.iter().map(|p| palabras(&p.texto)).collect();
    if coef_variacion(&longitudes) >= 0.20 {
        return Vec::new();
    }
    vec![Span {
        start: ps[0].start,
        end: ps[ps.len() - 1].end,
    }]
}

/// Puntuación pobre + frases largas (The Economist, 2026: mejor indicador que
/// el em dash). La coma cuenta como puntuación interna, si no el habla
/// transcrita —llena de comas y sin punto y coma— caía marcada.
fn puntuacion_pobre(texto: &str) -> Vec<Span> {
    let total = palabras(texto);
    if total < 120 {
        return Vec::new();
    }
    if texto.chars().any(|c| matches!(c, ';' | ':' | '(' | ')')) {
        return Vec::new();
    }
    let comas = texto.matches(',').count();
    if comas > 0 && (total as f64 / comas as f64) < 25.0 {
        return Vec::new();
    }
    let fs: Vec<Segmento> = frases(texto)
        .into_iter()
        .filter(|f| palabras(&f.texto) >= 2)
        .collect();
    if fs.len() < 3 {
        return Vec::new();
    }
    let media = fs.iter().map(|f| palabras(&f.texto)).sum::<usize>() as f64 / fs.len() as f64;
    if media < 20.0 {
        return Vec::new();
    }
    vec![Span {
        start: fs[0].start,
        end: fs[0].end,
    }]
}

const CONECTORES: &[&str] = &[
    "además",
    "ademas",
    "asimismo",
    "sin embargo",
    "no obstante",
    "por lo tanto",
    "por tanto",
    "en consecuencia",
    "por otro lado",
    "por otra parte",
    "en primer lugar",
    "en segundo lugar",
    "finalmente",
    "en definitiva",
    "en resumen",
    "en conclusión",
    "en conclusion",
    "de igual manera",
    "de este modo",
    "cabe destacar",
    "es importante",
];

fn densidad_conectores(texto: &str) -> Vec<Span> {
    let total = palabras(texto);
    if total < 80 {
        return Vec::new();
    }
    let minusculas = texto.to_lowercase();
    let mut hits: Vec<Span> = Vec::new();
    for c in CONECTORES {
        let mut desde = 0usize;
        while let Some(pos) = minusculas[desde..].find(c) {
            let start = desde + pos;
            hits.push(Span {
                start,
                end: start + c.len(),
            });
            desde = start + c.len();
        }
    }
    if hits.len() < 3 {
        return Vec::new();
    }
    if total as f64 / hits.len() as f64 > 35.0 {
        return Vec::new();
    }
    hits.sort_by_key(|h| h.start);
    hits.truncate(3);
    hits
}

fn re(patron: &str) -> Regex {
    Regex::new(patron).expect("regex de heuristica valida")
}

fn anaforicos() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Solo cuenta si ENCABEZA un sintagma nominal ("dicho modelo", "el
        // mencionado sistema"): el participio verbal suelto ("lo que había
        // dicho") marcaba prosa humana normal.
        // `\p{L}` y no `\w`: con `\w` (ASCII) "dicho módulo" no casaba en Rust
        // y sí en JS. La palabra que sigue al anafórico no puede ser una
        // funcional ("dicho del skill" no es una anáfora nominal); el crate
        // regex no tiene lookahead, así que se descarta después con
        // `FUNCIONALES`.
        re(r"(?i)\b(?:(?:dicho|dicha|dichos|dichas)\s+\p{L}{3,}|(?:el|la|los|las)\s+(?:mencionad|citad|aludid|referid)[oa]s?\s+\p{L}{3,})")
    })
}

fn sujeto_inicial() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // SIN `(?i)`: con la bandera, "La base vectorial los" casaba la rama
        // del determinante y en JS —que no la lleva— casaba solo "La" por la
        // rama de mayúscula inicial. Spans distintos para el mismo texto:
        // divergencia real cazada por el gate de paridad (2026-08-15).
        re(r"^((?:el|la|los|las|este|esta|estos|estas|dicho|dicha|dichos|dichas)\s+\p{L}+(?:\s+\p{L}+){0,2}|\p{Lu}\p{L}+)")
    })
}

/// Palabras funcionales que no pueden ser el nombre al que apunta la anáfora.
const FUNCIONALES: &[&str] = &[
    "de", "del", "que", "por", "para", "con", "en", "a", "al", "y", "o", "un", "una", "unos",
    "unas", "el", "la", "los", "las", "lo", "su", "sus", "mi", "tu", "se", "no", "si",
];

fn nucleo_es_funcional(fragmento: &str) -> bool {
    fragmento
        .split_whitespace()
        .last()
        .map(|w| {
            let limpio = w
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase();
            FUNCIONALES.contains(&limpio.as_str())
        })
        .unwrap_or(false)
}

fn variacion_lexica(texto: &str) -> Vec<Span> {
    let mut anafo: Vec<Span> = anaforicos()
        .find_iter(texto)
        .filter(|m| !nucleo_es_funcional(m.as_str()))
        .map(|m| Span {
            start: m.start(),
            end: m.end(),
        })
        .collect();
    if anafo.len() >= 2 {
        anafo.truncate(3);
        return anafo;
    }

    let segs = frases(texto);
    if segs.len() < 3 {
        return Vec::new();
    }
    let mut sujetos: Vec<(String, Span)> = Vec::new();
    for seg in &segs {
        let Some(m) = sujeto_inicial().find(&seg.texto) else {
            return Vec::new();
        };
        sujetos.push((
            m.as_str().to_lowercase(),
            Span {
                start: seg.start,
                end: seg.start + m.end(),
            },
        ));
    }
    let mut unicos: Vec<&String> = sujetos.iter().map(|(s, _)| s).collect();
    unicos.sort();
    unicos.dedup();
    if unicos.len() != sujetos.len() {
        return Vec::new(); // algo se repite: es prosa honesta
    }
    // Se compara la PRIMERA PALABRA, no un prefijo con espacio: el sujeto
    // puede ser el demostrativo a secas ("Este"), y exigir "este " lo dejaba
    // fuera mientras el JS —que usa \b— sí lo contaba.
    let demostrativo = sujetos.iter().any(|(s, _)| {
        s.split_whitespace().next().is_some_and(|primera| {
            matches!(
                primera,
                "este" | "esta" | "estos" | "estas" | "dicho" | "dicha" | "dichos" | "dichas"
            )
        })
    });
    if !demostrativo {
        return Vec::new();
    }
    sujetos.into_iter().map(|(_, sp)| sp).take(3).collect()
}

/// Em dash: en 2026 dejó de ser prueba por sí solo; delata la acumulación.
fn emdash_incisos(texto: &str) -> Vec<Span> {
    let hits: Vec<Span> = texto
        .match_indices('—')
        .map(|(i, s)| Span {
            start: i,
            end: i + s.len(),
        })
        .collect();
    if hits.len() < 5 || densidad(hits.len(), texto) < 1.0 {
        return Vec::new();
    }
    hits.into_iter().take(3).collect()
}

const NEUTROS: &[&str] = &[
    r"(?i)\bcomputadoras?\b",
    r"(?i)\bcelulares?\b",
    r"(?i)\bpresionar\b",
    r"(?i)\bpresione\b",
    r"(?i)\barribar\b",
    r"(?i)\bamerita\b",
    r"(?i)\binicializar\b",
    r"(?i)\bordenamiento\b",
    r"(?i)\bcarro\b",
    r"(?i)\bpapas\b",
];

fn neutros() -> &'static Vec<Regex> {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| NEUTROS.iter().map(|p| re(p)).collect())
}

fn espanol_neutro(texto: &str) -> Vec<Span> {
    let mut hits: Vec<Span> = Vec::new();
    let mut distintos = 0usize;
    for r in neutros() {
        let mut visto = false;
        for m in r.find_iter(texto) {
            hits.push(Span {
                start: m.start(),
                end: m.end(),
            });
            visto = true;
        }
        if visto {
            distintos += 1;
        }
    }
    if distintos < 2 || densidad(hits.len(), texto) < 0.5 {
        return Vec::new();
    }
    hits.sort_by_key(|h| h.start);
    hits.truncate(3);
    hits
}

const HEDGES: &[&str] = &[
    r"(?i)\bpodr[íi]an?\b",
    r"(?i)\bparece(?:r[íi]a)?\b",
    r"(?i)\ben cierta medida\b",
    r"(?i)\bhasta cierto punto\b",
    r"(?i)\bes posible que\b",
    r"(?i)\bsuele\b",
    r"(?i)\ben general\b",
    r"(?i)\bciertos?\b",
    r"(?i)\balgunos?\b",
    r"(?i)\bpuede que\b",
    r"(?i)\btiende a\b",
    r"(?i)\brelativamente\b",
];

fn hedges() -> &'static Vec<Regex> {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| HEDGES.iter().map(|p| re(p)).collect())
}

/// Un atenuador suelto es prosa honesta; delata la manta de atenuadores.
fn hedging_denso(texto: &str) -> Vec<Span> {
    let mut hits: Vec<Span> = Vec::new();
    for r in hedges() {
        for m in r.find_iter(texto) {
            hits.push(Span {
                start: m.start(),
                end: m.end(),
            });
        }
    }
    if hits.is_empty() {
        return Vec::new();
    }
    hits.sort_by_key(|h| h.start);
    if hits.len() >= 3 && densidad(hits.len(), texto) >= 0.8 {
        hits.truncate(3);
        return hits;
    }
    for f in frases(texto) {
        let dentro: Vec<Span> = hits
            .iter()
            .copied()
            .filter(|h| h.start >= f.start && h.end <= f.end)
            .collect();
        if dentro.len() >= 2 {
            return dentro.into_iter().take(3).collect();
        }
    }
    Vec::new()
}

fn subordinante_inicial() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        re(r"(?i)^(si|cuando|aunque|mientras|una vez|tras|despu[ée]s de|antes de|para que|si bien|en cuanto|dado que|puesto que|ya que|conforme|seg[úu]n|apenas|salvo que|a menos que)\b")
    })
}

fn triada() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // `\p{L}` y no `\w`: `\w` incluye dígitos y hacía que "Los valores 1, 2
        // y 3" saltara como tríada en Rust mientras JS lo dejaba pasar.
        re(r"(?i)((?:\p{L}+\s+){0,2}\p{L}+),\s+((?:\p{L}+\s+){0,2}\p{L}+),?\s+(?:y|e|and)\s+((?:\p{L}+\s+){0,2}\p{L}+)")
    })
}

/// Tricolon: se trocea en frases y se descartan las que abren con subordinante
/// (ahí la coma cierra la subordinada, no enumera).
fn tricolon(texto: &str) -> Vec<Span> {
    let mut out = Vec::new();
    for f in frases(texto) {
        if subordinante_inicial().is_match(&f.texto) {
            continue;
        }
        for m in triada().find_iter(&f.texto) {
            out.push(Span {
                start: f.start + m.start(),
                end: f.start + m.end(),
            });
            if out.len() >= 3 {
                return out;
            }
        }
    }
    out
}

/// Punto de entrada: ejecuta la heurística `id` sobre `texto`.
/// `None` = id desconocida (el catálogo manda; se degrada en silencio, mismo
/// contrato que una regex que no compila).
pub fn ejecutar(id: &str, texto: &str) -> Option<Vec<Span>> {
    let spans = match id {
        "monotonia_frases" => monotonia_frases(texto),
        "uniformidad_parrafos" => uniformidad_parrafos(texto),
        "puntuacion_pobre" => puntuacion_pobre(texto),
        "densidad_conectores" => densidad_conectores(texto),
        "variacion_lexica" => variacion_lexica(texto),
        "emdash_incisos" => emdash_incisos(texto),
        "espanol_neutro" => espanol_neutro(texto),
        "hedging_denso" => hedging_denso(texto),
        "tricolon" => tricolon(texto),
        _ => return None,
    };
    Some(spans)
}

/// ¿Existe esa heurística? Lo usa el compilador de reglas para no registrar
/// una señal que nadie sabe ejecutar.
pub fn existe(id: &str) -> bool {
    matches!(
        id,
        "monotonia_frases"
            | "uniformidad_parrafos"
            | "puntuacion_pobre"
            | "densidad_conectores"
            | "variacion_lexica"
            | "emdash_incisos"
            | "espanol_neutro"
            | "hedging_denso"
            | "tricolon"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tricolon_distingue_coma_enumerativa_de_subordinante() {
        assert!(!tricolon("El sistema es rapido, eficiente y escalable.").is_empty());
        assert!(!tricolon("La memoria, el routing y la interfaz forman el nucleo.").is_empty());
        // La coma cierra una subordinada: no es una tríada.
        assert!(tricolon("Si no hay señales, dilo y para ahi.").is_empty());
        assert!(tricolon("Cuando termine el build, avisa y sigue con el deploy.").is_empty());
    }

    #[test]
    fn monotonia_solo_con_frases_clonadas() {
        let clon = "El sistema indexa los datos. El modelo genera los vectores. La base almacena los indices. El motor responde las consultas.";
        assert!(!monotonia_frases(clon).is_empty());
        let variado = "El sistema indexa. Luego el modelo, que carga 2,1 GB de pesos en memoria residente y tarda casi cuatro segundos en arrancar, genera los vectores. Se almacenan. El motor responde en 144 ms.";
        assert!(monotonia_frases(variado).is_empty());
    }

    #[test]
    fn hedging_exige_acumulacion() {
        assert!(hedging_denso(
            "El recall podria bajar si el corpus crece por encima de 10.000 elementos."
        )
        .is_empty());
        assert!(!hedging_denso(
            "En cierta medida, algunos resultados podrian parecer relativamente mejores."
        )
        .is_empty());
    }

    #[test]
    fn variacion_lexica_ignora_el_participio_verbal() {
        // "lo que había dicho" / "te he mencionado" NO son anáforas nominales.
        assert!(variacion_lexica("Por otro lado, lo que había dicho del routing no me convence y lo que te he mencionado del color tampoco.").is_empty());
        assert!(!variacion_lexica("El transformador procesa la entrada; dicho modelo la codifica y el mencionado sistema la devuelve.").is_empty());
    }

    #[test]
    fn emdash_necesita_acumulacion_no_presencia() {
        assert!(emdash_incisos("El sistema —que carga dos modelos— consume 3 GB.").is_empty());
        assert!(!emdash_incisos("El sistema —que carga dos modelos— consume 3 GB, y el daemon —ya medido— otros 1,5 GB, mientras la interfaz —Chromium puro— se lleva el resto.").is_empty());
    }

    /// CONFORMIDAD con el fixture compartido: este lado aprueba los mismos
    /// casos que mide `scripts/catalog-coverage.js`. No es paridad — que las
    /// dos implementaciones aprueben el mismo examen no prueba que coincidan
    /// fuera de él. La paridad real la mide `paridad_real_con_el_matcher_js`.
    #[test]
    fn conformidad_con_el_fixture_compartido() {
        let raiz = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("raiz del repo");
        let fixture_path = raiz.join("scripts/fixtures/catalog-cases.json");
        let catalogo_path = raiz.join("docs/research/patrones-texto-ia.json");
        let (Ok(fixture_raw), Ok(catalogo_raw)) = (
            std::fs::read_to_string(&fixture_path),
            std::fs::read_to_string(&catalogo_path),
        ) else {
            // Sin fixture no se puede medir paridad; no se inventa un verde.
            panic!(
                "faltan {} o {}",
                fixture_path.display(),
                catalogo_path.display()
            );
        };
        let fixture: serde_json::Value = serde_json::from_str(&fixture_raw).expect("fixture json");
        let catalogo: serde_json::Value =
            serde_json::from_str(&catalogo_raw).expect("catalogo json");

        let patrones = catalogo["patrones"].as_array().expect("patrones");
        let casos = fixture["patrones"].as_array().expect("casos");
        let mut comprobados = 0usize;

        for caso in casos {
            let nombre = caso["nombre"].as_str().unwrap_or_default();
            let patron = patrones
                .iter()
                .find(|p| p["nombre"].as_str().unwrap_or_default() == nombre);
            let Some(patron) = patron else { continue };
            let senales = patron["senales_ejecutables"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let ids: Vec<String> = senales
                .iter()
                .filter(|s| s["tipo"].as_str() == Some("heuristica"))
                .filter_map(|s| s["valor"].as_str().map(str::to_string))
                .collect();
            if ids.is_empty() {
                continue; // patrón de regex/léxico: lo cubre el otro harness
            }
            comprobados += 1;
            let marca = |texto: &str| {
                ids.iter()
                    .any(|id| ejecutar(id, texto).map(|s| !s.is_empty()).unwrap_or(false))
            };
            for p in caso["positivos"].as_array().cloned().unwrap_or_default() {
                let t = p.as_str().unwrap_or_default();
                assert!(marca(t), "[{nombre}] positivo no detectado en Rust: {t}");
            }
            for n in caso["negativos"].as_array().cloned().unwrap_or_default() {
                let t = n.as_str().unwrap_or_default();
                assert!(
                    !marca(t),
                    "[{nombre}] negativo marcado por error en Rust: {t}"
                );
            }
        }
        assert!(
            comprobados >= 6,
            "solo {comprobados} patrones heuristicos comprobados"
        );
    }

    /// GATE DE PARIDAD REAL: ejecuta el matcher JS sobre el mismo corpus y
    /// compara los SPANS, no un booleano. Es lo único que detecta que las dos
    /// implementaciones se han separado (una regex ASCII aquí, un umbral
    /// distinto allá) en textos que el fixture no cubre.
    ///
    /// Node es una dependencia real del sistema (los hooks son node), así que
    /// su ausencia se trata como fallo y no como excusa para un verde.
    #[test]
    fn paridad_real_con_el_matcher_js() {
        let raiz = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("raiz del repo");
        let emisor = raiz.join("scripts/heuristics-spans.mjs");
        assert!(emisor.exists(), "falta {}", emisor.display());

        let ids: Vec<&str> = vec![
            "monotonia_frases",
            "uniformidad_parrafos",
            "puntuacion_pobre",
            "densidad_conectores",
            "variacion_lexica",
            "emdash_incisos",
            "espanol_neutro",
            "hedging_denso",
            "tricolon",
        ];

        // Corpus: todo el fixture (positivos y negativos) mas textos que lo
        // desbordan a proposito — acentos, mayusculas acentuadas, elipsis,
        // digitos dentro de la triada, em dash repetidos y prosa larga.
        let fixture_raw = std::fs::read_to_string(raiz.join("scripts/fixtures/catalog-cases.json"))
            .expect("fixture json");
        let fixture: serde_json::Value = serde_json::from_str(&fixture_raw).expect("fixture json");
        let mut textos: Vec<String> = Vec::new();
        for caso in fixture["patrones"].as_array().cloned().unwrap_or_default() {
            for clave in ["positivos", "negativos"] {
                for t in caso[clave].as_array().cloned().unwrap_or_default() {
                    if let Some(s) = t.as_str() {
                        textos.push(s.to_string());
                    }
                }
            }
        }
        textos.extend(
            [
                "Ánimo: el módulo se erige como núcleo. Éxito rotundo, dicho módulo responde.",
                "El sistema es rápido, eficiente y escalable... y además barato.",
                "Los valores 1, 2 y 3 se guardan en el índice.",
                "Uno —dos— tres —cuatro— cinco —seis— siete.",
                "Dicho del skill agents, lo que te he mencionado del color no encaja.",
                "El equipo usa una computadora con Linux; nadie presiona nada raro.",
                "",
                "   ",
            ]
            .iter()
            .map(|s| s.to_string()),
        );

        let entrada = serde_json::json!({ "textos": textos, "ids": ids }).to_string();
        let mut hijo = std::process::Command::new("node")
            .arg(&emisor)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("node debe estar en PATH: los hooks del sistema son node");
        {
            use std::io::Write;
            hijo.stdin
                .as_mut()
                .expect("stdin")
                .write_all(entrada.as_bytes())
                .expect("escribir corpus");
        }
        let salida = hijo.wait_with_output().expect("ejecutar node");
        assert!(
            salida.status.success(),
            "el emisor JS fallo: {}",
            String::from_utf8_lossy(&salida.stderr)
        );
        let js: serde_json::Value =
            serde_json::from_slice(&salida.stdout).expect("salida JSON del emisor");
        let resultados = js["resultados"].as_array().expect("resultados");
        assert_eq!(resultados.len(), textos.len(), "un resultado por texto");

        let mut divergencias: Vec<String> = Vec::new();
        for (i, texto) in textos.iter().enumerate() {
            for id in &ids {
                let esperado: Vec<(usize, usize)> = resultados[i][id]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|p| {
                        let a = p[0].as_u64()? as usize;
                        let b = p[1].as_u64()? as usize;
                        Some((a, b))
                    })
                    .collect();
                let obtenido: Vec<(usize, usize)> = ejecutar(id, texto)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|s| (s.start, s.end))
                    .collect();
                if esperado != obtenido {
                    divergencias.push(format!(
                        "[{id}] texto {i} ({:.40}...): js={esperado:?} rust={obtenido:?}",
                        texto.replace('\n', " ")
                    ));
                }
            }
        }
        assert!(
            divergencias.is_empty(),
            "JS y Rust divergen en {} caso(s):\n{}",
            divergencias.len(),
            divergencias.join("\n")
        );
    }
}
