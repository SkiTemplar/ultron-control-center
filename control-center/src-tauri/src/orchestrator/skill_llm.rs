//! skill_llm.rs — elección de skill por LLM sobre el catálogo completo.
//!
//! El fallback semántico de `routing-dispatcher.v3` recupera skills por coseno
//! E5 sobre su descripción. Medido el 2026-08-27 sobre 10 prompts reales:
//! top-1 acierta 4/10 y los scores de TODO el corpus caben en 0.79–0.84, así
//! que ningún umbral separa un acierto de un candidato al azar. La causa es el
//! corpus, no el índice: las descripciones de skill son listas largas y
//! heterogéneas de triggers ("Activar SIEMPRE cuando el usuario diga…"), y su
//! vector medio se parece a cualquier prompt en español.
//!
//! Este módulo salta el retriever: le da al modelo el catálogo entero (nombre +
//! una línea) y le pide que elija. Es el mismo rescate que `intent_llm` aplicó
//! al intent, con la misma doctrina:
//!   - solo se consulta en la cola ambigua (lo decide el llamante);
//!   - timeout duro y fallo silencioso: devuelve vacío, nunca un error;
//!   - un proveedor caído activa un cooldown, para no pagar el timeout entero
//!     en cada prompt mientras dure la caída;
//!   - la respuesta se valida contra el catálogo: nunca llega al pipeline un
//!     nombre que el modelo se haya inventado.

use once_cell::sync::OnceCell;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Techo de espera por defecto. Mayor que el de `intent_llm` (800 ms) porque
/// aquí el prompt lleva el catálogo entero (~2.5k tokens) en vez de una frase
/// y el flash de Google mide p50 ~1.2 s. Sigue dentro del presupuesto del hook
/// (4500 ms compartidos) con el denso ya pagado.
const TIMEOUT_MS: u64 = 2500;

/// Techo ajustable por entorno: el presupuesto real depende del proveedor
/// elegido (Groq responde en ~400 ms, un flash de Google va más lento) y
/// medir cuál compensa exige moverlo sin recompilar.
fn timeout() -> Duration {
    let ms = std::env::var("ULTRON_SKILL_LLM_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(TIMEOUT_MS);
    Duration::from_millis(ms)
}

/// Tras un fallo (rate limit, red, 5xx) ese proveedor no se reintenta durante
/// este tiempo. El castigo es POR PROVEEDOR: con un cooldown global, el 429 de
/// uno dejaba mudos a todos los demás.
const COOLDOWN_SECS: u64 = 120;

/// Un destino OpenAI-compatible. Modelo, URL y nombre de la variable con la
/// credencial: es todo lo que cambia entre proveedores de esta familia.
#[derive(Debug, Clone, PartialEq)]
pub struct Proveedor {
    pub modelo: String,
    pub endpoint: String,
    pub key_var: String,
}

/// Cadena por defecto, en orden de preferencia. Todo medido el 2026-08-28
/// contra las cuotas reales de esta cuenta.
///
/// EL LIMITE DE GROQ ES POR MODELO Y POR DIA, asi que la cadena evita amontonar
/// consumidores en el mismo contador — pero el orden lo manda el ACIERTO, no la
/// cuota:
///   - Groq `openai/gpt-oss-20b` (~330 ms): TITULAR. Comparte modelo con
///     `intent_llm`, que gasta ~200 tokens por consulta y no llega a competir
///     de verdad por los 200.000 diarios. Sobre la misma bateria de prompts
///     enruta mejor que el resto: acerto `security-scan` en una pregunta de
///     seguridad y `repo-evaluator` en "corrigeme el repositorio".
///   - Groq `qwen/qwen3.8-27b` (~718 ms): contador propio, nadie mas lo usa.
///     Relevo natural, aunque en esas dos mismas preguntas se callo o eligio
///     `code-reviewer` en lugar del evaluador de repos.
///   - Groq `openai/gpt-oss-120b`: el del AI Router del chat, que se comio
///     199.941 de sus 200.000 tokens diarios el 2026-08-28. Solo sirve los dias
///     que al chat le sobre cuota.
///   - Gemini `gemini-3.6-flash`: acierta igual, pero el tier gratis da 20
///     peticiones al DIA por modelo (429 `GenerateRequestsPerDayPerProject`).
///     Ultima reserva, nunca titular.
///
/// POR QUE UNA CADENA Y NO UN PROVEEDOR: el juez estuvo desde su despliegue sin
/// enrutar un solo prompt en produccion, y la causa no fue el codigo sino la
/// cuota del unico proveedor configurado. Un camino que depende de tiers
/// gratuitos necesita relevo, o vuelve a morir en silencio el dia que uno
/// cambie de limites.
fn cadena_por_defecto() -> Vec<Proveedor> {
    let groq = "https://api.groq.com/openai/v1/chat/completions";
    vec![
        Proveedor {
            modelo: "openai/gpt-oss-20b".to_string(),
            endpoint: groq.to_string(),
            key_var: "GROQ_API_KEY".to_string(),
        },
        Proveedor {
            modelo: "qwen/qwen3.8-27b".to_string(),
            endpoint: groq.to_string(),
            key_var: "GROQ_API_KEY".to_string(),
        },
        Proveedor {
            modelo: "openai/gpt-oss-120b".to_string(),
            endpoint: groq.to_string(),
            key_var: "GROQ_API_KEY".to_string(),
        },
        Proveedor {
            modelo: "gemini-3.6-flash".to_string(),
            endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
                .to_string(),
            key_var: "GEMINI_API_KEY".to_string(),
        },
    ]
}

/// Cadena efectiva. `ULTRON_SKILL_LLM_MODEL` / `_ENDPOINT` / `_KEY_VAR` siguen
/// funcionando como antes: definen un proveedor que se pone EL PRIMERO, sin
/// quitar el relevo detrás. Medir un modelo nuevo no debe costar recompilar ni
/// perder la red de seguridad.
pub fn cadena() -> Vec<Proveedor> {
    let mut out = Vec::new();
    let modelo = std::env::var("ULTRON_SKILL_LLM_MODEL")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if let Some(modelo) = modelo {
        let por_defecto = cadena_por_defecto();
        let base = por_defecto.first();
        out.push(Proveedor {
            modelo,
            endpoint: std::env::var("ULTRON_SKILL_LLM_ENDPOINT")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| base.map(|p| p.endpoint.clone()).unwrap_or_default()),
            key_var: std::env::var("ULTRON_SKILL_LLM_KEY_VAR")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| base.map(|p| p.key_var.clone()).unwrap_or_default()),
        });
    }
    for p in cadena_por_defecto() {
        if !out.iter().any(|q: &Proveedor| q.modelo == p.modelo) {
            out.push(p);
        }
    }
    out
}

/// Modelo del primer proveedor de la cadena. Existe para los llamantes que solo
/// quieren enseñar qué se está usando.
pub fn modelo() -> String {
    cadena()
        .first()
        .map(|p| p.modelo.clone())
        .unwrap_or_default()
}

/// Nombre de la variable que guarda la clave del primer proveedor (no la clave:
/// así un `env` o un log de configuración nunca la enseña).
pub fn key_var() -> String {
    cadena()
        .first()
        .map(|p| p.key_var.clone())
        .unwrap_or_default()
}

/// Cuántas skills como mucho puede devolver. Dos son un hint; cinco son ruido
/// que el modelo lector acaba ignorando.
const MAX_ELEGIDAS: usize = 2;

/// Recorte de la descripción que entra en el catálogo compacto. Suficiente para
/// distinguir dos skills vecinas sin pagar la prosa de triggers entera.
const DESC_CHARS: usize = 90;

/// Epoch (segundos) hasta el cual no se consulta a CADA proveedor, indexado por
/// modelo. Un proveedor caído no puede silenciar a los otros.
fn cooldowns() -> &'static std::sync::Mutex<std::collections::HashMap<String, u64>> {
    static COOLDOWNS: OnceCell<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
        OnceCell::new();
    COOLDOWNS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn en_cooldown(modelo: &str) -> bool {
    cooldowns()
        .lock()
        .map(|m| m.get(modelo).copied().unwrap_or(0) > now_secs())
        .unwrap_or(false)
}

fn activar_cooldown(modelo: &str) {
    if let Ok(mut m) = cooldowns().lock() {
        m.insert(modelo.to_string(), now_secs() + COOLDOWN_SECS);
    }
}

/// Solo para los tests: el estado de cooldown es global al proceso y arrastra
/// entre casos si no se limpia.
#[cfg(test)]
fn limpiar_cooldowns() {
    if let Ok(mut m) = cooldowns().lock() {
        m.clear();
    }
}

fn http_client() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceCell<reqwest::blocking::Client> = OnceCell::new();
    CLIENT
        .get_or_try_init(|| {
            reqwest::blocking::Client::builder()
                .timeout(timeout())
                .build()
        })
        .ok()
}

/// Una entrada del catálogo tal como la ve el modelo.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillBrief {
    pub name: String,
    pub description: String,
}

/// Primera frase útil de una descripción, recortada a `DESC_CHARS`. Las
/// descripciones traen saltos de línea y listas de triggers; aplanarlas evita
/// que una sola skill ocupe media ventana.
fn resumir(description: &str) -> String {
    let plano = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if plano.chars().count() <= DESC_CHARS {
        return plano;
    }
    plano.chars().take(DESC_CHARS).collect::<String>() + "…"
}

/// Catálogo compacto y sin duplicados, ordenado por nombre. El pool de skills
/// tiene el mismo nombre en varias rutas (una versión por caché de plugin): sin
/// deduplicar, el modelo ve la misma opción tres veces y el prompt engorda sin
/// aportar nada.
pub fn catalogo_compacto(skills: &[(String, String)]) -> Vec<SkillBrief> {
    let mut vistos: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<SkillBrief> = Vec::new();
    for (name, description) in skills {
        let limpio = name.trim();
        if limpio.is_empty() || description.trim().is_empty() {
            continue;
        }
        if !vistos.insert(limpio.to_string()) {
            continue;
        }
        out.push(SkillBrief {
            name: limpio.to_string(),
            description: resumir(description),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Catálogo tomado del disco: TODAS las skills (habilitadas y `.disabled`, que
/// es justo lo que el dispatcher lazy puede inyectar) MÁS los slash commands de
/// los plugins. Los comandos entran porque son igual de invocables y no estaban
/// en ningún índice: tres de los diez prompts de la batería del 2026-08-27 no
/// tenían candidato posible sin ellos. Vacío si el pool no se puede leer — el
/// llamante degrada al retriever, no falla.
pub fn catalogo_desde_disco() -> Vec<SkillBrief> {
    let skills = match crate::skills::list_skills_with_origin_inner(None) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let pares: Vec<(String, String)> = skills
        .into_iter()
        .chain(crate::skills::plugin_command_entries())
        .map(|s| (s.name, s.description))
        .collect();
    catalogo_compacto(&pares)
}

/// Cuántas skills deja pasar el prefiltro denso. 25 sobre un pool de ~95 mantiene
/// el acierto (al retriever le sobra recall@25 aunque su top-1 sea 4/10) y recorta
/// el prompt a menos de la mitad.
const TOPE_PREFILTRO: usize = 25;

/// Catálogo recortado por el retriever denso antes de enseñárselo al modelo.
///
/// POR QUÉ: el catálogo entero son ~2.400 tokens por consulta. Con eso, el tier
/// gratis de Gemini (20 peticiones/día) se agota en una mañana y el de Groq
/// choca con su límite de tokens por minuto; medido el 2026-08-28, el juez
/// llevaba desde su despliegue sin enrutar un solo prompt en producción. El
/// denso ya está caliente en el daemon (~40 ms) y no necesita acertar el top-1:
/// solo tiene que dejar la buena entre las 25 primeras.
///
/// Los slash commands de plugin entran SIEMPRE, sin pasar por el filtro: no
/// están en el índice `ultron_skills_lazy`, así que el denso no puede
/// proponerlos y prefiltrar por él los borraría del mapa.
///
/// FAIL-SAFE: si el denso no responde (Qdrant caído, modelo sin cargar) se
/// devuelve el catálogo entero — el comportamiento anterior, más caro pero
/// completo.
pub fn catalogo_prefiltrado(prompt: &str, tope: usize) -> Vec<SkillBrief> {
    let completo = catalogo_desde_disco();
    if completo.is_empty() {
        return completo;
    }
    let preferidos: std::collections::HashSet<String> =
        crate::memory::catalog::search_skills_lazy(prompt, tope as u32)
            .into_iter()
            .map(|h| h.name.trim().to_lowercase())
            .collect();
    if preferidos.is_empty() {
        return completo;
    }
    let comandos: std::collections::HashSet<String> = crate::skills::plugin_command_entries()
        .into_iter()
        .map(|s| s.name.trim().to_lowercase())
        .collect();

    let recortado: Vec<SkillBrief> = completo
        .iter()
        .filter(|s| {
            let n = s.name.to_lowercase();
            preferidos.contains(&n) || comandos.contains(&n)
        })
        .cloned()
        .collect();
    if recortado.is_empty() {
        return completo;
    }
    recortado
}

/// Igual que `catalogo_prefiltrado` con el tope por defecto.
pub fn catalogo_para(prompt: &str) -> Vec<SkillBrief> {
    catalogo_prefiltrado(prompt, TOPE_PREFILTRO)
}

fn system_prompt(catalogo: &[SkillBrief]) -> String {
    let lineas: Vec<String> = catalogo
        .iter()
        .map(|s| format!("{}: {}", s.name, s.description))
        .collect();
    format!(
        "Eres el enrutador de skills de un asistente de programacion. El usuario escribe en \
espanol coloquial y describe lo que quiere hacer, no la herramienta que necesita.\n\n\
Catalogo (nombre: para que sirve):\n{}\n\n\
Devuelve SOLO los nombres del catalogo que encajen con el prompt, como maximo {}, separados \
por comas y sin nada mas. Si ninguna encaja de verdad, devuelve exactamente: ninguna.\n\n\
Reglas:\n\
- Elige por lo que el usuario QUIERE HACER, no por las palabras que usa.\n\
- Es mejor devolver 'ninguna' que una skill que no viene a cuento.\n\
- No inventes nombres: solo los del catalogo, copiados tal cual.",
        lineas.join("\n"),
        MAX_ELEGIDAS
    )
}

/// Valida la respuesta del modelo contra el catálogo. Devuelve los nombres
/// reconocidos, en el orden en que los dio el modelo, sin repetir y como mucho
/// `MAX_ELEGIDAS`. Un nombre inventado se descarta en silencio: nada que no
/// exista en el catálogo puede llegar al pipeline.
pub fn parse_eleccion(raw: &str, catalogo: &[SkillBrief]) -> Vec<String> {
    let conocidos: std::collections::HashSet<&str> =
        catalogo.iter().map(|s| s.name.as_str()).collect();
    let mut out: Vec<String> = Vec::new();
    for trozo in raw.split(&[',', '\n'][..]) {
        let limpio = trozo
            .trim()
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        if limpio.is_empty() || limpio == "ninguna" {
            continue;
        }
        if conocidos.contains(limpio.as_str()) && !out.contains(&limpio) {
            out.push(limpio);
            if out.len() == MAX_ELEGIDAS {
                break;
            }
        }
    }
    out
}

/// `true` si merece la pena consultar al modelo. El llamante ya sabe si su
/// enrutado determinista dudó; esto añade el otro medio filtro: un prompt sin
/// cuerpo ("vale", "sigue") no describe trabajo, y pagar 3k tokens de catálogo
/// por él es tirar cuota. Mismo criterio que `intent_llm::merece_consulta`.
pub fn merece_consulta(prompt: &str) -> bool {
    prompt.split_whitespace().count() >= 4
}

/// Skills elegidas por el modelo, o vacío si no se pudo (sin clave, en
/// cooldown, timeout, respuesta inválida). Vacío significa "quédate con lo que
/// dijo el retriever": este camino nunca degrada el resultado anterior.
pub fn elegir_skills(prompt: &str, catalogo: &[SkillBrief]) -> Vec<String> {
    if catalogo.is_empty() {
        return Vec::new();
    }
    match consultar(&system_prompt(catalogo), prompt, 200) {
        Some(content) => parse_eleccion(&content, catalogo),
        None => Vec::new(),
    }
}

/// Una consulta a la cadena de proveedores: system + user, temperatura 0,
/// `max_tokens` de salida. Devuelve el contenido crudo del primer proveedor
/// que responda (una respuesta "no encaja nada" es una respuesta, no un fallo)
/// o `None` si ninguno estaba disponible. Cooldown por proveedor y timeout
/// duro, como siempre. Extraida de `elegir_skills` (2026-09-02) para que
/// `lesson_llm` use la misma cadena y la misma cuota separada del AI Router.
pub fn consultar(system: &str, user: &str, max_tokens: u32) -> Option<String> {
    consultar_con_cliente(http_client()?, system, user, max_tokens)
}

/// Igual que `consultar`, con un techo de espera propio. Para consultas que no
/// corren en el camino caliente de un prompt (el perfil de proyecto al cerrar
/// sesión pide ~900 tokens de salida y puede esperar más que el juez de skills).
/// Construye un cliente aparte: el compartido lleva el timeout corto cableado.
pub fn consultar_con_timeout(
    system: &str,
    user: &str,
    max_tokens: u32,
    timeout: Duration,
) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .ok()?;
    consultar_con_cliente(&client, system, user, max_tokens)
}

fn consultar_con_cliente(
    client: &reqwest::blocking::Client,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Option<String> {
    for proveedor in cadena() {
        if en_cooldown(&proveedor.modelo) {
            continue;
        }
        let Some(key) = std::env::var(&proveedor.key_var)
            .ok()
            .filter(|k| !k.trim().is_empty())
        else {
            // Sin credencial no es un fallo del proveedor: no merece cooldown,
            // simplemente no es una opcion en esta maquina.
            continue;
        };

        let body = serde_json::json!({
            "model": proveedor.modelo,
            "temperature": 0,
            "reasoning_effort": "low",
            "max_completion_tokens": max_tokens,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });

        let resp = match client
            .post(&proveedor.endpoint)
            .bearer_auth(key)
            .json(&body)
            .send()
        {
            Ok(r) if r.status().is_success() => r,
            // Fail-safe pero no mudo: sin una traza, un proveedor caido y un "el
            // modelo no vio nada que encajase" son indistinguibles desde fuera, y
            // el camino entero parece funcionar mientras no enruta nada.
            Ok(r) => {
                let status = r.status();
                let cuerpo = r.text().unwrap_or_default();
                tracing::warn!(modelo = %proveedor.modelo, %status,
                    cuerpo = %cuerpo.chars().take(300).collect::<String>(),
                    "skill_llm: el proveedor rechazo la peticion, pasando al siguiente");
                activar_cooldown(&proveedor.modelo);
                continue;
            }
            Err(e) => {
                tracing::warn!(modelo = %proveedor.modelo, error = %e,
                    "skill_llm: fallo de red, pasando al siguiente proveedor");
                activar_cooldown(&proveedor.modelo);
                continue;
            }
        };
        let json: serde_json::Value = match resp.json() {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(modelo = %proveedor.modelo, error = %e,
                    "skill_llm: respuesta ilegible, pasando al siguiente proveedor");
                activar_cooldown(&proveedor.modelo);
                continue;
            }
        };
        let content = json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        // Un "ninguna encaja" es una RESPUESTA, no un fallo: se devuelve tal
        // cual. Preguntarselo al siguiente proveedor gastaria otra cuota para
        // volver a oir lo mismo.
        return Some(content.to_string());
    }

    tracing::warn!("skill_llm: ningun proveedor de la cadena estaba disponible");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat() -> Vec<SkillBrief> {
        catalogo_compacto(&[
            ("docx".to_string(), "Documentos Word".to_string()),
            ("pdf".to_string(), "Leer y escribir PDF".to_string()),
            ("hiper-plans".to_string(), "Planes profundos".to_string()),
        ])
    }

    #[test]
    fn el_catalogo_deduplica_y_ordena() {
        let c = catalogo_compacto(&[
            ("brainstorming".to_string(), "Explorar ideas".to_string()),
            ("apply".to_string(), "Aplicar cambios".to_string()),
            // Mismo nombre desde otra cache de plugin: una sola entrada.
            ("brainstorming".to_string(), "Explorar ideas".to_string()),
        ]);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].name, "apply");
        assert_eq!(c[1].name, "brainstorming");
    }

    #[test]
    fn una_skill_sin_descripcion_no_entra() {
        let c = catalogo_compacto(&[("muda".to_string(), "   ".to_string())]);
        assert!(c.is_empty(), "sin descripcion solo aporta ruido al prompt");
    }

    #[test]
    fn la_descripcion_se_recorta() {
        let larga = "palabra ".repeat(60);
        let c = catalogo_compacto(&[("x".to_string(), larga)]);
        assert!(c[0].description.chars().count() <= DESC_CHARS + 1);
    }

    #[test]
    fn acepta_los_nombres_del_catalogo() {
        assert_eq!(parse_eleccion("docx", &cat()), vec!["docx".to_string()]);
        assert_eq!(
            parse_eleccion(" PDF , docx ", &cat()),
            vec!["pdf".to_string(), "docx".to_string()]
        );
    }

    #[test]
    fn una_alucinacion_no_se_cuela_como_skill() {
        assert!(parse_eleccion("word-master", &cat()).is_empty());
        assert!(parse_eleccion("ninguna", &cat()).is_empty());
        assert!(parse_eleccion("", &cat()).is_empty());
        // Mezcla de real e inventada: solo sobrevive la real.
        assert_eq!(
            parse_eleccion("word-master, pdf", &cat()),
            vec!["pdf".to_string()]
        );
    }

    #[test]
    fn nunca_devuelve_mas_del_tope_ni_repetidas() {
        let elegidas = parse_eleccion("docx, pdf, hiper-plans", &cat());
        assert_eq!(elegidas.len(), MAX_ELEGIDAS);
        let repes = parse_eleccion("docx, docx, pdf", &cat());
        assert_eq!(repes, vec!["docx".to_string(), "pdf".to_string()]);
    }

    #[test]
    fn el_gate_descarta_los_turnos_sin_cuerpo() {
        assert!(!merece_consulta("vale"));
        assert!(!merece_consulta("sigue con eso"));
        assert!(merece_consulta("pasame el informe a Word con indice"));
    }

    #[test]
    fn sin_catalogo_no_se_llama_al_proveedor() {
        // Guard de entrada: sin candidatos no hay nada que elegir y la llamada
        // seria dinero tirado.
        assert!(elegir_skills("lo que sea", &[]).is_empty());
    }

    /// Las variables de entorno son estado global del proceso: sin serializar,
    /// estos tests se pisan entre si cuando cargo los corre en paralelo.
    fn guard_env() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceCell<std::sync::Mutex<()>> = OnceCell::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn la_cadena_por_defecto_empieza_por_el_proveedor_medido() {
        let _g = guard_env();
        std::env::remove_var("ULTRON_SKILL_LLM_MODEL");
        let c = cadena();
        assert!(c.len() >= 3, "un solo relevo no cubre un dia de trabajo");
        assert_eq!(c[0].modelo, "openai/gpt-oss-20b");
        assert_eq!(c[0].key_var, "GROQ_API_KEY");
        // Restriccion dura: el titular NO puede ser el modelo del chat. La cuota
        // de Groq es por modelo y por dia, y el AI Router se comio 199.941 de
        // los 200.000 tokens del gpt-oss-120b en una sola jornada.
        assert_ne!(c[0].modelo, "openai/gpt-oss-120b");
        // El modelo de intent_llm SI puede compartirse (gasta una frase por
        // consulta), pero entonces tiene que haber relevo con contador propio
        // detras, o una mala racha del intent deja al juez sin cuota.
        assert!(
            c.iter().skip(1).any(
                |p| p.modelo != crate::orchestrator::intent_llm::modelo_en_uso()
                    && p.modelo != "openai/gpt-oss-120b"
            ),
            "sin un relevo de contador propio, el juez depende del gasto de otro camino",
        );
        // Gemini sigue detras: acierta igual, pero su tier gratis da 20
        // peticiones al dia y no puede ser el titular.
        assert!(c.iter().any(|p| p.modelo == "gemini-3.6-flash"));
        // Ningun modelo repetido: dos entradas iguales gastan la misma cuota
        // dos veces y no son relevo de nada.
        let mut modelos: Vec<&str> = c.iter().map(|p| p.modelo.as_str()).collect();
        modelos.sort_unstable();
        let total = modelos.len();
        modelos.dedup();
        assert_eq!(modelos.len(), total, "hay proveedores duplicados");
    }

    #[test]
    fn el_modelo_del_entorno_manda_pero_no_borra_el_relevo() {
        let _g = guard_env();
        std::env::set_var("ULTRON_SKILL_LLM_MODEL", "modelo-de-prueba");
        let c = cadena();
        std::env::remove_var("ULTRON_SKILL_LLM_MODEL");
        assert_eq!(c[0].modelo, "modelo-de-prueba");
        assert!(
            c.len() >= 3,
            "el override debe anteponerse a la cadena, no sustituirla"
        );
    }

    #[test]
    fn el_cooldown_castiga_solo_al_proveedor_que_fallo() {
        let _g = guard_env();
        limpiar_cooldowns();
        activar_cooldown("openai/gpt-oss-120b");
        assert!(en_cooldown("openai/gpt-oss-120b"));
        // Este era el bug de fondo: con un cooldown global, el 429 de uno
        // dejaba mudos a todos y el juez se quedaba sin enrutar nada.
        assert!(!en_cooldown("gemini-3.6-flash"));
        limpiar_cooldowns();
        assert!(!en_cooldown("openai/gpt-oss-120b"));
    }
}
