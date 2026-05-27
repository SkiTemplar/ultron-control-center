//! `ultron-embed` — CLI sidecar for BGE-small-EN-v1.5 embeddings.
//!
//! Reads UTF-8 text from **stdin**, writes a JSON array of 384 `f32` values
//! to **stdout**, and exits.
//!
//! # Usage
//!
//! ```text
//! echo "control-center Rust backend recall" | ultron-embed.exe
//! # → [0.023, -0.041, 0.117, ...]   (384 floats, one line)
//! ```
//!
//! # Exit codes
//!
//! | Code | Meaning |
//! |------|---------|
//! | 0    | Success — JSON array on stdout |
//! | 1    | stdin read error |
//! | 2    | fastembed init or inference error |
//!
//! # Purpose
//!
//! The `session-recall-inject.js` hook runs as a Node.js process and cannot
//! invoke Tauri commands directly. This binary bridges the gap: it reuses the
//! same `fastembed` model path already used by the Tauri backend
//! (`qdrant::embed`), so the ONNX model cache at `~/.cache/fastembed_cache/`
//! is shared and the download only happens once.
//!
//! Build:
//! ```powershell
//! cargo build --release --bin ultron-embed --features qdrant
//! # Output: target/release/ultron-embed.exe
//! ```

use std::io::{self, Read};

fn main() {
    let mut text = String::new();
    if io::stdin().read_to_string(&mut text).is_err() {
        eprintln!("ultron-embed: failed to read stdin");
        std::process::exit(1);
    }

    let text = text.trim();

    // Empty input → return an empty array. The caller (hook) treats [] as
    // "embed unavailable" and falls back to the scroll path.
    if text.is_empty() {
        println!("[]");
        return;
    }

    match control_center_lib::qdrant::embed(text) {
        Ok(v) => {
            // serde_json serialises Vec<f32> as a compact JSON array.
            let json = serde_json::to_string(&v).expect("Vec<f32> is always serialisable");
            println!("{json}");
        }
        Err(e) => {
            eprintln!("ultron-embed: {e}");
            std::process::exit(2);
        }
    }
}
