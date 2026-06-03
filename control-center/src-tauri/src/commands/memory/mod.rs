// commands/memory — Memory domain command wrappers
//
// Groups all memory-subsystem Tauri commands:
//   mem0          — Mem0 cloud memory CRUD + diagnostics
//   kg            — Local knowledge-graph editor
//   ecc_memory    — ECC graph reader (read-only display)
//   recall        — Last-session recall (per-project + global)
//   memory_status — Memory tab status cards + sync/index ops
//   memory_graph  — Unified search + tree snapshot across all layers

pub mod ecc_memory;
pub mod inbox;
pub mod kg;
pub mod mem0;
pub mod memory_graph;
pub mod memory_status;
pub mod migrate;
pub mod recall;
pub mod recall_hybrid;
pub mod recall_unified;

pub use ecc_memory::*;
pub use inbox::*;
pub use kg::*;
pub use mem0::*;
pub use memory_graph::*;
pub use memory_status::*;
pub use migrate::*;
pub use recall::*;
pub use recall_hybrid::*;
pub use recall_unified::*;
