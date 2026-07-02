//! Candidate-inbox governance from the CLI. Mirrors the Tauri `memory_inbox_*`
//! commands (commands/memory/inbox.rs) so the inbox can be drained without a
//! running app — useful for headless maintenance and hook-driven cleanup.

use control_center_lib as ul;

pub(crate) fn inbox_command(sub: &str, args: &[String]) -> Result<serde_json::Value, String> {
    use ul::memory::{auto_approve, Actor, MemoryService};

    match sub {
        // Read-only: how many candidates wait, and how many are clean.
        "list" => {
            let pending =
                MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;
            let clean = pending
                .iter()
                .filter(|c| auto_approve::candidate_is_clean(c))
                .count();
            Ok(serde_json::json!({
                "pending": pending.len(),
                "clean": clean,
                "flagged": pending.len() - clean,
            }))
        }
        // Drain the inbox. `approve-clean` skips secrets/contradictions (same
        // safeguard as the auto-approve hook); `approve-all` promotes everything.
        "approve-clean" | "approve-all" => {
            let clean_only = sub == "approve-clean";
            let pending =
                MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;
            let mut approved = 0u32;
            let mut skipped = 0u32;
            let mut failed = 0u32;
            for cand in pending {
                if clean_only && !auto_approve::candidate_is_clean(&cand) {
                    skipped += 1;
                    continue;
                }
                match MemoryService::approve_candidate(&cand.id, Actor::User) {
                    Ok(_) => approved += 1,
                    Err(_) => failed += 1,
                }
            }
            Ok(serde_json::json!({
                "approved": approved,
                "skipped_flagged": skipped,
                "failed": failed,
            }))
        }
        // Persist the auto-approve flag (future CLEAN candidates promote on creation).
        "auto-approve" => {
            let enabled = match args.get(3).map(String::as_str).unwrap_or("") {
                "on" | "true" | "1" => true,
                "off" | "false" | "0" => false,
                "" => return Err("inbox auto-approve requires <on|off>".to_string()),
                other => return Err(format!("invalid auto-approve value '{other}' (use on|off)")),
            };
            let settings = auto_approve::MemorySettings {
                auto_approve: enabled,
                ..auto_approve::read_settings()
            };
            let saved = auto_approve::write_settings(settings)?;
            Ok(serde_json::json!({ "auto_approve": saved.auto_approve }))
        }
        "" => Err(
            "usage: ultron-memory inbox <list|approve-clean|approve-all|auto-approve <on|off>>"
                .to_string(),
        ),
        other => Err(format!("unknown inbox subcommand '{other}'")),
    }
}
