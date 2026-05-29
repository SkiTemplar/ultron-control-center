//! Shared test-fixture helpers (card-test-fixtures-rust-infra).
//!
//! Convention (matches the pre-existing recall.rs fixtures): fixtures live under
//! `src/tests/fixtures/<module>/<name>` relative to `CARGO_MANIFEST_DIR`. This
//! module is `#[cfg(test)]`-only (declared as such in lib.rs), so it adds no
//! code to release builds.
//!
//! NOTE: the card originally proposed `src-tauri/tests/fixtures/` + a
//! `tests/common/mod.rs`. That is the *integration-test* layout; this codebase
//! uses in-module unit tests, so we extend the existing unit-test convention
//! instead of introducing a parallel one.

use std::path::PathBuf;

/// Absolute path to `src/tests/fixtures/<module>/<name>`.
pub(crate) fn fixture_path(module: &str, name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("tests")
        .join("fixtures")
        .join(module)
        .join(name)
}

/// Read a fixture file to a String, panicking with a clear message if missing.
pub(crate) fn load_fixture(module: &str, name: &str) -> String {
    let path = fixture_path(module, name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("fixture {module}/{name} ({}): {e}", path.display()))
}
