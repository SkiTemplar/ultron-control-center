// mar.ia — catalogo de modelos y esfuerzo por proveedor.
//
// El usuario pidio (2026-09-18) saber SIEMPRE con que modelo le estan
// contestando —"si es una pregunta tonta, que tire con haiku, pero si es una
// gran cosa, que tire de opus"— y con cuanto esfuerzo, poder cambiarlo a mano
// y que, por defecto, lo decida el modelo local.
//
// Aqui vive lo que se puede elegir y COMO se le dice a cada CLI. Es un modulo
// aparte y casi todo puro porque es la parte que mas va a cambiar: los
// catalogos de modelos se mueven cada pocos meses.
//
// LIMITE DECLARADO (mandamiento 13): el esfuerzo NO se controla igual en
// todas partes.
//   * codex  — bandera real (`-c model_reasoning_effort=...`).
//   * claude — no hay bandera; se pide en el propio prompt, que es como
//              Claude Code decide cuanto piensa. Es una peticion, no una
//              garantia.
//   * gemini — no hay control de esfuerzo: se elige modelo y punto.
//   * local  — se traduce a `think` (razonar si/no) en la llamada a Ollama.
// La interfaz enseña exactamente esto, sin fingir un control que no existe.

use serde::{Deserialize, Serialize};

/// Nivel de esfuerzo pedido.
pub const ESFUERZOS: &[&str] = &["bajo", "medio", "alto"];

/// Como se le comunica el esfuerzo a un proveedor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ModoEsfuerzo {
    /// Bandera de la CLI (control real).
    Bandera,
    /// Se pide dentro del prompt (Claude Code decide cuanto piensa).
    EnElPrompt,
    /// Se traduce a razonar si/no (Ollama `think`).
    Razonamiento,
    /// El proveedor no lo expone.
    SinControl,
}

/// Un modelo elegible.
#[derive(Debug, Clone, Serialize)]
pub struct ModeloInfo {
    /// Lo que se le pasa a la CLI.
    pub id: String,
    /// Como se enseña en la interfaz.
    pub label: String,
    /// Para que sirve, en una linea. Es lo que lee el modelo local al elegir.
    pub para: String,
}

/// Catalogo de un proveedor.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogoProveedor {
    pub provider: String,
    pub models: Vec<ModeloInfo>,
    /// El que se usa si nadie elige.
    pub default_model: String,
    pub effort_mode: ModoEsfuerzo,
    /// Por que la lista es la que es. Se ensena junto al selector.
    ///
    /// Existe porque una lista corta parece un error y no lo es: el usuario
    /// reporto el 2026-09-21 "de codex solo sale el terra" pensando que
    /// faltaban modelos. Faltan, pero porque su cuenta no los admite, y eso
    /// hay que decirlo donde se ve la lista.
    #[serde(default)]
    pub nota: String,
}

/// Eleccion completa para un turno.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Eleccion {
    pub provider: String,
    /// Vacio = el que traiga la CLI por defecto.
    #[serde(default)]
    pub model: String,
    /// "bajo" | "medio" | "alto". Vacio = medio.
    #[serde(default)]
    pub effort: String,
}

fn m(id: &str, label: &str, para: &str) -> ModeloInfo {
    ModeloInfo {
        id: id.into(),
        label: label.into(),
        para: para.into(),
    }
}

/// Todo lo elegible, por proveedor.
///
/// Los identificadores son los ALIAS de cada CLI (`opus`, `gpt-5`,
/// `gemini-2.5-pro`), no versiones clavadas: un alias sigue funcionando
/// cuando sale la version siguiente, y un id con fecha deja de existir.
#[must_use]
pub fn catalogo() -> Vec<CatalogoProveedor> {
    vec![
        CatalogoProveedor {
            provider: "claude".into(),
            models: vec![
                m("haiku", "haiku", "preguntas cortas, resumenes, cosas triviales"),
                m("sonnet", "sonnet", "trabajo normal de codigo y texto"),
                m("opus", "opus", "arquitectura, problemas dificiles, textos largos"),
            ],
            default_model: "sonnet".into(),
            effort_mode: ModoEsfuerzo::EnElPrompt,
            nota: String::new(),
        },
        CatalogoProveedor {
            provider: "codex".into(),
            // OJO con clavar un modelo aqui: con una cuenta de ChatGPT (la
            // suscripcion, no la API) el servidor RECHAZA los ids que no
            // toquen. Medido el 2026-09-20:
            //
            //   -m gpt-5-codex -> 400 "not supported when using Codex with a
            //                     ChatGPT account"
            //   -m gpt-5       -> 400, lo mismo
            //   sin -m         -> contesta
            //
            // Eso es lo que tenia el relevo dando error en Codex. Por eso el
            // modelo por defecto es VACIO: sin `-m`, la CLI usa el que tenga
            // vigente y esto no vuelve a caducar solo.
            models: vec![m(
                "gpt-5.6-terra",
                "gpt-5.6 terra",
                "el que trae la CLI hoy; si algun dia da error 400, deja el automatico",
            )],
            default_model: String::new(),
            effort_mode: ModoEsfuerzo::Bandera,
            nota: "Con una cuenta de ChatGPT (suscripción) la CLI solo acepta su modelo \
                   vigente: probados el 2026-09-21, `gpt-5`, `gpt-5.6` y `codex-mini-latest` \
                   devuelven error 400. No falta nada: es el límite de la cuenta."
                .into(),
        },
        CatalogoProveedor {
            // Antigravity (`agy`) sustituye a Gemini desde el 2026-09-20:
            // misma familia de modelos de Google, pero por la suscripcion que
            // el usuario tiene viva.
            provider: "antigravity".into(),
            models: vec![
                m(
                    "gemini-3.8-flash-medium",
                    "Gemini 3.8 Flash",
                    "rapido y barato: busquedas, resumenes",
                ),
                m(
                    "gemini-3.1-pro-high",
                    "Gemini 3.1 Pro",
                    "documentos largos y analisis, mas lento",
                ),
            ],
            // Vacio = el que traiga la CLI. Mismo motivo que en Codex.
            default_model: String::new(),
            // El nivel de esfuerzo va DENTRO del id del modelo
            // (`-low` / `-medium` / `-high`), asi que no se manda bandera
            // aparte: se elige eligiendo modelo.
            effort_mode: ModoEsfuerzo::SinControl,
            // `agy models` lista tambien Claude Opus 4.6 y Sonnet 4.6. Se
            // dejan FUERA a proposito: verlos aqui confunde (el usuario los
            // señalo el 2026-09-21 al abrir la lista de Antigravity) y
            // duplicarian al proveedor `claude`, que ya va el primero de la
            // cadena. Para Claude, se usa Claude.
            nota: "Solo los modelos de Google. Antigravity también sirve Claude, pero para eso \
                   está el proveedor claude: tenerlo dos veces solo gasta la misma cuota por \
                   dos caminos."
                .into(),
        },
        CatalogoProveedor {
            provider: "local".into(),
            // El modelo local es el que haya instalado: se resuelve en
            // caliente con `modelo_local()`, no se clava aqui.
            models: Vec::new(),
            default_model: String::new(),
            effort_mode: ModoEsfuerzo::Razonamiento,
            nota: String::new(),
        },
    ]
}

/// Catalogo con el modelo local real relleno.
#[must_use]
pub fn catalogo_vivo() -> Vec<CatalogoProveedor> {
    let local = crate::ollama::toggle::model_name();
    catalogo()
        .into_iter()
        .map(|mut c| {
            if c.provider == "local" && !local.is_empty() {
                c.models = vec![m(&local, &local, "gratis y sin cuota; el mas flojo")];
                c.default_model = local.clone();
            }
            c
        })
        .collect()
}

/// ¿Ese modelo existe para ese proveedor?
///
/// Se valida porque el identificador acaba en la linea de comandos de una CLI:
/// aceptar lo que venga seria dejar que la interfaz (o un modelo alucinando)
/// meta lo que quiera ahi.
#[must_use]
pub fn modelo_valido(provider: &str, model: &str) -> bool {
    if model.is_empty() {
        return true; // vacio = el de por defecto de la CLI
    }
    catalogo_vivo()
        .iter()
        .find(|c| c.provider == provider)
        .is_some_and(|c| c.models.iter().any(|mm| mm.id == model))
}

/// Normaliza el esfuerzo. Cualquier cosa rara cae a "medio": es el punto
/// medio, no el mas caro.
#[must_use]
pub fn normaliza_esfuerzo(raw: &str) -> String {
    let limpio = raw.trim().to_lowercase();
    match limpio.as_str() {
        "bajo" | "low" | "minimo" | "minimal" => "bajo".into(),
        "alto" | "high" | "max" | "maximo" => "alto".into(),
        _ => "medio".into(),
    }
}

/// Modo de esfuerzo de un proveedor.
#[must_use]
pub fn modo_esfuerzo(provider: &str) -> ModoEsfuerzo {
    catalogo()
        .iter()
        .find(|c| c.provider == provider)
        .map_or(ModoEsfuerzo::SinControl, |c| c.effort_mode)
}

/// Modelo por defecto de un proveedor.
#[must_use]
pub fn modelo_por_defecto(provider: &str) -> String {
    catalogo_vivo()
        .iter()
        .find(|c| c.provider == provider)
        .map(|c| c.default_model.clone())
        .unwrap_or_default()
}

/// Argumentos extra de la CLI para modelo y esfuerzo.
///
/// Pura: se testea sin lanzar nada. Devuelve solo lo que ese proveedor
/// entiende de verdad — nada de banderas inventadas que la CLI rechazaria.
#[must_use]
pub fn argumentos(provider: &str, model: &str, effort: &str) -> Vec<String> {
    let mut args = Vec::new();
    match provider {
        "claude" => {
            if !model.is_empty() {
                args.push("--model".into());
                args.push(model.to_string());
            }
        }
        "codex" => {
            if !model.is_empty() {
                args.push("-m".into());
                args.push(model.to_string());
            }
            let nivel = match normaliza_esfuerzo(effort).as_str() {
                "bajo" => "low",
                "alto" => "high",
                _ => "medium",
            };
            args.push("-c".into());
            args.push(format!("model_reasoning_effort=\"{nivel}\""));
        }
        "antigravity" => {
            if !model.is_empty() {
                args.push("--model".into());
                args.push(model.to_string());
            }
        }
        _ => {}
    }
    args
}

/// Argumentos para una sesion INTERACTIVA (la terminal embebida).
///
/// Solo el modelo: el esfuerzo en una sesion interactiva lo gobierna el propio
/// usuario desde dentro de la CLI, y clavarlo al abrirla le quitaria el mando.
#[must_use]
pub fn argumentos_interactivos(provider: &str, model: &str) -> Vec<String> {
    if model.is_empty() {
        return Vec::new();
    }
    match provider {
        "claude" => vec!["--model".into(), model.to_string()],
        "codex" => vec!["-m".into(), model.to_string()],
        "antigravity" => vec!["--model".into(), model.to_string()],
        _ => Vec::new(),
    }
}

/// Prefijo que se antepone al prompt para pedir mas o menos reflexion.
///
/// Solo tiene sentido en Claude: su CLI no expone una bandera de esfuerzo, y
/// la forma documentada de subir el presupuesto de razonamiento es pedirlo en
/// el propio mensaje. Devuelve vacio para el resto.
#[must_use]
pub fn prefijo_esfuerzo(provider: &str, effort: &str) -> String {
    if modo_esfuerzo(provider) != ModoEsfuerzo::EnElPrompt {
        return String::new();
    }
    match normaliza_esfuerzo(effort).as_str() {
        "bajo" => "Responde directo y breve, sin desarrollar el razonamiento.\n\n".into(),
        "alto" => "think hard: analiza el problema a fondo antes de responder.\n\n".into(),
        _ => String::new(),
    }
}

/// ¿Debe el modelo local razonar en este turno?
#[must_use]
pub fn razonar_en_local(effort: &str) -> bool {
    normaliza_esfuerzo(effort) == "alto"
}

/// Lo que la interfaz necesita para pintar los selectores.
#[derive(Debug, Clone, Serialize)]
pub struct Catalogo {
    pub providers: Vec<CatalogoProveedor>,
    /// Niveles de esfuerzo, en orden. Viajan desde aqui para que la interfaz
    /// no tenga su propia lista que se desincronice de la de Rust.
    pub efforts: Vec<String>,
}

#[tauri::command]
pub async fn maria_models_catalog() -> Result<Catalogo, String> {
    Ok(Catalogo {
        providers: catalogo_vivo(),
        efforts: ESFUERZOS.iter().map(|e| (*e).to_string()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_catalogo_cubre_los_cuatro_proveedores() {
        let ids: Vec<String> = catalogo().into_iter().map(|c| c.provider).collect();
        assert_eq!(ids, vec!["claude", "codex", "antigravity", "local"]);
    }

    #[test]
    fn ni_codex_ni_antigravity_clavan_un_modelo_por_defecto() {
        // Un id de modelo clavado CADUCA y entonces el proveedor entero deja de
        // responder. Paso el 2026-09-20: `-m gpt-5-codex` empezo a devolver
        // 400 ("not supported when using Codex with a ChatGPT account") y el
        // relevo daba error en Codex para cualquier pregunta.
        //
        // Con el modelo por defecto vacio no se manda `-m` y la CLI usa el
        // suyo, que siempre es uno vigente.
        for p in ["codex", "antigravity"] {
            let c = catalogo()
                .into_iter()
                .find(|c| c.provider == p)
                .unwrap_or_else(|| panic!("falta {p} en el catalogo"));
            assert!(
                c.default_model.is_empty(),
                "{p} clava el modelo {:?}: volvera a caducar",
                c.default_model
            );
        }
    }

    #[test]
    fn antigravity_no_ofrece_modelos_de_anthropic() {
        // El usuario lo señalo el 2026-09-21: "la de agy abro los modelos y
        // sale opus 4.6 entre ellos". `agy models` los sirve de verdad, pero
        // enseñarlos ahi confunde y duplica al proveedor `claude`, que ya va
        // el primero de la cadena: la misma cuota por dos caminos.
        let agy = catalogo()
            .into_iter()
            .find(|c| c.provider == "antigravity")
            .expect("falta antigravity");
        for m in &agy.models {
            let id = m.id.to_lowercase();
            assert!(!id.contains("claude"), "modelo de Anthropic en agy: {}", m.id);
            assert!(!id.contains("opus"), "modelo de Anthropic en agy: {}", m.id);
            assert!(!id.contains("sonnet"), "modelo de Anthropic en agy: {}", m.id);
        }
        assert!(!agy.models.is_empty(), "sin modelos no hay nada que elegir");
    }

    #[test]
    fn una_lista_corta_se_explica() {
        // Caso negativo del mandamiento 11 aplicado a la interfaz: si un
        // proveedor ofrece un solo modelo, tiene que decir POR QUE. Sin nota,
        // el usuario lo lee como que falta algo (y eso fue exactamente lo que
        // paso con codex).
        for c in catalogo() {
            if c.models.len() == 1 {
                assert!(
                    !c.nota.trim().is_empty(),
                    "{} ofrece un solo modelo y no explica por que",
                    c.provider
                );
            }
        }
    }

    #[test]
    fn claude_ofrece_haiku_sonnet_y_opus() {
        let c = catalogo();
        let claude = c.iter().find(|c| c.provider == "claude").expect("falta claude");
        let ids: Vec<&str> = claude.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["haiku", "sonnet", "opus"]);
    }

    #[test]
    fn el_esfuerzo_se_normaliza_a_tres_niveles() {
        assert_eq!(normaliza_esfuerzo("low"), "bajo");
        assert_eq!(normaliza_esfuerzo("  ALTO "), "alto");
        assert_eq!(normaliza_esfuerzo("high"), "alto");
        assert_eq!(normaliza_esfuerzo("medio"), "medio");
    }

    #[test]
    fn un_esfuerzo_inventado_no_sube_el_gasto() {
        // Caso negativo: si "turbo" cayera en "alto", una palabra suelta del
        // modelo local encareceria todas las respuestas.
        for raw in ["turbo", "", "999", "ultra"] {
            assert_eq!(normaliza_esfuerzo(raw), "medio", "fallo con {raw:?}");
        }
    }

    #[test]
    fn cada_cli_recibe_solo_lo_que_entiende() {
        assert_eq!(argumentos("claude", "opus", "alto"), vec!["--model", "opus"]);
        assert_eq!(
            argumentos("codex", "gpt-5.6-terra", "alto"),
            vec!["-m", "gpt-5.6-terra", "-c", "model_reasoning_effort=\"high\""]
        );
        assert_eq!(
            argumentos("antigravity", "gemini-3.1-pro-high", "alto"),
            vec!["--model", "gemini-3.1-pro-high"]
        );
        // El local no va por CLI.
        assert!(argumentos("local", "qwen3.5:9b", "alto").is_empty());
    }

    #[test]
    fn sin_modelo_no_se_emite_la_bandera() {
        // Caso negativo: `--model ""` hace que la CLI falle en vez de usar su
        // modelo por defecto.
        assert!(argumentos("claude", "", "medio").is_empty());
        assert_eq!(
            argumentos("codex", "", "medio"),
            vec!["-c", "model_reasoning_effort=\"medium\""]
        );
    }

    #[test]
    fn el_esfuerzo_en_el_prompt_es_solo_de_claude() {
        assert!(prefijo_esfuerzo("claude", "alto").contains("think hard"));
        assert!(prefijo_esfuerzo("claude", "bajo").contains("directo"));
        assert_eq!(prefijo_esfuerzo("claude", "medio"), "");
        // Caso negativo: meter esta frase en Codex o Gemini seria ensuciar el
        // prompt con una instruccion que ahi no hace nada.
        for p in ["codex", "gemini", "local"] {
            assert_eq!(prefijo_esfuerzo(p, "alto"), "", "{p} no deberia llevar prefijo");
        }
    }

    #[test]
    fn la_terminal_solo_recibe_el_modelo() {
        assert_eq!(
            argumentos_interactivos("claude", "opus"),
            vec!["--model", "opus"]
        );
        assert_eq!(argumentos_interactivos("codex", "gpt-5"), vec!["-m", "gpt-5"]);
        // Caso negativo: sin modelo no se emite bandera, y powershell no
        // entiende ninguna.
        assert!(argumentos_interactivos("claude", "").is_empty());
        assert!(argumentos_interactivos("powershell", "opus").is_empty());
    }

    #[test]
    fn el_local_solo_razona_con_esfuerzo_alto() {
        assert!(razonar_en_local("alto"));
        assert!(!razonar_en_local("medio"));
        assert!(!razonar_en_local("bajo"));
    }

    #[test]
    fn rechaza_modelos_que_no_estan_en_el_catalogo() {
        // Caso negativo: el id acaba en una linea de comandos.
        assert!(!modelo_valido("claude", "opus-4-turbo-ultra"));
        assert!(!modelo_valido("gemini", "opus"));
        assert!(modelo_valido("claude", "opus"));
        assert!(modelo_valido("claude", ""), "vacio = el de la CLI");
    }
}
