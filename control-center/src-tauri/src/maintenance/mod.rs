// ULTRON Control Center — one-shot maintenance commands surfaced as
// buttons in the Dashboard. Each kind in the whitelist below maps to a
// specific cockpit script with hardcoded args. Frontend never injects
// raw arguments — it only passes the `kind` string.
//
// We invoke via std::process::Command (not the Tauri shell plugin) so
// the capability ACL is irrelevant. CREATE_NO_WINDOW keeps console
// flashes off the user's screen.
//
// Sub-modules:
//   commands  — MaintenanceCommand catalogue + build_cmd dispatch table
//   lifecycle — run_app_lifecycle_inner (Windows PowerShell lifecycle)
//   runner    — MaintenanceResult + run_maintenance_inner + run_backup_now_inner

mod commands;
mod lifecycle;
mod runner;

pub use commands::{list_maintenance_commands_inner, MaintenanceCommand};
pub use lifecycle::run_app_lifecycle_inner;
pub use runner::{run_backup_now_inner, run_maintenance_inner, MaintenanceResult};
