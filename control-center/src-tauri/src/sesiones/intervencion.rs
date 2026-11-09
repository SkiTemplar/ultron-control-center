// sesiones/intervencion.rs — Intervenciones de motores en el hilo de una
// sesión (`sesiones_engine_run`, contrato v0.2, E8).
//
// El motor trabaja en el cwd de la sesión. Con `includeContext` recibe un
// paquete con los últimos turnos de texto del hilo principal (sin bloques de
// herramientas ni razonamiento), recortado a ~24 000 caracteres conservando
// los más recientes, seguido del prompt. Nada vuelve a Claude hasta que el
// usuario pulsa «Traer» (`motor::bring` → `traer`): una sola vez (reserva
// atómica en `motor`) y con un tope de caracteres; el resto queda en un
// fichero de `adjuntos/` cuya ruta se cita (R31, seguridad-robustez:F12).
//
// El contexto y el ancla salen del final del transcript (`lectura_final`):
// nunca se lee entero un transcript de días.

use std::path::{Path, PathBuf};

use super::motor::{self, TaskSpec};
use super::registro;
use super::transcript;
use super::types::{Block, ChatMessage, EngineTask};
use super::{codex, gemini, lectura_final};

/// Presupuesto del paquete de contexto, en caracteres.
pub const CONTEXT_BUDGET: usize = 24_000;
/// Tope del texto que «Traer a Claude» pega en la sesión.
pub const BRING_MAX_CHARS: usize = 8_000;
const OPINION_HEADER: &str = "Da una segunda opinión crítica e independiente sobre la última \
respuesta de Claude en el contexto: errores, riesgos y alternativas mejores. No modifiques \
ficheros.";
const REVIEW_HEADER: &str = "Revisa los cambios que Claude acaba de hacer en este repositorio \
(`git diff` y los ficheros citados): bugs, regresiones y riesgos concretos, con fichero y \
línea. No modifiques ficheros. Si no encuentras nada relevante, responde solo: SIN HALLAZGOS";
const CONTRAST_HEADER: &str = "Contrasta estas respuestas de otros motores al mismo encargo: \
en qué coinciden, en qué difieren y cuál es correcta según el código de este repositorio. No \
apliques cambios todavía.";
const GROUP_MAX: usize = 64;

/// Petición de `sesiones_engine_run`.
#[derive(Debug, Clone)]
pub struct RunRequest {
    pub session_id: String,
    pub engine: String,
    pub prompt: String,
    pub kind: String,
    pub include_context: bool,
    pub mode: Option<String>,
    /// Modelo elegido (`None` = el predeterminado de la CLI).
    pub model: Option<String>,
    /// Id del Tribunal (Codex y Gemini con el mismo encargo).
    pub group: Option<String>,
    /// Clave idempotente (el `turnId` en la revisión automática): con varias
    /// ventanas abiertas, el mismo turno lanza un solo proceso.
    pub turn_id: Option<String>,
    /// Rutas de los adjuntos del composer (vacío = ninguno).
    pub attachments: Vec<String>,
}

/// Extensiones que Codex recibe como imagen (`--image`).
const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

fn es_imagen(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// (imágenes para `--image`, rutas que van al final del prompt). Solo Codex
/// tiene flag de imágenes; los demás motores reciben todas las rutas en el
/// prompt. Una ruta con coma va al prompt: `--image` parte por comas.
pub fn split_attachments(engine: &str, paths: &[String]) -> (Vec<String>, Vec<String>) {
    paths
        .iter()
        .cloned()
        .partition(|p| engine == "codex" && es_imagen(p) && !p.contains(','))
}

/// Prompt con la lista de ficheros adjuntos al final.
pub fn with_attachment_list(prompt: &str, files: &[String]) -> String {
    if files.is_empty() {
        return prompt.to_string();
    }
    let lista: Vec<String> = files.iter().map(|f| format!("- {f}")).collect();
    format!(
        "{prompt}

Ficheros adjuntos:
{}",
        lista.join(
            "
"
        )
    )
}

/// Claves idempotentes recordadas (las más recientes).
const MAX_CLAVES: usize = 500;
const CLAVE_MAX: usize = 128;

/// Turno de texto del hilo principal: (`Usuario` | `Claude`, texto).
pub type Turn = (&'static str, String);

/// Turnos de texto del hilo principal de un transcript.
#[cfg(test)]
pub fn text_turns(transcript_text: &str) -> Vec<Turn> {
    turnos_de(&transcript::parse_all(transcript_text, None))
}

/// Turnos de texto del hilo principal de una lista de mensajes.
fn turnos_de(msgs: &[ChatMessage]) -> Vec<Turn> {
    msgs.iter()
        .filter(|m| m.agent_id.is_none() && (m.role == "user" || m.role == "assistant"))
        .filter_map(|m| {
            let text: Vec<String> = m
                .blocks
                .iter()
                .filter_map(|b| match b {
                    Block::Text { text } if !text.trim().is_empty() => {
                        Some(text.trim().to_string())
                    }
                    _ => None,
                })
                .collect();
            if text.is_empty() {
                return None;
            }
            let who = if m.role == "user" {
                "Usuario"
            } else {
                "Claude"
            };
            Some((who, text.join("\n")))
        })
        .collect()
}

/// Últimos caracteres de `s` (como mucho `max`).
fn tail_chars(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    s.chars().skip(n - max).collect()
}

/// Paquete de contexto: los turnos más recientes que quepan en `budget`
/// caracteres, en orden cronológico. Si ni el último cabe, va su final.
pub fn pack_turns(turns: &[Turn], budget: usize) -> String {
    let mut picked: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (who, text) in turns.iter().rev() {
        let block = format!("### {who}\n{text}\n\n");
        let len = block.chars().count();
        if used + len <= budget {
            used += len;
            picked.push(block);
            continue;
        }
        if picked.is_empty() {
            let head = format!("### {who} (recortado)\n…");
            let room = budget.saturating_sub(head.chars().count() + 2);
            picked.push(format!("{head}{}\n\n", tail_chars(text, room)));
        }
        break;
    }
    picked.reverse();
    picked.concat()
}

/// Prompt completo que recibe el motor.
pub fn compose_prompt(kind: &str, prompt: &str, context: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(c) = context.filter(|c| !c.trim().is_empty()) {
        out.push_str("[Contexto: conversación en curso con Claude Code en este directorio; últimos turnos]\n\n");
        out.push_str(c);
        out.push_str("[Fin del contexto]\n\n");
    }
    let header = match kind {
        "opinion" => Some(OPINION_HEADER),
        "review" => Some(REVIEW_HEADER),
        _ => None,
    };
    if let Some(h) = header {
        out.push_str(h);
        out.push_str("\n\n");
    }
    out.push_str(prompt.trim());
    out
}

fn validate(req: &RunRequest) -> Result<(), String> {
    if !matches!(req.engine.as_str(), "codex" | "gemini" | "opencode") {
        return Err(format!("motor no válido: '{}'", req.engine));
    }
    if !matches!(req.kind.as_str(), "task" | "opinion" | "review" | "relay") {
        return Err(format!("tipo de intervención no válido: '{}'", req.kind));
    }
    if let Some(g) = &req.group {
        let valido = !g.is_empty()
            && g.len() <= GROUP_MAX
            && g.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valido {
            return Err(format!("id de tribunal no válido: '{g}'"));
        }
    }
    if let Some(k) = &req.turn_id {
        let valida =
            !k.is_empty() && k.len() <= CLAVE_MAX && k.chars().all(|c| c.is_ascii_graphic());
        if !valida {
            return Err(format!("clave de turno no válida: '{k}'"));
        }
    }
    if let Some(m) = &req.model {
        super::modelos::validate_model_for(&req.engine, m)?;
    }
    if !req.attachments.is_empty() && req.mode.as_deref() == Some("cloud") {
        return Err(codex::CLOUD_NO_ATTACHMENTS.to_string());
    }
    if let Some(a) = req
        .attachments
        .iter()
        .find(|a| a.trim().is_empty() || a.chars().any(char::is_control))
    {
        return Err(format!("ruta de adjunto no válida: '{a}'"));
    }
    let opinion_with_context = req.kind == "opinion" && req.include_context;
    if req.prompt.trim().is_empty() && !opinion_with_context {
        return Err("el prompt está vacío".to_string());
    }
    Ok(())
}

/// Caracteres que ocupa un turno en el paquete de `pack_turns`.
fn largo_turno((who, text): &Turn) -> usize {
    format!("### {who}\n{text}\n\n").chars().count()
}

/// Contexto (si se pide) y ancla de un trozo final del transcript; `None` si
/// el trozo no basta y no es el fichero entero.
fn de_final(fin: &lectura_final::Final, con_contexto: bool) -> Option<Contexto> {
    let msgs = transcript::parse_all(&fin.texto, None);
    // Último mensaje del hilo principal: ancla del bloque del motor (§5.6).
    let ancla = msgs
        .iter()
        .rev()
        .find(|m| m.agent_id.is_none())
        .map(|m| m.uuid.clone());
    let turnos = if con_contexto {
        turnos_de(&msgs)
    } else {
        Vec::new()
    };
    let lleno = turnos.iter().map(largo_turno).sum::<usize>() > CONTEXT_BUDGET;
    let basta = ancla.is_some() && (!con_contexto || lleno);
    if !basta && !fin.completo {
        return None;
    }
    let paquete = con_contexto.then(|| pack_turns(&turnos, CONTEXT_BUDGET));
    Some((paquete, ancla))
}

/// (paquete de contexto, ancla).
type Contexto = (Option<String>, Option<String>);

/// Contexto y ancla leyendo solo el final del transcript.
fn contexto_y_ancla(path: Option<&Path>, con_contexto: bool) -> Result<Contexto, String> {
    let Some(path) = path.filter(|p| p.is_file()) else {
        if con_contexto {
            return Err(
                "la sesión aún no tiene transcript: no hay contexto que incluir".to_string(),
            );
        }
        // Sin contexto, el transcript solo da el ancla: si falta, no hay ancla.
        return Ok((None, None));
    };
    let r = lectura_final::buscar_desde_el_final(path, |fin| de_final(fin, con_contexto));
    match r {
        Ok(c) => Ok(c.unwrap_or((None, None))),
        Err(e) if con_contexto => Err(format!("no se pudo leer el transcript: {e}")),
        Err(_) => Ok((None, None)),
    }
}

/// Lanza la intervención en el cwd de la sesión. Con `turn_id`, la misma
/// clave no lanza un segundo proceso: devuelve la tarea ya lanzada.
pub fn run(mut req: RunRequest) -> Result<EngineTask, String> {
    validate(&req)?;
    // Los turnos que el usuario manda al motor del relevo siguen con su modelo
    // (la API de Anthropic en OpenCode), no con el predeterminado de la CLI.
    if req.kind == "relay" && req.model.is_none() {
        req.model = super::relevo::relay_model(&req.engine);
    }
    let clave = req
        .turn_id
        .as_ref()
        .map(|k| format!("{}:{}:{k}", req.session_id, req.kind));
    con_clave(clave.as_deref(), || lanzar(&req))
}

/// Registro de claves idempotentes: (clave, id de la tarea).
fn claves() -> &'static std::sync::Mutex<std::collections::VecDeque<(String, String)>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<(String, String)>>> =
        std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

/// Ejecuta `lanzar` una sola vez por clave. El candado se mantiene durante el
/// lanzamiento: dos ventanas que piden el mismo turno a la vez no pueden
/// lanzar las dos. Sin clave, lanza siempre.
pub fn con_clave(
    clave: Option<&str>,
    lanzar: impl FnOnce() -> Result<EngineTask, String>,
) -> Result<EngineTask, String> {
    let Some(clave) = clave else {
        return lanzar();
    };
    let mut c = claves()
        .lock()
        .map_err(|_| "registro de claves de motores envenenado".to_string())?;
    if let Some((_, id)) = c.iter().find(|(k, _)| k == clave) {
        return motor::get(id)
            .map_err(|_| "la intervención de este turno ya se lanzó y se borró".to_string());
    }
    let task = lanzar()?;
    c.push_back((clave.to_string(), task.id.clone()));
    while c.len() > MAX_CLAVES {
        c.pop_front();
    }
    Ok(task)
}

fn lanzar(req: &RunRequest) -> Result<EngineTask, String> {
    let (cwd, project_id, transcript_path) = registro::read(&req.session_id, |s| {
        (
            s.info.cwd.clone(),
            s.info.project_id.clone(),
            s.transcript.clone(),
        )
    })?;
    // Un turno del relevo con contexto (Gemini, que no conserva el hilo)
    // recibe el traspaso y los turnos previos del relevo, no el transcript.
    let relay_ctx = (req.kind == "relay" && req.include_context)
        .then(|| super::relevo::relay_context(&req.session_id))
        .flatten();
    let con_transcript = req.include_context && relay_ctx.is_none();
    let (context, anchor) = contexto_y_ancla(transcript_path.as_deref(), con_transcript)?;
    let context = relay_ctx.or(context);
    let (images, files) = split_attachments(&req.engine, &req.attachments);
    let base = compose_prompt(&req.kind, &req.prompt, context.as_deref());
    let full = with_attachment_list(&base, &files);
    let spec = TaskSpec {
        engine: match req.engine.as_str() {
            "codex" => "codex",
            "opencode" => "opencode",
            _ => "gemini",
        },
        kind: req.kind.clone(),
        mode: req.mode.clone().unwrap_or_else(|| "local".into()),
        cwd,
        prompt: req.prompt.trim().to_string(),
        session_id: Some(req.session_id.clone()),
        context_chars: context.as_deref().map_or(0, |c| c.chars().count()),
        model: req.model.clone(),
        group: req.group.clone(),
    };
    let task = match spec.engine {
        "codex" => codex::start(spec, full, project_id.as_deref(), &images),
        "opencode" => super::opencode::start(spec, full),
        _ => gemini::start(spec, full),
    }?;
    if task.kind == "relay" {
        super::relevo::track_task(&task);
    }
    motor::anclar(&task.id, anchor)
}

// ---------------------------------------------------------------------------
// «Traer a Claude»
// ---------------------------------------------------------------------------

/// Envío a la sesión de Claude (`gestor::send` en producción).
pub type Sender<'a> = &'a dyn Fn(&str, &str) -> Result<(), String>;

fn bring_body(t: &EngineTask) -> String {
    t.summary.clone().unwrap_or_else(|| {
        t.events
            .iter()
            .rev()
            .take(20)
            .rev()
            .map(|e| format!("[{}] {}", e.kind, e.text))
            .collect::<Vec<_>>()
            .join(
                "
",
            )
    })
}

fn bring_header(t: &EngineTask) -> String {
    let name = super::gestor::title_from(&t.prompt);
    let what = match t.kind.as_str() {
        "opinion" => "Segunda opinión de",
        "review" => "Revisión automática de",
        _ => "Resultado de",
    };
    format!(
        "{what} {} ({name}):
",
        motor::engine_label(&t.engine)
    )
}

/// Texto que se pega en la sesión, como mucho `BRING_MAX_CHARS`. Si el
/// resultado no cabe, se guarda entero en `dir` y se cita su ruta (sin `@`:
/// Claude lo lee solo si lo necesita).
pub fn bring_text(t: &EngineTask, dir: Option<&Path>) -> Result<String, String> {
    let head = bring_header(t);
    let body = bring_body(t);
    let total = body.chars().count();
    if head.chars().count() + total <= BRING_MAX_CHARS {
        return Ok(format!("{head}{body}"));
    }
    let dir = dir.ok_or("no hay directorio para guardar el resultado completo")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let short: String = t.id.chars().take(8).collect();
    let path = dir.join(format!("motor-{}-{short}.md", t.engine));
    std::fs::write(&path, &body)
        .map_err(|e| format!("no se pudo guardar el resultado completo: {e}"))?;
    let tail = format!(
        "

[…recortado: resultado completo ({total} caracteres) en {}]",
        path.display()
    );
    let room = BRING_MAX_CHARS.saturating_sub(head.chars().count() + tail.chars().count());
    let cut: String = body.chars().take(room).collect();
    Ok(format!("{head}{cut}{tail}"))
}

fn bring_dir() -> Option<PathBuf> {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    crate::ultron_root()
        .ok()
        .map(|r| r.join("adjuntos").join(date))
}

/// Pega el resultado de la tarea en `session_id` una sola vez: reserva
/// atómica, envío y, si el envío falla, se deshace la reserva.
pub fn traer(task_id: &str, session_id: &str, send: Sender) -> Result<(), String> {
    traer_en(task_id, session_id, bring_dir().as_deref(), send)
}

pub fn traer_en(
    task_id: &str,
    session_id: &str,
    dir: Option<&Path>,
    send: Sender,
) -> Result<(), String> {
    let task = motor::reservar_traida(task_id)?;
    let sent = bring_text(&task, dir).and_then(|text| send(session_id, &text));
    if let Err(e) = sent {
        motor::revertir_traida(task_id);
        return Err(e);
    }
    motor::guardar();
    Ok(())
}

/// Tribunal: pega en `session_id` las respuestas de todas las tareas del
/// grupo con la petición de contrastarlas. Todas deben haber terminado y
/// ninguna haberse traído ya; si el envío falla, se deshacen las reservas.
pub fn contrastar(group: &str, session_id: &str, send: Sender) -> Result<(), String> {
    contrastar_en(group, session_id, bring_dir().as_deref(), send)
}

pub fn contrastar_en(
    group: &str,
    session_id: &str,
    dir: Option<&Path>,
    send: Sender,
) -> Result<(), String> {
    let mut grupo: Vec<EngineTask> = motor::list(None)
        .into_iter()
        .filter(|t| t.group.as_deref() == Some(group))
        .collect();
    if grupo.len() < 2 {
        return Err("el tribunal necesita al menos dos respuestas".to_string());
    }
    // Mismo criterio que `canContrast` en el frontend: todas terminadas bien.
    if let Some(t) = grupo.iter().find(|t| t.status != "done") {
        return Err(format!(
            "la respuesta de {} no terminó bien ({}): no se puede contrastar",
            motor::engine_label(&t.engine),
            t.status
        ));
    }
    grupo.sort_by(|a, b| a.engine.cmp(&b.engine));
    let mut reservadas: Vec<String> = Vec::new();
    let revertir = |ids: &[String]| ids.iter().for_each(|id| motor::revertir_traida(id));
    let mut partes = vec![CONTRAST_HEADER.to_string()];
    for t in &grupo {
        // La reserva se apunta antes de componer el texto: si `bring_text`
        // falla, también se deshace la de esta tarea.
        let texto = motor::reservar_traida(&t.id).and_then(|snap| {
            reservadas.push(t.id.clone());
            bring_text(&snap, dir)
        });
        match texto {
            Ok(texto) => partes.push(format!("<{0}>\n{texto}\n</{0}>", t.engine)),
            Err(e) => {
                revertir(&reservadas);
                return Err(e);
            }
        }
    }
    if let Err(e) = send(session_id, &partes.join("\n\n")) {
        revertir(&reservadas);
        return Err(e);
    }
    motor::guardar();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns(n: usize, size: usize) -> Vec<Turn> {
        (0..n)
            .map(|i| {
                let who = if i % 2 == 0 { "Usuario" } else { "Claude" };
                (who, format!("{i}:{}", "a".repeat(size)))
            })
            .collect()
    }

    #[test]
    fn el_paquete_respeta_el_presupuesto_y_conserva_lo_ultimo() {
        let t = turns(40, 1_000);
        let p = pack_turns(&t, CONTEXT_BUDGET);
        assert!(p.chars().count() <= CONTEXT_BUDGET);
        assert!(p.contains("39:"), "falta el turno más reciente");
        assert!(!p.contains("\n0:"), "no debería caber el primero");
        let i38 = p.find("38:").expect("38");
        let i39 = p.find("39:").expect("39");
        assert!(i38 < i39, "orden cronológico");
    }

    #[test]
    fn un_turno_enorme_se_recorta_por_el_principio() {
        let t = vec![("Claude", format!("INICIO{}FINAL", "b".repeat(50_000)))];
        let p = pack_turns(&t, 1_000);
        assert!(p.chars().count() <= 1_000);
        assert!(p.contains("FINAL") && !p.contains("INICIO"));
        assert!(p.contains("(recortado)"));
    }

    #[test]
    fn sin_turnos_no_hay_paquete() {
        assert_eq!(pack_turns(&[], CONTEXT_BUDGET), "");
    }

    #[test]
    fn solo_entra_el_texto_del_hilo_principal() {
        let jsonl = [
            r#"{"type":"user","uuid":"u1","timestamp":"t","message":{"role":"user","content":"pregunta"}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"t","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"secreto"},{"type":"text","text":"respuesta"}]}}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"t","isMeta":true,"message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}"#,
            r#"{"type":"assistant","uuid":"a2","timestamp":"t","agentId":"sub","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"del subagente"}]}}"#,
        ]
        .join("\n");
        let t = text_turns(&jsonl);
        assert_eq!(
            t,
            vec![
                ("Usuario", "pregunta".to_string()),
                ("Claude", "respuesta".to_string())
            ]
        );
    }

    #[test]
    fn la_opinion_sin_contexto_exige_prompt() {
        let req = RunRequest {
            session_id: "s".into(),
            engine: "gemini".into(),
            prompt: "  ".into(),
            kind: "opinion".into(),
            include_context: false,
            mode: None,
            model: None,
            group: None,
            turn_id: None,
            attachments: Vec::new(),
        };
        assert!(validate(&req).is_err());
        let ok = RunRequest {
            include_context: true,
            ..req.clone()
        };
        assert!(validate(&ok).is_ok());
        let bad = RunRequest {
            engine: "ollama".into(),
            ..ok
        };
        assert!(validate(&bad).is_err());
        let bad_model = RunRequest {
            engine: "codex".into(),
            model: Some("x\" --sandbox".into()),
            ..req
        };
        assert!(validate(&bad_model).is_err());
    }

    #[test]
    fn el_prompt_compuesto_lleva_contexto_y_cabecera() {
        let p = compose_prompt(
            "opinion",
            "¿y la concurrencia?",
            Some("### Usuario\nhola\n\n"),
        );
        assert!(p.starts_with("[Contexto"));
        assert!(p.contains("segunda opinión"));
        assert!(p.ends_with("¿y la concurrencia?"));
        assert_eq!(compose_prompt("task", " haz X ", None), "haz X");
    }

    fn transcript_grande(turnos: usize) -> String {
        let relleno = "z".repeat(300);
        let mut l: Vec<String> = (0..turnos)
            .map(|i| {
                format!(
                    r#"{{"type":"user","uuid":"u{i}","timestamp":"t","message":{{"role":"user","content":"p{i} {relleno}"}}}}"#
                )
            })
            .collect();
        l.push(
            r#"{"type":"assistant","uuid":"sub","timestamp":"t","agentId":"a1","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"x"}]}}"#
                .to_string(),
        );
        l.join("\n") + "\n"
    }

    #[test]
    fn el_final_del_transcript_da_el_mismo_contexto_y_ancla_que_entero() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("t.jsonl");
        let texto = transcript_grande(3_000);
        assert!(texto.len() as u64 > lectura_final::VENTANA_INICIAL * 2);
        std::fs::write(&p, &texto).expect("escribir");
        let (ctx, ancla) = contexto_y_ancla(Some(&p), true).expect("contexto");
        let entero = pack_turns(&text_turns(&texto), CONTEXT_BUDGET);
        assert_eq!(ctx.as_deref(), Some(entero.as_str()));
        assert_eq!(ancla.as_deref(), Some("u2999"), "el subagente no es ancla");
        let (sin, ancla2) = contexto_y_ancla(Some(&p), false).expect("ancla");
        assert_eq!((sin, ancla2.as_deref()), (None, Some("u2999")));
    }

    #[test]
    fn sin_transcript_el_contexto_es_error_y_el_ancla_no_existe() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("nada.jsonl");
        assert!(contexto_y_ancla(Some(&p), true).is_err());
        assert_eq!(contexto_y_ancla(None, false), Ok((None, None)));
        std::fs::write(&p, transcript_grande(3)).expect("escribir");
        let (ctx, ancla) = contexto_y_ancla(Some(&p), true).expect("pequeño");
        assert!(ctx.is_some_and(|c| c.contains("p0 ")), "cabe entero");
        assert_eq!(ancla.as_deref(), Some("u2"));
    }

    #[test]
    fn la_revision_y_el_tribunal_se_validan() {
        let req = RunRequest {
            session_id: "s".into(),
            engine: "codex".into(),
            prompt: "Ficheros: a.rs".into(),
            kind: "review".into(),
            include_context: false,
            mode: None,
            model: None,
            group: Some("3f2a-9c".into()),
            turn_id: None,
            attachments: Vec::new(),
        };
        assert!(validate(&req).is_ok());
        assert!(compose_prompt("review", "x", None).contains("SIN HALLAZGOS"));
        for malo in ["", "a b", "x;rm", &"z".repeat(65)] {
            let bad = RunRequest {
                group: Some(malo.to_string()),
                ..req.clone()
            };
            assert!(validate(&bad).is_err(), "grupo '{malo}'");
        }
        let tipo = RunRequest {
            kind: "otro".into(),
            ..req
        };
        assert!(validate(&tipo).is_err());
    }

    #[test]
    fn los_adjuntos_se_reparten_por_motor() {
        let a = vec![
            "C:/x/foto.PNG".to_string(),
            "C:/x/notas.md".to_string(),
            "C:/x/a,b.jpg".to_string(),
        ];
        let (img, rest) = split_attachments("codex", &a);
        assert_eq!(img, vec!["C:/x/foto.PNG".to_string()]);
        assert_eq!(
            rest,
            vec!["C:/x/notas.md".to_string(), "C:/x/a,b.jpg".to_string()]
        );
        let (img, rest) = split_attachments("gemini", &a);
        assert!(img.is_empty(), "agy no tiene flag de adjuntos");
        assert_eq!(rest, a);
        let p = with_attachment_list("haz X", &rest[..1]);
        assert_eq!(
            p,
            "haz X

Ficheros adjuntos:
- C:/x/foto.PNG"
        );
        assert_eq!(with_attachment_list("haz X", &[]), "haz X");
    }

    #[test]
    fn codex_cloud_rechaza_adjuntos_locales() {
        let req = RunRequest {
            session_id: "s".into(),
            engine: "codex".into(),
            prompt: "haz X".into(),
            kind: "task".into(),
            include_context: false,
            mode: Some("cloud".into()),
            model: None,
            group: None,
            turn_id: None,
            attachments: vec!["C:/x/a.png".into()],
        };
        assert_eq!(validate(&req), Err(codex::CLOUD_NO_ATTACHMENTS.to_string()));
        let local = RunRequest {
            mode: Some("local".into()),
            ..req.clone()
        };
        assert!(validate(&local).is_ok());
        let sin = RunRequest {
            attachments: Vec::new(),
            ..req.clone()
        };
        assert!(validate(&sin).is_ok());
        let mala = RunRequest {
            attachments: vec!["a
b"
            .into()],
            ..local
        };
        assert!(validate(&mala).is_err());
    }
}
