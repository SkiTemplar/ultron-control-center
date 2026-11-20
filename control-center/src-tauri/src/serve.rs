//! Persistent localhost daemon for the memory orchestrator (`ultron-memory serve`).
//!
//! WHY: nació (2026-06) para mantener residente el modelo de embeddings que cada
//! `ultron-memory orchestrate` one-shot recargaba en cada prompt. Desde el
//! 2026-11-14 no hay ruta densa ni modelos: el daemon ahorra el arranque del
//! proceso y sirve `orchestrate`/`recall` (FTS5 sobre brain.db) y los jueces LLM
//! (`skill_judge`, `lesson_distill`, `profile_distill`). It changes NO
//! semantics: SQLite connections are opened per request exactly as in the CLI.
//!
//! TRANSPORT: line-delimited JSON over TCP on `127.0.0.1` (loopback only), zero new
//! dependencies (std::net + serde_json). A dynamic port (bind `:0`) + a per-launch
//! token are published in `~/.ultron/run/orchestrate.json`. The token is anti-
//! accident, NOT crypto: loopback is the real boundary (no remote can reach it).
//!
//! CICLO DE VIDA: lo arranca DESACOPLADO un hook (`ultron-memory serve`).
//! Sale por una petición `shutdown` explícita y, solo si se configura una ventana
//! de inactividad (`ULTRON_DAEMON_IDLE_MIN`, ver `DAEMON_IDLE_MIN_DEFAULT`), tras
//! ese tiempo sin tráfico. Por defecto el proceso es RESIDENTE. El cliente
//! siempre hace `ping` antes de fiarse del lockfile, de modo que un lockfile
//! obsoleto (tras un crash) degrada al camino de spawn.
//!
//! ESTRUCTURA (troceado 2026-09-10, cat7.3 — antes 1.053 líneas en un fichero):
//! - `lockfile`: descubrimiento y propiedad (claim atómico, ping, retirada).
//! - `protocol`: la petición JSON y el handler puro que la resuelve.
//! - (`concurrency` se retiró el 2026-09-27: las conexiones se atienden todas a
//!   la vez, cada una en su hilo.)
//! - `watchdog`: guard de huérfano.
//! - `request_log`: la traza JSONL de cada petición servida.
//! - `tcp`: arranque del daemon y bucle de aceptación.
//!
//! El troceo no cambió ni un comportamiento ni un contrato JSON: es el mismo
//! código repartido.

mod lockfile;
mod protocol;
mod request_log;
mod tcp;
mod watchdog;

pub use lockfile::ping_status;
pub use tcp::run_daemon;
