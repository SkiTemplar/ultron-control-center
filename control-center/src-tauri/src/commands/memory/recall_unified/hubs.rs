// recall_unified/hubs.rs — penalización de memorias "comodín" (hubs).
//
// Un hub es un item que el recall inyecta en una fracción alta de prompts sin
// relación entre sí. Medido el 2026-09-23 sobre 154 prompts reales: una
// restricción de sesión ajena salía en el 31 % y "Se eliminaron 2 capturas
// repetidas" llevaba 1.118 accesos; en el pool del golden v3 otros tres items
// aparecían en casi todas las queries. Son frases cortas y genéricas que E5
// sitúa cerca de todo y BM25 premia por longitud.
//
// Dos piezas:
//   - `compute_hubs` (subcomando `ultron-memory hubs`): repite prompts reales de
//     `~/.claude/logs/orchestrate.jsonl` por el recall en CRUDO (sin esta
//     penalización, para que la lista no oscile al aplicarse) y guarda en
//     `~/.ultron/cockpit/memory-hubs.json` los items por encima del umbral.
//   - `hub_factor`: el motor multiplica el rrf_score de esos items por
//     `ULTRON_HUB_PENALTY` (defecto 0,5; `1` o `off` lo desactiva). Es un
//     down-rank, no un filtro: si la query sí trata de ese item, dense/sparse
//     lo siguen subiendo.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Multiplicador por defecto del rrf_score de un hub.
pub const DEFAULT_HUB_PENALTY: f32 = 0.5;

/// Env para forzar el recall en crudo (la usa `compute_hubs` en su proceso).
const HUB_PENALTY_ENV: &str = "ULTRON_HUB_PENALTY";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HubEntry {
    pub id: String,
    /// Fracción de prompts (de los que podían verlo) en los que se inyectó.
    pub rate: f32,
    pub count: usize,
    /// Prompts que podían verlo: los de su proyecto si es de proyecto; todos si no.
    pub denominator: usize,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubReport {
    pub generated_at: String,
    pub prompts: usize,
    pub threshold: f32,
    pub min_count: usize,
    pub hubs: Vec<HubEntry>,
}

pub fn hubs_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join("cockpit")
            .join("memory-hubs.json"),
    )
}

/// Penalización vigente: `ULTRON_HUB_PENALTY` (0..=1) o el defecto.
pub fn hub_penalty() -> f32 {
    match std::env::var(HUB_PENALTY_ENV) {
        Ok(v) if v.eq_ignore_ascii_case("off") => 1.0,
        Ok(v) => v
            .trim()
            .parse::<f32>()
            .ok()
            .filter(|p| (0.0..=1.0).contains(p))
            .unwrap_or(DEFAULT_HUB_PENALTY),
        Err(_) => DEFAULT_HUB_PENALTY,
    }
}

/// Ids de hub vigentes, releídos solo cuando cambia el mtime del fichero.
fn hub_ids() -> HashSet<String> {
    static CACHE: OnceLock<Mutex<(Option<SystemTime>, HashSet<String>)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((None, HashSet::new())));
    let Some(path) = hubs_path() else {
        return HashSet::new();
    };
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let Ok(mut guard) = cache.lock() else {
        return HashSet::new();
    };
    if guard.0 != mtime {
        let ids = mtime
            .and_then(|_| std::fs::read_to_string(&path).ok())
            .and_then(|t| serde_json::from_str::<HubReport>(&t).ok())
            .map(|r| r.hubs.into_iter().map(|h| h.id).collect())
            .unwrap_or_default();
        *guard = (mtime, ids);
    }
    guard.1.clone()
}

/// Factor para el rrf_score de `id`: la penalización si es hub, 1.0 si no.
pub fn hub_factor(id: &str, penalty: f32) -> f32 {
    if penalty >= 1.0 {
        return 1.0;
    }
    if hub_ids().contains(id) {
        penalty
    } else {
        1.0
    }
}

/// Prompt real ya servido: (proyecto, prompt).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LoggedPrompt {
    pub project: String,
    pub prompt: String,
}

/// Últimos `limit` prompts distintos de `orchestrate.jsonl` (más recientes
/// primero), con proyecto y de longitud razonable. PURA sobre el texto del log.
pub fn recent_prompts(log_text: &str, limit: usize) -> Vec<LoggedPrompt> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in log_text.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let (Some(project), Some(prompt)) = (
            v.get("project").and_then(|x| x.as_str()),
            v.get("prompt").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        let chars = prompt.chars().count();
        if project.is_empty() || !(4..=600).contains(&chars) {
            continue;
        }
        let key = LoggedPrompt {
            project: project.to_string(),
            prompt: prompt.to_string(),
        };
        if seen.insert(key.clone()) {
            out.push(key);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// Cuenta de inyecciones por item y hubs resultantes. `injected[i]` son los ids
/// inyectados para `prompts[i]`; `item_project` da el proyecto de un id
/// (`None` = global/ambiente, compite en todos los prompts). PURA.
pub fn select_hubs(
    prompts: &[LoggedPrompt],
    injected: &[Vec<String>],
    item_project: &HashMap<String, Option<String>>,
    summaries: &HashMap<String, String>,
    threshold: f32,
    min_count: usize,
) -> Vec<HubEntry> {
    let mut per_project: HashMap<&str, usize> = HashMap::new();
    for p in prompts {
        *per_project.entry(p.project.as_str()).or_default() += 1;
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for ids in injected {
        let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
        for id in unique {
            *counts.entry(id).or_default() += 1;
        }
    }
    let mut hubs: Vec<HubEntry> = counts
        .into_iter()
        .filter_map(|(id, count)| {
            let denominator = match item_project.get(id).cloned().flatten() {
                Some(p) => per_project.get(p.as_str()).copied().unwrap_or(0),
                None => prompts.len(),
            };
            if denominator == 0 || count < min_count {
                return None;
            }
            let rate = count as f32 / denominator as f32;
            (rate >= threshold).then(|| HubEntry {
                id: id.to_string(),
                rate,
                count,
                denominator,
                summary: summaries.get(id).cloned().unwrap_or_default(),
            })
        })
        .collect();
    hubs.sort_by(|a, b| {
        b.rate
            .partial_cmp(&a.rate)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hubs
}

/// Repite `limit` prompts reales por el recall en crudo y devuelve el informe.
/// Con `apply` escribe `memory-hubs.json`. El recall en crudo se consigue
/// fijando `ULTRON_HUB_PENALTY=off` en ESTE proceso (el daemon no se entera).
/// `with_penalty` mide el recall CON la penalización vigente (para comparar
/// antes/después); en ese modo nunca se escribe el fichero.
pub fn compute_hubs(
    limit: usize,
    threshold: f32,
    min_count: usize,
    apply: bool,
    with_penalty: bool,
) -> Result<HubReport, String> {
    if !with_penalty {
        std::env::set_var(HUB_PENALTY_ENV, "off");
    }
    let log = dirs::home_dir()
        .ok_or("no HOME")?
        .join(".claude")
        .join("logs")
        .join("orchestrate.jsonl");
    let text = std::fs::read_to_string(&log).map_err(|e| format!("{}: {e}", log.display()))?;
    let prompts = recent_prompts(&text, limit);
    if prompts.is_empty() {
        return Err("orchestrate.jsonl sin prompts utilizables".into());
    }

    let mut injected: Vec<Vec<String>> = Vec::with_capacity(prompts.len());
    for p in &prompts {
        // Mismo camino que el hot path del hook: híbrido, sin cross-encoder.
        let ids = super::engine::build_trace(&p.prompt, 8, Some(&p.project), false, true, false)
            .map(|t| t.injected.into_iter().map(|e| e.canonical_id).collect())
            .unwrap_or_default();
        injected.push(ids);
    }

    let conn = crate::memory::sqlite_store::open_conn().map_err(|e| e.to_string())?;
    let mut item_project = HashMap::new();
    let mut summaries = HashMap::new();
    for id in injected.iter().flatten() {
        if item_project.contains_key(id) {
            continue;
        }
        if let Ok(Some(it)) = crate::memory::sqlite_store::get_item(&conn, id) {
            let scoped = matches!(it.scope, crate::memory::Scope::Project);
            item_project.insert(
                id.clone(),
                if scoped { it.project_id.clone() } else { None },
            );
            summaries.insert(id.clone(), it.summary.or(it.title).unwrap_or_default());
        }
    }

    let report = HubReport {
        generated_at: chrono::Utc::now().to_rfc3339(),
        prompts: prompts.len(),
        threshold,
        min_count,
        hubs: select_hubs(
            &prompts,
            &injected,
            &item_project,
            &summaries,
            threshold,
            min_count,
        ),
    };
    if apply && !with_penalty {
        let path = hubs_path().ok_or("no HOME")?;
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(project: &str, prompt: &str) -> LoggedPrompt {
        LoggedPrompt {
            project: project.into(),
            prompt: prompt.into(),
        }
    }

    #[test]
    fn recent_prompts_deduplica_filtra_y_va_de_reciente_a_antiguo() {
        let log = [
            r#"{"project":"ultron","prompt":"primero de todos"}"#,
            r#"{"project":"ultron","prompt":"ok"}"#,
            r#"{"project":"","prompt":"sin proyecto aqui"}"#,
            r#"no es json"#,
            r#"{"project":"ultron","prompt":"primero de todos"}"#,
            r#"{"project":"tfg","prompt":"el mas reciente"}"#,
        ]
        .join("\n");
        let got = recent_prompts(&log, 10);
        assert_eq!(
            got,
            vec![p("tfg", "el mas reciente"), p("ultron", "primero de todos")]
        );
        assert_eq!(recent_prompts(&log, 1).len(), 1);
    }

    #[test]
    fn un_item_global_en_muchos_prompts_es_hub_y_uno_puntual_no() {
        let prompts: Vec<_> = (0..10)
            .map(|i| p(if i < 5 { "a" } else { "b" }, &format!("q{i}")))
            .collect();
        let injected: Vec<Vec<String>> = (0..10)
            .map(|i| {
                let mut v = vec!["global".to_string()];
                if i == 3 {
                    v.push("puntual".into());
                }
                v
            })
            .collect();
        let proj = HashMap::from([("global".to_string(), None), ("puntual".to_string(), None)]);
        let hubs = select_hubs(&prompts, &injected, &proj, &HashMap::new(), 0.2, 3);
        assert_eq!(hubs.len(), 1);
        assert_eq!(hubs[0].id, "global");
        assert!((hubs[0].rate - 1.0).abs() < 1e-6);
    }

    #[test]
    fn el_denominador_de_un_item_de_proyecto_son_los_prompts_de_su_proyecto() {
        // 20 prompts: 4 del proyecto "t". Un item de "t" en 2 de sus 4 prompts
        // es el 50 % de lo que podía ver (hub con umbral 0,4), aunque sea el
        // 10 % del total.
        let prompts: Vec<_> = (0..20)
            .map(|i| p(if i < 4 { "t" } else { "u" }, &format!("q{i}")))
            .collect();
        let injected: Vec<Vec<String>> = (0..20)
            .map(|i| {
                if i < 2 {
                    vec!["de_t".to_string()]
                } else {
                    vec![]
                }
            })
            .collect();
        let proj = HashMap::from([("de_t".to_string(), Some("t".to_string()))]);
        let hubs = select_hubs(&prompts, &injected, &proj, &HashMap::new(), 0.4, 2);
        assert_eq!(hubs.len(), 1);
        assert_eq!(hubs[0].denominator, 4);
        // Caso negativo: por debajo de min_count no hay hub aunque la tasa sea alta.
        assert!(select_hubs(&prompts, &injected, &proj, &HashMap::new(), 0.4, 3).is_empty());
    }

    #[test]
    fn un_id_repetido_en_el_mismo_pack_cuenta_una_vez() {
        let prompts = vec![p("a", "q0"), p("a", "q1")];
        let injected = vec![vec!["x".to_string(), "x".to_string()], vec![]];
        let proj = HashMap::from([("x".to_string(), None)]);
        let hubs = select_hubs(&prompts, &injected, &proj, &HashMap::new(), 0.5, 1);
        assert_eq!(hubs[0].count, 1);
    }

    #[test]
    fn penalizacion_desactivada_devuelve_uno_siempre() {
        assert_eq!(hub_factor("cualquiera", 1.0), 1.0);
    }
}
