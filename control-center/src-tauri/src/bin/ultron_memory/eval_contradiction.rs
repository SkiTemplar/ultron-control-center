//! Eval 1.3b — accuracy del juez 3-way `classify_contradiction` sobre un golden
//! set etiquetado a mano (cockpit/memory-rework/evals/contradiction_golden.json).
//!
//! Es el GATE para encender `auto_supersede`: un StateUpdate FALSO (el juez ve
//! update donde no lo hay) deprecaría memoria válida, así que el gate exige
//! `false_state_updates == 0` además de accuracy sobre lo decidido.
//!
//! Corre contra el AI Router real (zona utility) — es un eval de RUNTIME, no un
//! test hermético: mide el modelo que el write-path usa de verdad.

use control_center_lib as ul;
use serde::Deserialize;
use ul::memory::ai_tasks::{classify_contradiction, ContradictionClass};

#[derive(Debug, Deserialize)]
struct GoldenFile {
    cases: Vec<GoldenCase>,
}

#[derive(Debug, Deserialize)]
struct GoldenCase {
    expect: String,
    new: String,
    existing: String,
}

fn class_label(c: ContradictionClass) -> &'static str {
    match c {
        ContradictionClass::NoConflict => "none",
        ContradictionClass::StateUpdate => "state_update",
        ContradictionClass::RealConflict => "conflict",
    }
}

/// Umbral del gate sobre los casos DECIDIDOS (el juez emitió etiqueta).
const GATE_MIN_ACCURACY: f32 = 0.85;

pub(crate) fn run(path: &str) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("leer {path}: {e}"))?;
    let golden: GoldenFile =
        serde_json::from_str(&text).map_err(|e| format!("parsear golden: {e}"))?;
    if golden.cases.is_empty() {
        return Err("golden set vacío".to_string());
    }

    let total = golden.cases.len();
    let mut decided = 0usize;
    let mut correct = 0usize;
    let mut false_state_updates = 0usize;
    let mut confusion: std::collections::BTreeMap<String, usize> = Default::default();
    let mut failures: Vec<serde_json::Value> = Vec::new();

    for case in &golden.cases {
        let got = classify_contradiction(&case.new, &case.existing);
        let got_label = got.map(class_label).unwrap_or("undecided");
        *confusion
            .entry(format!("{}->{}", case.expect, got_label))
            .or_default() += 1;

        if got.is_some() {
            decided += 1;
            if got_label == case.expect {
                correct += 1;
            } else {
                if got_label == "state_update" {
                    // El KPI del gate: esto habría deprecado memoria válida.
                    false_state_updates += 1;
                }
                failures.push(serde_json::json!({
                    "expect": case.expect,
                    "got": got_label,
                    "new": case.new.chars().take(70).collect::<String>(),
                }));
            }
        }
    }

    let accuracy_decided = if decided > 0 {
        correct as f32 / decided as f32
    } else {
        0.0
    };
    // Estricta: un None (router caído / indecidible) cuenta como fallo — mide la
    // utilidad real end-to-end, no solo la calidad del modelo cuando responde.
    let accuracy_strict = correct as f32 / total as f32;
    let gate_pass =
        decided == total && accuracy_decided >= GATE_MIN_ACCURACY && false_state_updates == 0;

    Ok(serde_json::json!({
        "total": total,
        "decided": decided,
        "correct": correct,
        "accuracy_decided": accuracy_decided,
        "accuracy_strict": accuracy_strict,
        "false_state_updates": false_state_updates,
        "gate": { "min_accuracy": GATE_MIN_ACCURACY, "pass": gate_pass },
        "confusion": confusion,
        "failures": failures,
    }))
}
