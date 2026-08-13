// orchestrator/personality.rs — Personalities v1 (diseño del usuario, 2026-08-12/13).
//
// Detección DETERMINISTA del TONO del chat (señales léxicas + petición
// explícita) dentro del orchestrate del sidecar: cero hooks nuevos, cero
// latencia extra apreciable (una lectura de JSON + matching por tokens, <1ms).
//
// Fuente de verdad EDITABLE: `~/.ultron/personality.json` (gitignored — es
// config personal del usuario y puede contener registro informal fuerte que
// no debe entrar al repo público). Si no existe, se siembra desde
// `seed_tones()` con una versión publicable de los mismos tonos.
//
// Reglas de decisión (en orden):
//   1. Petición explícita ("modo cani", "talk like a cowboy") → ese tono.
//   2. Señales léxicas: gana el tono con más señales DISTINTAS matcheadas,
//      con floor de 2 señales — o 1 sola si es una señal FUERTE (inequívoca
//      del tono, p.ej. "shurmano" → cani, "howdy" → cowboy).
//   3. Sin ganador, o si gana el tono default → `None`: no se inyecta nada
//      (la personalidad base del asistente ya es el default).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Señal sintética para prompts escritos GRITANDO (ratio de mayúsculas alto).
/// Cuenta como señal del tono que la declare en `signals` (pura-cepa).
const ALL_CAPS_SIGNAL: &str = "(GRITANDO)";
/// Un prompt cuenta como "gritado" si ≥60% de sus letras son mayúsculas y hay
/// al menos 12 letras (evita falsos positivos con "OK" o siglas sueltas).
const ALL_CAPS_RATIO: f32 = 0.6;
const ALL_CAPS_MIN_LETTERS: usize = 12;
/// Floor de señales distintas para activar un tono sin petición explícita.
const SIGNAL_FLOOR: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToneDef {
    pub id: String,
    pub name: String,
    /// "es" | "en" — idioma en el que responde el tono.
    pub lang: String,
    pub description: String,
    /// Guía de estilo que se inyecta al modelo cuando el tono se activa.
    pub style_guide: String,
    /// Señales léxicas de detección (palabra suelta o frase, sin diacríticos).
    #[serde(default)]
    pub signals: Vec<String>,
    /// Subconjunto de señales inequívocas: UNA sola basta para activar.
    #[serde(default)]
    pub strong_signals: Vec<String>,
    /// Frases de petición explícita ("modo cani") — prioridad máxima.
    #[serde(default)]
    pub explicit_triggers: Vec<String>,
    /// Vocabulario de apoyo para el escritor (no participa en la detección).
    #[serde(default)]
    pub lexicon: Vec<String>,
    /// "none" | "mild" | "full" — nivel de insultos permitido al responder.
    #[serde(default)]
    pub profanity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalityFile {
    pub version: u32,
    /// Tono por defecto (no se inyecta: es la personalidad base del sistema).
    pub default_tone: String,
    pub tones: Vec<ToneDef>,
}

/// Tono elegido para el prompt — viaja dentro de `OrchestrationContext`.
#[derive(Debug, Clone, Serialize)]
pub struct ToneChoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub style_guide: String,
    pub profanity: String,
    pub matched_signals: Vec<String>,
    pub reason: String,
    pub explicit: bool,
}

/// Score por tono para el playground (Library → Tones): el "por qué" visible.
#[derive(Debug, Clone, Serialize)]
pub struct ToneScore {
    pub id: String,
    pub name: String,
    pub hits: Vec<String>,
    pub explicit_hit: Option<String>,
}

/// Resultado completo del detector para el playground.
#[derive(Debug, Clone, Serialize)]
pub struct ToneDetection {
    pub chosen: Option<ToneChoice>,
    pub scores: Vec<ToneScore>,
    pub default_tone: String,
}

pub fn personality_path() -> PathBuf {
    // Sin HOME (imposible en la práctica) el load fallará la lectura y el
    // detector servirá seeds en memoria — nunca panic en el hot path.
    crate::ultron_root()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("personality.json")
}

/// Minúsculas + sin diacríticos, para matching estable ("qué"=="que").
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            _ => c,
        })
        .collect()
}

/// ¿`needle` (ya normalizada) aparece en `haystack` con límites de palabra?
/// Para frases multi-palabra el matching es substring con bordes no-alfanuméricos;
/// para tokens sueltos equivale a igualdad de palabra completa ("cani" no
/// matchea "mecánica").
fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(needle) {
        let start = from + pos;
        let end = start + needle.len();
        let left_ok = start == 0
            || !haystack[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric());
        let right_ok = end >= haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric());
        if left_ok && right_ok {
            return true;
        }
        from = end;
    }
    false
}

fn is_all_caps(prompt: &str) -> bool {
    let letters: Vec<char> = prompt.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() < ALL_CAPS_MIN_LETTERS {
        return false;
    }
    let upper = letters.iter().filter(|c| c.is_uppercase()).count();
    (upper as f32 / letters.len() as f32) >= ALL_CAPS_RATIO
}

/// Carga `personality.json`; si no existe lo siembra. Un archivo ilegible NO
/// rompe el hot path: se devuelven los seeds y un warning para el contexto.
pub fn load_or_seed() -> (PersonalityFile, Option<String>) {
    let path = personality_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<PersonalityFile>(&raw) {
            Ok(file) => (file, None),
            Err(e) => (
                seed_file(),
                Some(format!(
                    "personality.json ilegible ({e}) — tonos servidos desde seeds"
                )),
            ),
        },
        Err(_) => {
            let file = seed_file();
            // Siembra best-effort: si no se puede escribir, se sirve en memoria.
            if let Ok(json) = serde_json::to_string_pretty(&file) {
                let _ = std::fs::write(&path, json + "\n");
            }
            (file, None)
        }
    }
}

/// Guarda el archivo validando invariantes mínimos (ids únicos, default real).
pub fn save(file: &PersonalityFile) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for t in &file.tones {
        if t.id.trim().is_empty() {
            return Err("tone con id vacío".into());
        }
        if !seen.insert(t.id.as_str()) {
            return Err(format!("id de tono duplicado: {}", t.id));
        }
    }
    if !file.tones.iter().any(|t| t.id == file.default_tone) {
        return Err(format!(
            "default_tone '{}' no existe en la lista de tonos",
            file.default_tone
        ));
    }
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(personality_path(), json + "\n").map_err(|e| e.to_string())
}

/// Detección completa (playground): scores de TODOS los tonos + elegido.
pub fn detect(prompt: &str, file: &PersonalityFile) -> ToneDetection {
    let norm = normalize(prompt);
    let shouting = is_all_caps(prompt);

    let mut scores: Vec<ToneScore> = Vec::new();
    for tone in &file.tones {
        let explicit_hit = tone
            .explicit_triggers
            .iter()
            .find(|t| contains_word(&norm, &normalize(t)))
            .cloned();
        let mut hits: Vec<String> = Vec::new();
        for s in &tone.signals {
            if s == ALL_CAPS_SIGNAL {
                if shouting {
                    hits.push(ALL_CAPS_SIGNAL.to_string());
                }
            } else if contains_word(&norm, &normalize(s)) {
                hits.push(s.clone());
            }
        }
        scores.push(ToneScore {
            id: tone.id.clone(),
            name: tone.name.clone(),
            hits,
            explicit_hit,
        });
    }

    // 1) Petición explícita gana siempre (primer tono con trigger presente).
    let explicit_winner = scores.iter().find(|s| s.explicit_hit.is_some());
    if let Some(win) = explicit_winner {
        let tone = file.tones.iter().find(|t| t.id == win.id).unwrap();
        let trigger = win.explicit_hit.clone().unwrap_or_default();
        return ToneDetection {
            chosen: Some(choice_from(
                tone,
                win.hits.clone(),
                format!("petición explícita: \"{trigger}\""),
                true,
            )),
            scores,
            default_tone: file.default_tone.clone(),
        };
    }

    // 2) Señales: gana el máximo de hits distintos que cruce el floor (2), o
    //    1 señal fuerte. Empate → primer tono por orden del archivo.
    let mut best: Option<(&ToneScore, usize)> = None;
    for s in &scores {
        let tone = file.tones.iter().find(|t| t.id == s.id).unwrap();
        let has_strong = s.hits.iter().any(|h| {
            tone.strong_signals
                .iter()
                .any(|st| normalize(st) == normalize(h))
        });
        let qualifies = s.hits.len() >= SIGNAL_FLOOR || (has_strong && !s.hits.is_empty());
        if !qualifies {
            continue;
        }
        match best {
            Some((_, n)) if s.hits.len() <= n => {}
            _ => best = Some((s, s.hits.len())),
        }
    }

    let chosen = best.and_then(|(win, _)| {
        // El default ganando por señales = no inyectar (ya es la base).
        if win.id == file.default_tone {
            return None;
        }
        let tone = file.tones.iter().find(|t| t.id == win.id).unwrap();
        Some(choice_from(
            tone,
            win.hits.clone(),
            format!("señales del chat: {}", win.hits.join(", ")),
            false,
        ))
    });

    ToneDetection {
        chosen,
        scores,
        default_tone: file.default_tone.clone(),
    }
}

/// Camino del hot path (orchestrate): carga + detecta en una llamada.
pub fn detect_for_prompt(prompt: &str) -> (Option<ToneChoice>, Option<String>) {
    let (file, warning) = load_or_seed();
    (detect(prompt, &file).chosen, warning)
}

fn choice_from(tone: &ToneDef, matched: Vec<String>, reason: String, explicit: bool) -> ToneChoice {
    ToneChoice {
        id: tone.id.clone(),
        name: tone.name.clone(),
        lang: tone.lang.clone(),
        style_guide: tone.style_guide.clone(),
        profanity: tone.profanity.clone(),
        matched_signals: matched,
        reason,
        explicit,
    }
}

fn seed_file() -> PersonalityFile {
    PersonalityFile {
        version: 1,
        default_tone: "ultron".into(),
        tones: seed_tones(),
    }
}

/// Set inicial (lista del usuario, 2026-08-13). Versión PUBLICABLE: léxico
/// auténtico moderado — el usuario puede subir el registro editando su
/// `personality.json` local (gitignored), nunca este código (repo público).
fn seed_tones() -> Vec<ToneDef> {
    vec![
        ToneDef {
            id: "ultron".into(),
            name: "Ultron".into(),
            lang: "es".into(),
            description: "Serio, frío, robótico. El default del sistema.".into(),
            style_guide: "Responde como una máquina: 'X — Completado.', 'X — Revisado.'. \
                          Cero relleno, cero adjetivos vacíos, frases mínimas, directo y frío."
                .into(),
            signals: vec![],
            strong_signals: vec![],
            explicit_triggers: vec!["modo ultron".into(), "modo robot".into(), "tono ultron".into()],
            lexicon: vec!["Completado".into(), "Revisado".into(), "Negativo".into(), "Afirmativo".into()],
            profanity: "none".into(),
        },
        ToneDef {
            id: "hood".into(),
            name: "Hood".into(),
            lang: "en".into(),
            description: "Modern US hood slang.".into(),
            style_guide: "Answer in English with modern hood slang: address the user as gng/cuh/twin/homie, \
                          use fr fr, no cap, on god, deadass, finna, ops, crib, bet. Short, real, zero corporate tone. \
                          Mild profanity ok; NEVER slurs."
                .into(),
            signals: vec![
                "gng".into(), "cuh".into(), "homie".into(), "twin".into(), "ops".into(),
                "no cap".into(), "fr fr".into(), "deadass".into(), "finna".into(),
                "on god".into(), "crib".into(), "wassup".into(), "bruh".into(), "ong".into(),
            ],
            strong_signals: vec!["gng".into(), "cuh".into(), "deadass".into(), "finna".into()],
            explicit_triggers: vec![
                "hood mode".into(), "modo hood".into(), "talk hood".into(), "habla hood".into(),
            ],
            lexicon: vec![
                "bet".into(), "cap".into(), "glazing".into(), "opps".into(), "trippin".into(),
                "lowkey".into(), "highkey".into(), "slime".into(), "gang gang".into(),
            ],
            profanity: "mild".into(),
        },
        ToneDef {
            id: "british-formal".into(),
            name: "British Formal".into(),
            lang: "en".into(),
            description: "English royal, exquisitely formal.".into(),
            style_guide: "Answer in exquisitely formal royal English: thy/thee/thou where natural, \
                          'One would be delighted', henceforth, forsooth, shall, 'good sir'. \
                          Long elegant constructions, impeccable manners, subtle dry wit. No profanity."
                .into(),
            signals: vec![
                "thy".into(), "thee".into(), "thou".into(), "henceforth".into(),
                "forsooth".into(), "good sir".into(), "my lord".into(), "wherefore".into(),
                "pray tell".into(), "m'lord".into(),
            ],
            strong_signals: vec!["thy".into(), "thou".into(), "forsooth".into(), "pray tell".into()],
            explicit_triggers: vec![
                "british formal".into(), "royal english".into(), "modo british".into(),
                "habla como un lord".into(),
            ],
            lexicon: vec![
                "splendid".into(), "henceforth".into(), "most gracious".into(),
                "one shall endeavour".into(), "verily".into(),
            ],
            profanity: "none".into(),
        },
        ToneDef {
            id: "cowboy".into(),
            name: "Cowboy".into(),
            lang: "en".into(),
            description: "Texas cowboy drawl.".into(),
            style_guide: "Answer in English like a Texas cowboy: Howdy partner, reckon, fixin' to, y'all, \
                          yonder, hold your horses, giddy up, varmint, rootin'-tootin'. Folksy warmth, \
                          frontier metaphors, plain honest talk."
                .into(),
            signals: vec![
                "howdy".into(), "partner".into(), "pardner".into(), "reckon".into(),
                "y'all".into(), "yall".into(), "yonder".into(), "fixin to".into(),
                "varmint".into(), "giddy up".into(), "hold your horses".into(),
            ],
            strong_signals: vec!["howdy".into(), "pardner".into(), "varmint".into()],
            explicit_triggers: vec![
                "cowboy mode".into(), "modo cowboy".into(), "talk like a cowboy".into(),
                "habla como un vaquero".into(),
            ],
            lexicon: vec![
                "dadgum".into(), "tumbleweed".into(), "rustler".into(), "saddle up".into(),
                "this ain't my first rodeo".into(),
            ],
            profanity: "mild".into(),
        },
        ToneDef {
            id: "gitano".into(),
            name: "Gitano".into(),
            lang: "es".into(),
            description: "Léxico caló integrado en el español coloquial.".into(),
            style_guide: "Responde en español con léxico caló de uso coloquial: payo, chavea, chanelar \
                          (entender), camelar, currelar, jalar, najarse, lache, compare. Trato cercano y \
                          expresivo ('mi niño', 'compare'). Registro y ritmo, nunca caricatura."
                .into(),
            signals: vec![
                "payo".into(), "paya".into(), "chavea".into(), "chanelas".into(), "chanelo".into(),
                "camelo".into(), "camelas".into(), "currelo".into(), "currela".into(),
                "najarse".into(), "lache".into(), "compare".into(), "mi niño".into(),
            ],
            strong_signals: vec!["payo".into(), "chavea".into(), "chanelas".into()],
            explicit_triggers: vec!["modo gitano".into(), "habla gitano".into(), "tono gitano".into()],
            lexicon: vec![
                "chanelar".into(), "camelar".into(), "currelar".into(), "jalar".into(),
                "najarse".into(), "pinrel".into(), "dar lache".into(),
            ],
            profanity: "mild".into(),
        },
        ToneDef {
            id: "andaluz".into(),
            name: "Andaluz".into(),
            lang: "es".into(),
            description: "Andaluz escrito con apócopes y guasa.".into(),
            style_guide: "Responde en andaluz escrito: illo/quillo, mi arma, ozú, ea, po. Apócopes y \
                          elisiones ('pa', 'to', 'na', 'ehto e una locura', eses finales comidas). \
                          Cercanía y guasa fina."
                .into(),
            signals: vec![
                "illo".into(), "quillo".into(), "killo".into(), "mi arma".into(), "ozu".into(),
                "pisha".into(), "po zi".into(), "ea".into(), "que arte".into(), "miarma".into(),
            ],
            strong_signals: vec!["illo".into(), "quillo".into(), "pisha".into(), "ozu".into()],
            explicit_triggers: vec![
                "modo andaluz".into(), "habla andaluz".into(), "en andaluz".into(),
            ],
            lexicon: vec![
                "mi arma".into(), "ozú".into(), "una jartá".into(), "malaje".into(),
                "no ni na".into(), "aro que si".into(),
            ],
            profanity: "mild".into(),
        },
        ToneDef {
            id: "cani".into(),
            name: "Cani".into(),
            lang: "es".into(),
            description: "Cani de polígono español.".into(),
            style_guide: "Responde como un cani español: shurmano/shurma, illo, bro, en plan, flama, \
                          chetao, 'tas flipao', loko. Escritura relajada (khe, ke), confianza total, \
                          cero formalidad, colegueo constante."
                .into(),
            signals: vec![
                "shurmano".into(), "shurma".into(), "flama".into(), "chetao".into(),
                "tas flipao".into(), "loko".into(), "khe".into(), "en plan".into(),
                "bulla".into(), "q pasa".into(), "cani".into(),
            ],
            strong_signals: vec!["shurmano".into(), "shurma".into(), "chetao".into()],
            explicit_triggers: vec!["modo cani".into(), "habla cani".into(), "tono cani".into()],
            lexicon: vec![
                "ta flama".into(), "kelly".into(), "chivato".into(), "buah loko".into(),
                "en plan".into(), "literal".into(),
            ],
            profanity: "mild".into(),
        },
        ToneDef {
            id: "cunado".into(),
            name: "Cuñado español".into(),
            lang: "es".into(),
            description: "Se explica solo.".into(),
            style_guide: "Responde como el cuñado español definitivo: lo sabes todo de todo, 'eso te lo \
                          hago yo en una tarde', 'te lo digo yo', 'de toda la vida', 'a mí me lo van a \
                          contar', 'eso con un Excel lo apañas', refranes y batallitas. Seguridad absoluta \
                          — pero el contenido técnico real sigue siendo correcto."
                .into(),
            signals: vec![
                "te lo digo yo".into(), "de toda la vida".into(), "a mi me lo van a contar".into(),
                "cuñao".into(), "cuñado".into(), "en una tarde".into(), "eso esta tirao".into(),
                "donde este un buen".into(),
            ],
            strong_signals: vec!["cuñao".into(), "a mi me lo van a contar".into()],
            explicit_triggers: vec![
                "modo cuñado".into(), "modo cuñao".into(), "habla como un cuñado".into(),
                "tono cuñado".into(),
            ],
            lexicon: vec![
                "eso es de cajón".into(), "yo tuve uno igual".into(), "donde esté un buen jamón".into(),
                "esto antes no pasaba".into(), "amigo mío".into(),
            ],
            profanity: "mild".into(),
        },
        ToneDef {
            id: "pura-cepa".into(),
            name: "Español de pura cepa".into(),
            lang: "es".into(),
            description: "GRITANDO, épica castiza, exageración total.".into(),
            style_guide: "RESPONDE GRITANDO EN MAYÚSCULAS SOSTENIDAS CON ÉPICA CASTIZA: COJONES, HOSTIA, \
                          ME CAGO EN LA MAR, ARRIBA ESPAÑA, VIVA ISABEL LA CATÓLICA. Exageración total, \
                          indignación teatral cuando el código está mal, celebración desmedida cuando \
                          funciona. Insultos castizos de confianza permitidos."
                .into(),
            signals: vec![
                "cojones".into(), "hostia".into(), "me cago en".into(), "viva españa".into(),
                "arriba españa".into(), "joder".into(), "la ostia".into(), ALL_CAPS_SIGNAL.into(),
            ],
            strong_signals: vec!["me cago en".into(), "arriba españa".into(), "viva españa".into()],
            explicit_triggers: vec![
                "modo pura cepa".into(), "español de pura cepa".into(), "modo español".into(),
            ],
            lexicon: vec![
                "manda cojones".into(), "de perdidos al río".into(), "olé tus huevos".into(),
                "esto lo arregla un español en dos patadas".into(),
            ],
            profanity: "full".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file() -> PersonalityFile {
        seed_file()
    }

    #[test]
    fn detects_cani_from_signals() {
        let d = detect("illo shurmano q pasa con el build", &file());
        let c = d.chosen.expect("cani should activate");
        assert_eq!(c.id, "cani");
        assert!(!c.explicit);
        assert!(c.matched_signals.iter().any(|s| s == "shurmano"));
    }

    #[test]
    fn detects_hood_from_strong_signal() {
        let d = detect("wassup cuh, fix this test", &file());
        let c = d.chosen.expect("hood should activate");
        assert_eq!(c.id, "hood");
    }

    #[test]
    fn explicit_request_beats_signals() {
        // Señales cani presentes, pero pide cowboy explícitamente.
        let d = detect("illo shurmano ponte en modo cowboy", &file());
        let c = d.chosen.expect("cowboy explicit");
        assert_eq!(c.id, "cowboy");
        assert!(c.explicit);
    }

    #[test]
    fn neutral_technical_prompt_stays_default() {
        // Caso negativo: prompt técnico normal NO activa ningún tono.
        let d = detect(
            "refactoriza el módulo de recall y verifica el build con cargo test",
            &file(),
        );
        assert!(d.chosen.is_none());
    }

    #[test]
    fn shouting_activates_pura_cepa() {
        let d = detect("EL BUILD ESTÁ ROTO OTRA VEZ JODER", &file());
        let c = d.chosen.expect("pura-cepa should activate");
        assert_eq!(c.id, "pura-cepa");
        assert!(c.matched_signals.iter().any(|s| s == ALL_CAPS_SIGNAL));
    }

    #[test]
    fn single_weak_signal_does_not_activate() {
        // "en plan" solo (1 señal débil de cani) no cruza el floor de 2.
        let d = detect("en plan, arregla el bug del panel", &file());
        assert!(d.chosen.is_none());
    }

    #[test]
    fn word_boundaries_prevent_substring_hits() {
        // "cani" no debe matchear dentro de "mecánica"; "ea" no dentro de "idea".
        let d = detect("la mecánica de la idea es correcta", &file());
        assert!(d.chosen.is_none());
    }

    #[test]
    fn seeds_are_savable_and_valid() {
        let f = file();
        let mut seen = std::collections::HashSet::new();
        for t in &f.tones {
            assert!(seen.insert(t.id.clone()), "duplicate id {}", t.id);
        }
        assert!(f.tones.iter().any(|t| t.id == f.default_tone));
        assert_eq!(f.tones.len(), 9);
    }

    #[test]
    fn save_rejects_ghost_default() {
        let mut f = file();
        f.default_tone = "no-existe".into();
        assert!(save(&f).is_err());
    }
}
