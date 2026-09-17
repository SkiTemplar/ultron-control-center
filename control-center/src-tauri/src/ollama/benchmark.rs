// ULTRON Control Center — Ollama: construccion de la peticion de medicion
// de latencia y calculo de mediana/maximo.
//
// Mismo formato que usa la extension de VS Code
// (`plugins/vscode-ollama-tab/src/logic.ts`): `raw: true` + marcadores
// FIM, `num_predict: 48`, `temperature: 0`, `stop: ["\n"]` — SIN
// `keep_alive` (medir no debe tocar el ciclo de vida del modelo; el
// comando `ollama_benchmark` exige que ya este cargado, ver `commands.rs`).

use serde_json::{json, Value};

const FIM_PREFIX: &str = "<|fim_prefix|>";
const FIM_SUFFIX: &str = "<|fim_suffix|>";
const FIM_MIDDLE: &str = "<|fim_middle|>";

/// Fragmento de codigo representativo usado como contexto de la medicion:
/// una funcion a medio escribir, con el cursor tras `return `. No se
/// muestra al usuario — solo sirve para que el modelo tenga algo
/// razonable que completar.
const SAMPLE_PREFIX: &str = "function add(a, b) {\n  return ";
const SAMPLE_SUFFIX: &str = "\n}\n";

/// Numero de peticiones que hace `ollama_benchmark` por medicion.
pub const SAMPLE_COUNT: usize = 5;

/// Construye el prompt crudo FIM (`fill-in-the-middle`) que espera Ollama
/// con `raw: true`.
pub fn fim_prompt(prefix: &str, suffix: &str) -> String {
    format!("{FIM_PREFIX}{prefix}{FIM_SUFFIX}{suffix}{FIM_MIDDLE}")
}

/// Cuerpo de `POST /api/generate` para una muestra de la medicion.
pub fn benchmark_request_body(model: &str) -> Value {
    json!({
        "model": model,
        "prompt": fim_prompt(SAMPLE_PREFIX, SAMPLE_SUFFIX),
        "raw": true,
        "stream": false,
        "options": {
            "num_predict": 48,
            "temperature": 0,
            "stop": ["\n"],
        }
    })
}

/// Mediana en ms de una serie de muestras. No muta `samples` (ordena una
/// copia local). `0` si `samples` esta vacio.
pub fn median_ms(samples: &[u64]) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2
    } else {
        sorted[mid]
    }
}

/// Maximo en ms de una serie de muestras. `0` si `samples` esta vacio.
pub fn max_ms(samples: &[u64]) -> u64 {
    samples.iter().copied().max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fim_prompt_intercala_los_marcadores() {
        let prompt = fim_prompt("a", "b");
        assert_eq!(prompt, "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>");
    }

    #[test]
    fn benchmark_request_body_no_lleva_keep_alive() {
        let body = benchmark_request_body("qwen2.5-coder:1.5b-base");
        assert_eq!(body["model"], "qwen2.5-coder:1.5b-base");
        assert_eq!(body["raw"], true);
        assert_eq!(body["stream"], false);
        assert_eq!(body["options"]["num_predict"], 48);
        assert_eq!(body["options"]["temperature"], 0);
        assert_eq!(body["options"]["stop"][0], "\n");
        assert!(body.get("keep_alive").is_none());
    }

    #[test]
    fn median_ms_con_numero_impar_de_muestras() {
        assert_eq!(median_ms(&[300, 100, 200]), 200);
    }

    #[test]
    fn median_ms_con_numero_par_de_muestras_promedia_el_centro() {
        assert_eq!(median_ms(&[100, 200, 300, 400]), 250);
    }

    #[test]
    fn median_ms_no_muta_la_entrada() {
        let samples = [300u64, 100, 200];
        let _ = median_ms(&samples);
        assert_eq!(samples, [300, 100, 200]);
    }

    #[test]
    fn median_ms_devuelve_cero_con_lista_vacia() {
        assert_eq!(median_ms(&[]), 0);
    }

    #[test]
    fn max_ms_encuentra_el_mayor() {
        assert_eq!(max_ms(&[300, 100, 900, 200]), 900);
    }

    #[test]
    fn max_ms_devuelve_cero_con_lista_vacia() {
        assert_eq!(max_ms(&[]), 0);
    }
}
