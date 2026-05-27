// commands/system_ops — System & infrastructure domain command wrappers
//
// Groups:
//   system            — Scheduled tasks, system info
//   apps              — Installed apps list, open folder, uninstall
//   diagnostics_native — Native diagnostics runner, history, schedule
//   event_log         — Windows event log
//   settings          — App settings read/save, backup config, API keys
//   lifecycle         — Auth status, close app

pub mod apps;
pub mod diagnostics_native;
pub mod event_log;
pub mod lifecycle;
pub mod settings;
pub mod system;

pub use apps::*;
pub use diagnostics_native::*;
pub use event_log::*;
pub use lifecycle::*;
pub use settings::*;
pub use system::*;
