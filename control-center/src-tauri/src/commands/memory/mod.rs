// commands/memory — Memory domain command wrappers
//
// Groups all memory-subsystem Tauri commands:
//   memory_graph  — Unified search + tree snapshot across all layers (lógica conservada, comandos Tauri des-registrados para Fase 3)
//
// Retirados (wave2, 2026-06-06):
//   kg            — Local knowledge-graph editor (comandos Tauri; lógica en src/kg.rs conservada)
//   ecc_memory    — ECC graph reader (read-only display)
//   memory_status — Memory tab status cards + sync/index ops
//
// recall, recall_last_session, recall_last_session_global: des-registrados (cat10,
//   2026-06-19); el modulo muerto crate::recall y su placeholder se eliminaron (2026-06-22).

pub mod catalog;
pub mod inbox;
pub mod kanban_signal;
pub mod memory_graph;
pub mod migrate;
pub mod recall_hybrid;
pub mod recall_unified;
pub mod session_resume;

pub use catalog::*;
pub use inbox::*;
pub use memory_graph::*;
pub use migrate::*;
pub use recall_hybrid::*;
pub use recall_unified::*;
pub use session_resume::*;
