//! tfg_heuristics_densidad.rs — heurísticas de DENSIDAD para marcas de formato
//! y de discurso del detector de texto IA.
//!
//! Gemelo Rust de `hooks/scripts/lib/ai-text-heuristics-densidad.js`. Nació de
//! la auditoría del humanizer sobre el README (2026-10-18): un texto con 16
//! negritas decorativas, un contraste «no X: lo Y» y una frase que hablaba del
//! propio documento salía `sin_indicios`.
//!
//! Las tres pesan por densidad, como `emdash_incisos`: una aparición suelta es
//! escritura humana normal y no dispara. Umbrales fijados contra los fixtures
//! de `scripts/fixtures/ai-text-falsos-negativos/` (un texto técnico por clase:
//! cifra mejor disponible, no garantía). `paridad_real_con_el_matcher_js`
//! (tfg_heuristics.rs) compara los spans con los del JS.

use std::sync::OnceLock;

use regex::Regex;

use crate::tfg_heuristics::Span;

const MAX_SPANS: usize = 3;
const MIN_NEGRITAS: usize = 5;
const DENSIDAD_NEGRITAS: f64 = 1.0;
const MIN_DISCURSO: usize = 2;
const DENSIDAD_DISCURSO: f64 = 0.3;

fn densidad(hits: usize, texto: &str) -> f64 {
    let total = texto.split_whitespace().count();
    if total == 0 {
        return 0.0;
    }
    (hits as f64 * 100.0) / total as f64
}

fn re(patron: &str) -> Regex {
    Regex::new(patron).expect("regex de heuristica valida")
}

fn spans_de(r: &Regex, texto: &str) -> Vec<Span> {
    r.find_iter(texto)
        .filter(|m| !m.as_str().is_empty())
        .map(|m| Span {
            start: m.start(),
            end: m.end(),
        })
        .collect()
}

/// Ordena por inicio y descarta los spans que se solapan con uno anterior.
fn sin_solapes(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by_key(|s| (s.start, s.end));
    let mut out: Vec<Span> = Vec::new();
    let mut fin = 0usize;
    for s in spans {
        if out.is_empty() || s.start >= fin {
            fin = s.end;
            out.push(s);
        }
    }
    out
}

fn por_densidad(mut spans: Vec<Span>, texto: &str, minimo: usize, umbral: f64) -> Vec<Span> {
    if spans.len() < minimo || densidad(spans.len(), texto) < umbral {
        return Vec::new();
    }
    spans.truncate(MAX_SPANS);
    spans
}

// --- negrita en prosa --------------------------------------------------------

fn negrita() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Puede cruzar UN salto de línea (prosa ajustada), nunca un párrafo.
    RE.get_or_init(|| re(r"\*\*[^*\n]+(?:\n[^*\n]+)?\*\*"))
}

fn prefijo_lista() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| re(r"^\s*(?:[-*+]|\d+[.)])?\s*$"))
}

/// Rangos [inicio, fin) de los bloques de código con valla (``` o ~~~).
fn rangos_de_codigo(texto: &str) -> Vec<(usize, usize)> {
    let mut rangos = Vec::new();
    let mut offset = 0usize;
    let mut abierto: Option<usize> = None;
    for linea in texto.split('\n') {
        let t = linea.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            match abierto.take() {
                None => abierto = Some(offset),
                Some(a) => rangos.push((a, offset + linea.len())),
            }
        }
        offset += linea.len() + 1;
    }
    if let Some(a) = abierto {
        rangos.push((a, texto.len()));
    }
    rangos
}

/// ¿Clave de lista de definiciones («- **Clave**: valor») o fila de tabla?
fn es_negrita_estructural(texto: &str, start: usize, end: usize) -> bool {
    let inicio_linea = texto[..start].rfind('\n').map_or(0, |p| p + 1);
    if texto[inicio_linea..].trim_start().starts_with('|') {
        return true;
    }
    if !prefijo_lista().is_match(&texto[inicio_linea..start]) {
        return false;
    }
    let contenido = &texto[start + 2..end - 2];
    contenido.trim_end().ends_with(':') || texto[end..].starts_with(':')
}

/// Negrita decorativa en prosa: etiquetas y énfasis en negrita acumulados.
pub(crate) fn negrita_densa(texto: &str) -> Vec<Span> {
    let codigo = rangos_de_codigo(texto);
    let spans: Vec<Span> = spans_de(negrita(), texto)
        .into_iter()
        .filter(|s| !codigo.iter().any(|&(a, b)| s.start >= a && s.start < b))
        .filter(|s| !es_negrita_estructural(texto, s.start, s.end))
        .collect();
    por_densidad(spans, texto, MIN_NEGRITAS, DENSIDAD_NEGRITAS)
}

// --- contraste negativo ------------------------------------------------------

const COPULA: &str = "(?:es|son|era|eran|fue|fueron)";

fn no_es_x_es_y() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        re(&format!(
            r"(?i)\bno\s+{COPULA}\s+[^.,;:!?]{{1,60}}?[,;:]\s*{COPULA}\b"
        ))
    })
}

/// «no X, sino Y». «no es… sino» y «no solo… sino» tienen patrón propio de
/// aparición en el catálogo: se descartan después para no contarlos dos veces
/// (el crate regex no tiene lookahead).
fn no_x_sino_y() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| re(r"(?i)\bno\s+(\p{L}+)[^.;:!?]{0,60}?,?\s+sino\b"))
}

fn no_x_dos_puntos() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        re(r"(?i)\bno\s+\p{L}+[^.;:!?]{0,60}?:\s*(?:lo|la|los|las|le|les|se)\s+\p{L}+")
    })
}

/// Contraste negativo acumulado: «no es X, es Y», «no X, sino Y», «no X: lo Y».
pub(crate) fn contraste_negativo(texto: &str) -> Vec<Span> {
    let mut spans = spans_de(no_es_x_es_y(), texto);
    for c in no_x_sino_y().captures_iter(texto) {
        let verbo = c
            .get(1)
            .map(|m| m.as_str().to_lowercase())
            .unwrap_or_default();
        if matches!(verbo.as_str(), "es" | "solo" | "sólo") {
            continue;
        }
        if let Some(m) = c.get(0) {
            spans.push(Span {
                start: m.start(),
                end: m.end(),
            });
        }
    }
    spans.extend(spans_de(no_x_dos_puntos(), texto));
    por_densidad(sin_solapes(spans), texto, MIN_DISCURSO, DENSIDAD_DISCURSO)
}

// --- metacomentario ----------------------------------------------------------

const METAS: &[&str] = &[
    r"(?i)\b(?:este|esta|el presente|la presente)\s+(?:documento|documentaci[oó]n|secci[oó]n|apartado|readme|gu[ií]a|texto)\b",
    r"(?i)\ba continuaci[oó]n,?\s+se\s+\p{L}+",
    r"(?i)\ben\s+(?:la siguiente|las siguientes)\s+secci(?:[oó]n|ones)\b",
];

fn metas() -> &'static Vec<Regex> {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| METAS.iter().map(|p| re(p)).collect())
}

/// El texto habla de sí mismo («este documento», «a continuación se…»).
pub(crate) fn metacomentario(texto: &str) -> Vec<Span> {
    let spans: Vec<Span> = metas().iter().flat_map(|r| spans_de(r, texto)).collect();
    por_densidad(sin_solapes(spans), texto, MIN_DISCURSO, DENSIDAD_DISCURSO)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTA: &str = "- **Memoria gobernada** — `brain.db` (SQLite) como unica fuente de verdad.\n- **Recall hibrido** — denso y sparse fusionados.\n- **Inbox** — las capturas proponen.\n- **Redaccion** — secretos fuera.\n- **AI Router** — cadena por zona.";

    #[test]
    fn negrita_exige_acumulacion_en_prosa() {
        assert!(!negrita_densa(LISTA).is_empty());
        assert!(negrita_densa("- **Recall hibrido** — denso y sparse fusionados.").is_empty());
    }

    #[test]
    fn negrita_ignora_tablas_definiciones_y_codigo() {
        let tabla = "| **a** | **b** |\n| **c** | **d** |\n| **e** | **f** |";
        let defs = "- **Version**: 1\n- **Licencia**: MIT\n- **Autor:** yo\n- **Estado**: activo\n- **Idioma**: es";
        let codigo = "```\n**uno** **dos** **tres** **cuatro** **cinco**\n```";
        assert!(negrita_densa(&format!("{tabla}\n\n{defs}\n\n{codigo}")).is_empty());
    }

    #[test]
    fn contraste_exige_dos_y_descarta_los_ya_cubiertos() {
        let uno = "No reemplaza a Claude\nCode: lo envuelve con estado persistente.";
        assert!(contraste_negativo(uno).is_empty());
        let dos = format!("{uno} No sustituye al editor: lo complementa con atajos.");
        assert_eq!(contraste_negativo(&dos).len(), 2);
        // «no es… sino» ya lo mide otro patrón: no suma aquí.
        assert!(
            contraste_negativo("No es caro, sino barato. No es lento, sino rapido.").is_empty()
        );
        assert!(!contraste_negativo("La cache no es un adorno, es la pieza clave. El indice no es un lujo, es lo que responde.").is_empty());
    }

    #[test]
    fn metacomentario_exige_dos() {
        assert!(metacomentario("Esta documentacion describe el sistema.").is_empty());
        assert!(!metacomentario(
            "En esta sección se describe el daemon. Este documento resume las decisiones."
        )
        .is_empty());
    }
}
