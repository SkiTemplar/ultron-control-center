// commands/memory — Memory domain command wrappers
//
// Groups all memory-subsystem Tauri commands:
//   recall        — Last-session recall (per-project + global)
//   memory_graph  — Unified search + tree snapshot across all layers (lógica conservada, comandos Tauri des-registrados para Fase 3)
//
// Retirados (wave2-mem0-ecc, 2026-06-06):
//   mem0          — Mem0 cloud memory CRUD + diagnostics
//   kg            — Local knowledge-graph editor (comandos Tauri; lógica en src/kg.rs conservada)
//   ecc_memory    — ECC graph reader (read-only display)
//   memory_status — Memory tab status cards + sync/index ops

pub mod catalog;
pub mod inbox;
pub mod memory_graph;
pub mod migrate;
pub mod recall;
pub mod recall_hybrid;
pub mod recall_unified;
pub mod session_resume;

pub use catalog::*;
pub use inbox::*;
pub use memory_graph::*;
pub use migrate::*;
pub use recall::*;
pub use recall_hybrid::*;
pub use recall_unified::*;
pub use session_resume::*;
