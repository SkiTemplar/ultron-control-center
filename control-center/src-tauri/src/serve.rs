//! Persistent localhost daemon for the memory orchestrator (`ultron-memory serve`).
//!
//! WHY: each `ultron-memory orchestrate` invocation is a fresh OS process, so the
//! global `E5_MODEL` `OnceCell` (multilingual-e5-large, ~1.3 GB ONNX) is re-loaded
//! from scratch on every prompt. Measured cost: orchestrate cold = 3.1–4.8 s, of
//! which ~1.8 s is just the model init. The UserPromptSubmit hook therefore pays
//! 3–5 s BEFORE every assistant turn — the #1 latency cost of the whole system.
//!
//! FIX: a long-lived process keeps that `OnceCell` resident. The hot path becomes
//! 3 warm embeds + 3 Qdrant loopback searches + FTS5/SQLite — sub-second. The
//! daemon changes NO semantics: SQLite connections and the Qdrant HTTP client are
//! still opened per request exactly as before; the only shared warm state is the
//! E5 model that already lived in a process-global `OnceCell`.
//!
//! TRANSPORT: line-delimited JSON over TCP on `127.0.0.1` (loopback only), zero new
//! dependencies (std::net + serde_json). A dynamic port (bind `:0`) + a per-launch
//! token are published in `~/.ultron/run/orchestrate.json`. The token is anti-
//! accident, NOT crypto: loopback is the real boundary (no remote can reach it).
//!
//! CICLO DE VIDA: lo arranca DESACOPLADO el hook `memory-warmup` de SessionStart.
//! Sale por una petición `shutdown` explícita y, solo si se configura una ventana
//! de inactividad (`ULTRON_DAEMON_IDLE_MIN`, ver `DAEMON_IDLE_MIN_DEFAULT`), tras
//! ese tiempo sin tráfico. Por defecto el proceso es RESIDENTE: los modelos ya se
//! sueltan solos por inactividad, así que el daemon parado cuesta ~40 MB. El
//! cliente siempre hace `ping` antes de fiarse del lockfile, de modo que un
//! lockfile obsoleto (tras un crash) degrada al camino de spawn.
//!
//! ESTRUCTURA (troceado 2026-09-10, cat7.3 — antes 1.053 líneas en un fichero):
//! - `lockfile`: descubrimiento y propiedad (claim atómico, ping, retirada).
//! - `protocol`: la petición JSON y el handler puro que la resuelve.
//! - `concurrency`: semáforo de las peticiones que embeben contra E5.
//! - `watchdog`: liberación de modelos por inactividad y guard de huérfano.
//! - `request_log`: la traza JSONL de cada petición servida.
//! - `tcp`: arranque del daemon y bucle de aceptación.
//!
//! El troceo no cambió ni un comportamiento ni un contrato JSON: es el mismo
//! código repartido.

mod concurrency;
mod lockfile;
mod protocol;
mod request_log;
mod tcp;
mod watchdog;

pub use lockfile::ping_status;
pub use tcp::run_daemon;
