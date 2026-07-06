#!/usr/bin/env bash
# install-memory-sidecar.sh - build or download the ultron-memory sidecar and
# deploy it to ~/.ultron/bin/ (the path every hook and the Control Center probe).
#
# Order of attempts:
#   1. Destination binary already present          -> skip (unless --force)
#   2. Download prebuilt asset from LATEST release -> verify SHA-256, deploy
#      (asset: ultron-memory-linux-x64)
#   3. cargo build --release --bin ultron-memory --features qdrant
#
# Exit codes: 0 = deployed or already present, 1 = all paths failed.
# Failure is NON-fatal for ULTRON: hooks are fail-safe and recall degrades
# to sparse-only (FTS5) until the sidecar exists.
#
# Usage (also invoked by install.sh):
#   scripts/install-memory-sidecar.sh [--force] [--skip-download] [--skip-build]
#                                     [--dest-dir DIR] [--repo-root DIR]

set -u

FORCE=0
SKIP_DOWNLOAD=0
SKIP_BUILD=0
DEST_DIR=""
REPO_ROOT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --force)         FORCE=1 ;;
        --skip-download) SKIP_DOWNLOAD=1 ;;
        --skip-build)    SKIP_BUILD=1 ;;
        --dest-dir)      DEST_DIR="$2"; shift ;;
        --repo-root)     REPO_ROOT="$2"; shift ;;
        *) echo "[sidecar] unknown flag: $1" >&2; exit 2 ;;
    esac
    shift
done

say()  { echo "[sidecar] $*"; }
warn() { echo "[sidecar] WARN $*" >&2; }

if [ -z "$REPO_ROOT" ]; then
    REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
if [ -z "$DEST_DIR" ]; then
    DEST_DIR="$HOME/.ultron/bin"
fi
DEST_BIN="$DEST_DIR/ultron-memory"

# --- 1. already present -------------------------------------------------
if [ -x "$DEST_BIN" ] && [ "$FORCE" -eq 0 ]; then
    say "already present: $DEST_BIN (use --force to replace)"
    exit 0
fi
mkdir -p "$DEST_DIR"

# --- 2. download prebuilt release asset ----------------------------------
if [ "$SKIP_DOWNLOAD" -eq 0 ]; then
    ASSET="ultron-memory-linux-x64"
    BASE="https://github.com/SkiTemplar/ultron/releases/latest/download"
    TMP_BIN="$(mktemp)"
    TMP_SHA="$(mktemp)"
    say "trying prebuilt asset $ASSET from latest release..."
    if curl -fsSL --max-time 180 -o "$TMP_BIN" "$BASE/$ASSET" \
       && curl -fsSL --max-time 60 -o "$TMP_SHA" "$BASE/$ASSET.sha256"; then
        EXPECTED="$(awk '{print tolower($1)}' "$TMP_SHA")"
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL="$(sha256sum "$TMP_BIN" | awk '{print tolower($1)}')"
        else
            ACTUAL="$(shasum -a 256 "$TMP_BIN" | awk '{print tolower($1)}')"
        fi
        if [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ]; then
            install -m 755 "$TMP_BIN" "$DEST_BIN"
            rm -f "$TMP_BIN" "$TMP_SHA"
            say "deployed prebuilt sidecar -> $DEST_BIN (SHA256 verified)"
            exit 0
        fi
        warn "SHA256 mismatch (expected $EXPECTED, got $ACTUAL) - discarding download"
    else
        warn "prebuilt download unavailable - falling back to local build"
    fi
    rm -f "$TMP_BIN" "$TMP_SHA"
fi

# --- 3. cargo build fallback ---------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
    warn "--skip-build set and download failed. Sidecar NOT installed; recall stays sparse-only."
    exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
    warn "cargo not on PATH. Install Rust (rustup) and re-run, or wait for a published release asset."
    exit 1
fi
CRATE_DIR="$REPO_ROOT/control-center/src-tauri"
if [ ! -f "$CRATE_DIR/Cargo.toml" ]; then
    warn "crate not found at $CRATE_DIR - wrong --repo-root?"
    exit 1
fi
say "building ultron-memory from source (first build downloads the ONNX runtime; can take several minutes)..."
if ! (cd "$CRATE_DIR" && cargo build --release --bin ultron-memory --features qdrant); then
    warn "build failed"
    exit 1
fi
BUILT="$CRATE_DIR/target/release/ultron-memory"
if [ ! -f "$BUILT" ]; then
    warn "build reported success but $BUILT is missing"
    exit 1
fi
install -m 755 "$BUILT" "$DEST_BIN"
say "built and deployed -> $DEST_BIN"
exit 0
