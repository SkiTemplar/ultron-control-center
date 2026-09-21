// ULTRON Control Center — Logs tab backend.
//
// Surfaces curated log sources the user actually cares about, with bounded
// tailing so the panel never reads gigabytes. Sources are read-only from
// the UI's perspective; mutation lives in the producer scripts.
