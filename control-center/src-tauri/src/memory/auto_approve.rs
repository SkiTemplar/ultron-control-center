// ULTRON Control Center — Memory auto-approve policy (settings + safeguard)
//
// Persists a single user preference — `auto_approve` — that, when ON, promotes a
// freshly created memory candidate straight to an ACTIVE memory, skipping the
// human inbox. This trades the human-in-the-loop gate for convenience, so it is
// guarded by a HARD SECURITY SALVAGUARDA:
//
//   A candidate is auto-approved ONLY when it is "clean":
//     * its `risk_level` is NOT the secret marker ("secret"), AND
//     * it carries NO `contradiction_candidates`, AND
//     * it has NO `duplicate_candidates` (1.2: a duplicate goes to the inbox,
//       never auto-active — that is how 211 identical copies once leaked in).
//
//   Anything secret-bearing or contradicting an active memory ALWAYS stays in the
//   inbox for explicit human adjudication, no matter what the toggle says. This
//   preserves the governance design (write-path Secret-gate H2 + contradiction
//   detector) even with auto-approve enabled.
//
// Persistence follows the existing cockpit-settings pattern (see features.rs):
// a flat JSON file at `~/.ultron/cockpit/memory-settings.json`, atomic write
// (tmp + rename), default-safe reads. FAIL-SAFE: a missing / malformed file —
// or no HOME — reads back as `auto_approve = false` (OFF), so a read error can
// never silently start auto-promoting memories.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::model::MemoryCandidate;

/// Candidate `risk_level` literal set by the write-path when a credential was
/// detected. Mirrors `service::SECRET_RISK_MARKER`; kept here so the safeguard
/// has a single, local source of the literal it gates on.
const SECRET_RISK_MARKER: &str = "secret";

/// Default confidence floor for BAND A (auto-approve). A candidate must reach
/// this confidence AND be clean to be auto-promoted.
///
/// Set to 0.72 — ABOVE the mid-confidence band (inferred decisions land at ~0.70,
/// which must keep falling to BAND B) yet BELOW the real ceiling of the capture
/// write-path. `derive_confidence` (capture.rs) tops out at 0.762 (a
/// router-extracted fact with self-reported `llm_score = 1.0`); the previous 0.85
/// was UNREACHABLE for any conversational capture, so BAND A was dead code — the
/// Stop-hook could never auto-promote even the cleanest, highest-certainty fact
/// (bug 1.1). The narrow [0.72, 0.762] window admits only router-extracted facts
/// whose model self-score is ≥ ~0.86, clean, non-decision, non-architecture.
/// Explicit code-location captures (`capture-symbols.js` emits confidence 0.95)
/// still clear it. Auto-approve stays strictly OPT-IN (default OFF), so this
/// changes nothing until the user enables the toggle. Invariant tested in
/// `capture.rs::factory_threshold_can_auto_approve_top_confidence_capture`.
pub const DEFAULT_AUTO_APPROVE_THRESHOLD: f32 = 0.72;

/// Persisted memory settings. Older files stay readable — serde fills any
/// missing key with its default (so adding fields is backward-compatible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySettings {
    /// When true, CLEAN candidates that clear `auto_approve_threshold` are
    /// auto-approved on creation (see safeguard + 3-band policy). Default false —
    /// auto-approve is strictly opt-in.
    #[serde(default = "default_false")]
    pub auto_approve: bool,
    /// BAND A confidence floor. A clean candidate with `confidence >= threshold`
    /// is auto-approved; `[reject_threshold, threshold)` (or a decision/architecture
    /// kind) stays pending; below `reject_threshold` is auto-rejected. Defaults to
    /// `DEFAULT_AUTO_APPROVE_THRESHOLD` (0.72) for files written before this field.
    #[serde(default = "default_auto_approve_threshold")]
    pub auto_approve_threshold: f32,
    /// 1.3b (opt-in, default OFF): cuando ON, un candidato que es un state-update
    /// 1:1 CLARO de UN item activo lo AUTO-SUPERSEDE (viejo→deprecated,
    /// nuevo→active) en vez de ir al inbox. Requiere el clasificador 3-way; sin el
    /// flag el comportamiento es idéntico al actual (Quarantine).
    #[serde(default = "default_false")]
    pub auto_supersede: bool,
}

fn default_false() -> bool {
    false
}

fn default_auto_approve_threshold() -> f32 {
    DEFAULT_AUTO_APPROVE_THRESHOLD
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            auto_approve: false,
            auto_approve_threshold: DEFAULT_AUTO_APPROVE_THRESHOLD,
            auto_supersede: false,
        }
    }
}

fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/memory-settings.json"))
}

/// Read the persisted memory settings. Any failure (no HOME, missing file,
/// malformed JSON) returns the safe default (`auto_approve = false`).
pub fn read_settings() -> MemorySettings {
    let Some(path) = settings_path() else {
        return MemorySettings::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return MemorySettings::default();
    };
    serde_json::from_str::<MemorySettings>(&text).unwrap_or_default()
}

/// Persist the memory settings atomically (tmp + rename). Creates the cockpit
/// directory if absent. Returns the value actually stored on success.
pub fn write_settings(settings: MemorySettings) -> Result<MemorySettings, String> {
    if !threshold_is_valid(settings.auto_approve_threshold) {
        return Err(format!(
            "auto_approve_threshold fuera de rango: {} (se admite [{REJECT_THRESHOLD}, 1.0])",
            settings.auto_approve_threshold
        ));
    }
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {e}"))?;
        }
    }
    let serialized =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(settings)
}

/// Convenience: is auto-approve currently ON? Fail-safe to `false`.
pub fn auto_approve_enabled() -> bool {
    read_settings().auto_approve
}

/// Convenience: is auto-supersede currently ON? Fail-safe to `false` (1.3b).
/// Opt-in, default OFF — sin esto, una contradicción state-update va al inbox.
pub fn auto_supersede_enabled() -> bool {
    read_settings().auto_supersede
}

/// BAND C floor: a clean candidate below this confidence is pure noise and is
/// auto-rejected (status `rejected`, never promoted, purged in background). Fixed
/// constant (not user-tunable) so the noise gate can't be widened by a bad write.
pub const REJECT_THRESHOLD: f32 = 0.55;

/// ¿Es `t` un suelo de banda A admisible? Solo `[REJECT_THRESHOLD, 1.0]`: un
/// valor por debajo del suelo de ruido (o `0.0`, negativo, `NaN`) metería en
/// la banda A a todo candidato limpio, que es justo lo que la constante fija de
/// `REJECT_THRESHOLD` promete impedir (auditoría 2026-10-26, L9).
#[must_use]
pub fn threshold_is_valid(t: f32) -> bool {
    (REJECT_THRESHOLD..=1.0).contains(&t)
}

/// The three-band decision for a candidate's auto-disposition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoBand {
    /// BAND A: clean + `confidence >= threshold` → promote to active.
    Approve,
    /// BAND B: clean but mid-confidence, OR a decision/architecture kind (always
    /// needs a human eye) → leave pending in the inbox.
    Pending,
    /// BAND C: clean but `confidence < REJECT_THRESHOLD` → auto-reject (noise).
    Reject,
}

/// FAIL-SAFE BAND A floor. Returns the persisted `auto_approve_threshold` when
/// readable; on ANY settings read issue returns `f32::INFINITY`, so nothing can
/// clear BAND A — a settings glitch can never widen auto-approval. (`read_settings`
/// is already default-safe, but a default-filled struct would yield 0.72 here,
/// which is still permissive; an explicit infinity makes the failure mode strict.)
#[must_use]
pub fn auto_approve_threshold() -> f32 {
    let Some(path) = settings_path() else {
        return f32::INFINITY;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return f32::INFINITY;
    };
    threshold_from_settings_json(&text)
}

/// Parte pura de [`auto_approve_threshold`]: el umbral del JSON si es válido;
/// `INFINITY` (banda A cerrada) si no se puede leer o está fuera de rango.
fn threshold_from_settings_json(text: &str) -> f32 {
    match serde_json::from_str::<MemorySettings>(text) {
        Ok(s) if threshold_is_valid(s.auto_approve_threshold) => s.auto_approve_threshold,
        Ok(s) => {
            tracing::warn!(
                "auto_approve_threshold fuera de rango ({}); la banda A queda cerrada",
                s.auto_approve_threshold
            );
            f32::INFINITY
        }
        Err(_) => f32::INFINITY,
    }
}

/// Classify a CLEAN candidate into one of the three auto-disposition bands.
///
/// PRECONDITION: the caller has already confirmed `candidate_is_clean` — secrets
/// and contradictions are handled BEFORE this (they go to quarantine/inbox and
/// must never reach band classification). This function decides only the
/// confidence-driven disposition for clean candidates:
///
///   * BAND A (`Approve`): `confidence >= threshold`.
///   * BAND B (`Pending`): `REJECT_THRESHOLD <= confidence < threshold`.
///   * BAND C (`Reject`): `confidence < REJECT_THRESHOLD` (noise).
///
/// Feedback del usuario 2026-07-02: `decision`/`architecture` ya NO fuerzan Pending —
/// entran por confianza como el resto (el sistema decide solo; cero fricción).
/// La salvaguarda dura sigue intacta: secreto/contradicción/duplicado/unverified
/// NUNCA llegan aquí (no son clean), sea cual sea el tipo.
///
/// Pure (no I/O): the caller passes the fail-safe `threshold`, so this is unit
/// tested without the settings file.
#[must_use]
pub fn classify_band(candidate: &MemoryCandidate, threshold: f32) -> AutoBand {
    if candidate.confidence < REJECT_THRESHOLD {
        AutoBand::Reject
    } else if candidate.confidence >= threshold {
        AutoBand::Approve
    } else {
        AutoBand::Pending
    }
}

/// Tags que marcan que una verificación del write-path NO pudo completarse: el
/// juez de contradicción expiró / su conn falló (`unjudged`), o la búsqueda de
/// duplicados devolvió Err (`dedup-unverified`). FAIL-CLOSED: un candidato así NO
/// es "clean" — sin verdicto verificado espera ojo humano en el inbox, nunca
/// auto-active. (Antes el write-path fallaba OPEN: timeout/Err => sin marca =>
/// `clean` => se auto-aprobaba sin haber comprobado contradicción ni duplicado.)
pub const UNVERIFIED_TAGS: [&str; 2] = ["unjudged", "dedup-unverified"];

/// SECURITY SALVAGUARDA. A candidate is eligible for auto-approval ONLY when it
/// is "clean": no secret marker, no contradiction findings, NO duplicate, and no
/// INCOMPLETE-VERIFICATION marker (see `UNVERIFIED_TAGS`). Secret-bearing,
/// contradicting, DUPLICATE or UNVERIFIED candidates ALWAYS require human review —
/// this returns `false` for them regardless of the `auto_approve` setting. Pure
/// (no I/O) so it is unit-tested without the DB.
#[must_use]
pub fn candidate_is_clean(candidate: &MemoryCandidate) -> bool {
    let is_secret = candidate
        .risk_level
        .eq_ignore_ascii_case(SECRET_RISK_MARKER);
    let has_contradiction = !candidate.contradiction_candidates.is_empty();
    // 1.2: un candidato con duplicados NO es "clean" -> nunca auto-aprobar ni
    // approve-clean un duplicado (asi se acumularon 101 grupos content_hash
    // identicos, uno con 211 copias activas que sesgaban el recall). Va al inbox.
    let has_duplicate = !candidate.duplicate_candidates.is_empty();
    // 1.7 fail-closed: una verificación incompleta (juez timeout / dedup Err) NO
    // puede auto-aprobarse — el candidato espera adjudicación humana en el inbox.
    let has_unverified = candidate_is_unverified(candidate);
    // Gate de origen (2026-09-07, relajado 2026-09-22): una captura de sesión
    // cuyo origen NO CONSTA tampoco es "clean" — así el auto-approve EN LA
    // CREACIÓN y el drain clásico la dejan en el inbox igual que el drain
    // full-auto. Ver `candidate_origin_allows_auto` para la política.
    let unknown_origin = !candidate_origin_allows_auto(candidate);
    !is_secret && !has_contradiction && !has_duplicate && !has_unverified && !unknown_origin
}

/// True cuando el candidato lleva algún marcador de verificación incompleta
/// (`UNVERIFIED_TAGS`). Extraído de `candidate_is_clean` para que el drain
/// full-auto pueda re-verificar exactamente estos.
#[must_use]
pub fn candidate_is_unverified(candidate: &MemoryCandidate) -> bool {
    candidate
        .proposed_tags
        .iter()
        .any(|t| UNVERIFIED_TAGS.iter().any(|u| t.eq_ignore_ascii_case(u)))
}

/// Por qué el drain full-auto rechaza un candidato (razón auditable en la
/// tabla de candidatos; nada se borra).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectKind {
    /// PII/credencial detectada en el write-path: NUNCA a active, ni en auto.
    Secret,
    /// Near-dup de un item ACTIVE: el existente se conserva, el nuevo sobra.
    Duplicate,
    /// Contradice un ACTIVE y el auto-supersede de captura no lo resolvió como
    /// state-update claro: en full-auto gana el ACTIVE (conservador).
    Contradiction,
    /// Banda C: `confidence < REJECT_THRESHOLD` (ruido).
    Noise,
    /// Captura de sesión de origen no humano que lleva al menos
    /// `NON_USER_ORIGIN_TTL_DAYS` pendiente sin que nadie la valide.
    ExpiredNonUserOrigin,
}

/// Días que una captura `KeepNonUserOrigin` puede esperar validación humana
/// antes de que el drain full-auto la rechace (decisión del usuario
/// 2026-10-18: la pestaña de validación se retira, así que sin caducidad se
/// quedarían pending para siempre).
pub const NON_USER_ORIGIN_TTL_DAYS: i64 = 7;

/// Milisegundos por día: `created_at` de los candidatos va en ms Unix.
const MILLIS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

/// True cuando el candidato tiene al menos `NON_USER_ORIGIN_TTL_DAYS` de
/// antigüedad respecto a `now_ms`. Pura: el llamante pasa el reloj.
#[must_use]
pub fn non_user_origin_expired(candidate: &MemoryCandidate, now_ms: i64) -> bool {
    now_ms.saturating_sub(candidate.created_at) >= NON_USER_ORIGIN_TTL_DAYS * MILLIS_PER_DAY
}

/// `auto_disposition` con caducidad: un `KeepNonUserOrigin` con al menos
/// `NON_USER_ORIGIN_TTL_DAYS` pasa a `Reject(ExpiredNonUserOrigin)`; los más
/// recientes siguen pending. El resto de disposiciones no cambia. Es la que
/// debe usar cualquier ruta de drenado full-auto.
#[must_use]
pub fn auto_disposition_at(candidate: &MemoryCandidate, now_ms: i64) -> AutoDisposition {
    match auto_disposition(candidate) {
        AutoDisposition::KeepNonUserOrigin if non_user_origin_expired(candidate, now_ms) => {
            AutoDisposition::Reject(RejectKind::ExpiredNonUserOrigin)
        }
        other => other,
    }
}

/// Disposición FULL-AUTO de un candidato (`inbox drain --auto`).
///
/// (2026-07-13, decisión del usuario: "que no tenga yo que aceptar ni negar
/// nada".) Difiere de las 3 bandas clásicas en dos puntos: la banda B se
/// APRUEBA (no queda pending) y los no-clean se RESUELVEN en vez de esperar
/// ojo humano — secret y ruido se rechazan, duplicados y contradicciones se
/// rechazan conservando el ACTIVE existente. Lo ÚNICO que puede quedar
/// pending es una verificación que sigue sin poder correr tras re-intentarla
/// (infra caída): el fail-closed del write-path NO se relaja ni en modo auto,
/// porque aprobar sin verdicto es exactamente el bug 1.7 que se cerró.
///
/// Precedencia: Secret > Duplicate > Contradiction > Unverified > bandas.
/// Duplicado/contradicción van ANTES que unverified: si el hallazgo ya existe,
/// la verificación que falta solo podría añadir MÁS motivos para no aprobar.
///
/// Pure (no I/O) — unit-testeada sin DB.
#[must_use]
pub fn auto_disposition(candidate: &MemoryCandidate) -> AutoDisposition {
    // (2026-07-13) Probes del harness Kirkardo: material de test que usa el
    // write-path REAL. Jamás a active por la vía auto — así se colaron 33
    // items de test a brain.db (banda A con confidence 0.9 los promovía).
    let is_test_probe = candidate.proposed_project_id.as_deref() == Some("__kirkardo_test__")
        || candidate
            .proposed_tags
            .iter()
            .any(|t| t.eq_ignore_ascii_case("project:__kirkardo_test__"));
    if is_test_probe {
        return AutoDisposition::Reject(RejectKind::Noise);
    }
    if candidate
        .risk_level
        .eq_ignore_ascii_case(SECRET_RISK_MARKER)
    {
        return AutoDisposition::Reject(RejectKind::Secret);
    }
    if !candidate.duplicate_candidates.is_empty() {
        return AutoDisposition::Reject(RejectKind::Duplicate);
    }
    if !candidate.contradiction_candidates.is_empty() {
        return AutoDisposition::Reject(RejectKind::Contradiction);
    }
    if candidate_is_unverified(candidate) {
        return AutoDisposition::KeepUnverified;
    }
    if !candidate_origin_allows_auto(candidate) {
        return AutoDisposition::KeepNonUserOrigin;
    }
    if candidate.confidence < REJECT_THRESHOLD {
        return AutoDisposition::Reject(RejectKind::Noise);
    }
    AutoDisposition::Approve
}

/// ¿Es una captura de sesión (`stop_capture` o con etiqueta `origin:*`)? Los
/// canales estructurales (posttooluse_symbol/arch, lesson-distill…) no hablan
/// por el asistente y no pasan por el gate de origen.
fn is_session_capture(candidate: &MemoryCandidate) -> bool {
    candidate.capture_source.as_deref() == Some("stop_capture")
        || candidate
            .proposed_tags
            .iter()
            .any(|t| t.starts_with("origin:"))
}

/// Política de origen para la vía auto (2026-09-22, decidido por el usuario el
/// 2026-09-21: "el inbox se debería aprobar automáticamente"):
///
///   * `origin:user`      → sí (gate del 2026-09-07, intacto).
///   * `origin:assistant` → sí, PERO solo si además supera el umbral de banda A
///     (lo comprueba `classify_band` / el drain): una captura del asistente
///     entra sola únicamente con confianza alta. Antes quedaba pending siempre y,
///     como el 100 % de la captura real lleva `origin:assistant`, el toggle
///     `auto_approve` no disparaba nunca (medido: 9 candidatos en el inbox con
///     confianza 0,66–0,74 por encima del umbral 0,65, ninguno aprobado).
///   * `origin:unknown` o sin etiqueta → no. Fail-closed: la duda no promociona.
///
/// Las salvaguardas duras (secreto, contradicción, duplicado, unverified y el
/// gate `sin_sustancia` del write-path) se aplican ANTES y no cambian.
#[must_use]
pub fn candidate_origin_allows_auto(candidate: &MemoryCandidate) -> bool {
    if !is_session_capture(candidate) {
        return true;
    }
    candidate.proposed_tags.iter().any(|t| {
        t.eq_ignore_ascii_case("origin:user") || t.eq_ignore_ascii_case("origin:assistant")
    })
}

/// Resultado de `auto_disposition` (ver ahí la política completa).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoDisposition {
    /// Promover a active (bandas A y B: en full-auto la B no espera).
    Approve,
    /// Rechazar con motivo auditable.
    Reject(RejectKind),
    /// Verificación incompleta que no se pudo re-correr: queda pending
    /// (fail-closed intacto incluso en modo auto).
    KeepUnverified,
    /// Captura de sesión que no afirmó el usuario (origen asistente o
    /// desconocido): queda pending hasta validación humana o hasta caducar
    /// (`auto_disposition_at`, `NON_USER_ORIGIN_TTL_DAYS`).
    KeepNonUserOrigin,
}

#[cfg(test)]
#[path = "auto_approve_tests.rs"]
mod tests;
