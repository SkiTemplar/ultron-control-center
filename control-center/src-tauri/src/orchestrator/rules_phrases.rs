/// DIFFERENT project than the current one ("aquel proyecto", "otro proyecto",
/// "the other project", "across all my projects"...). Substring-matched, same
/// cheap heuristic as `classify_intent` — no NLU. Kept narrow on purpose: a false
/// positive only WIDENS recall (still security-gated), but we avoid generic words
/// like "proyecto" alone that would fire on in-project prompts.
pub(super) const CROSS_PROJECT_PHRASES: &[&str] = &[
    "otro proyecto",
    "otros proyectos",
    "aquel proyecto",
    "aquel otro proyecto",
    "ese proyecto",
    "en otro proyecto",
    "todos mis proyectos",
    "todos los proyectos",
    "cualquier proyecto",
    "entre proyectos",
    "cross-project",
    "cross project",
    "other project",
    "another project",
    "the other project",
    "all my projects",
    "all projects",
    "across projects",
    "any project",
];

/// Heuristic intent detector for CROSS-PROJECT (whole-brain) recall. Returns true
/// only when the prompt explicitly references a different / other / all projects.
/// Deliberately conservative — see `CROSS_PROJECT_PHRASES`. The caller still gates
/// this on having a current `project_id` (cross-project is a no-op without one).
pub fn detect_cross_project(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    CROSS_PROJECT_PHRASES.iter().any(|pat| p.contains(pat))
}

/// Frases (es/en) de tareas META/INTROSPECTIVAS sobre la propia sesión:
/// autoevaluación, resumen de la conversación, "ponte nota"... Un subagente
/// NO tiene el transcript de la conversación, así que ordenar DELEGAR esta
/// clase es ordenar un imposible (card bvaqws 2026-06-23). Mismo patrón
/// barato que `CROSS_PROJECT_PHRASES`: frases con espacios, específicas —
/// nada de palabras sueltas genéricas (lección routing 2026-06-05).
pub(super) const META_INTROSPECTIVE_PHRASES: &[&str] = &[
    "autoevalua",
    "autoevalúa",
    "autoevaluacion",
    "autoevaluación",
    "evalua la sesion",
    "evalúa la sesión",
    "evalua esta sesion",
    "evalúa esta sesión",
    "evalua tu trabajo",
    "evalúa tu trabajo",
    "evalua tu rendimiento",
    "evalúa tu rendimiento",
    "evalua esta conversacion",
    "evalúa esta conversación",
    "resume la sesion",
    "resume la sesión",
    "resume esta sesion",
    "resume esta sesión",
    "resume la conversacion",
    "resume la conversación",
    "resume esta conversacion",
    "resume esta conversación",
    "que nota te pones",
    "qué nota te pones",
    "ponte nota",
    "evaluate this session",
    "evaluate your performance",
    "summarize this session",
    "summarize this conversation",
    "self-assess",
    "self-evaluate",
    "rate your performance",
];
