#!/usr/bin/env bash
# bootstrap.sh — ULTRON one-shot installer for Linux (v15.5+)
#
# Run from anywhere on Linux:
#   curl -fsSL https://raw.githubusercontent.com/SkiTemplar/ultron/main/bootstrap.sh | bash
#
# Or download + run:
#   curl -fsSL -o ultron-bootstrap.sh https://raw.githubusercontent.com/SkiTemplar/ultron/main/bootstrap.sh
#   chmod +x ultron-bootstrap.sh
#   ./ultron-bootstrap.sh
#
# What it does (no git clone required):
#   1. Fetches the latest GitHub release for SkiTemplar/ultron.
#   2. Downloads `ultron-system-<ver>.zip` + .sha256, verifies, extracts to ~/.ultron.
#   3. Runs install.sh (which wires skills / agents / hooks / Qdrant).
#   4. Downloads the Linux Tauri artifact (.AppImage preferred, .deb fallback)
#      and installs it to ~/.local/bin + writes a .desktop launcher entry.
#
# Required tools: curl, sha256sum, unzip. jq is preferred but optional —
# the script falls back to grep/sed parsing if jq is missing and pkg manager
# install fails. unzip / jq will be auto-installed via apt / dnf / pacman /
# zypper when missing AND running interactively with sudo available.
#
# Idempotent: re-running upgrades to the latest release. Local edits under
# ~/.ultron-vault and ~/.ultron/plans are preserved (the system ZIP only
# replaces tracked files).

set -euo pipefail

# ─── defaults / flag parsing ────────────────────────────────────────────────
REPO="SkiTemplar/ultron"
INSTALL_DIR="${HOME}/.ultron"
SKIP_INSTALLER=0
DRY_RUN=0

usage() {
    cat <<EOF
Usage: bootstrap.sh [options]

  --repo <owner/name>       GitHub repo to pull releases from (default: ${REPO})
  --install-dir <path>      Where to extract the system ZIP (default: ${INSTALL_DIR})
  --skip-installer          Don't download/install the Control Center desktop app
  --dry-run                 Print planned actions, don't touch the disk
  -h, --help                This message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)            REPO="$2"; shift 2 ;;
        --install-dir)     INSTALL_DIR="$2"; shift 2 ;;
        --skip-installer)  SKIP_INSTALLER=1; shift ;;
        --dry-run)         DRY_RUN=1; shift ;;
        -h|--help)         usage; exit 0 ;;
        *) echo "Unknown flag: $1" >&2; usage; exit 64 ;;
    esac
done

# ─── pretty logging ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    C_CYAN=$'\033[36m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'
    C_GRN=$'\033[32m'; C_RST=$'\033[0m'
else
    C_CYAN=""; C_YEL=""; C_RED=""; C_GRN=""; C_RST=""
fi
step() { printf "%s[ULTRON-BOOT]%s %s\n" "$C_CYAN" "$C_RST" "$*"; }
warn() { printf "%s[ULTRON-BOOT][warn]%s %s\n" "$C_YEL" "$C_RST" "$*"; }
err()  { printf "%s[ULTRON-BOOT][error]%s %s\n" "$C_RED" "$C_RST" "$*" >&2; }

# ─── error trap ─────────────────────────────────────────────────────────────
on_err() {
    local exit_code=$?
    err "bootstrap.sh failed at line $1 (exit ${exit_code})"
    err "Re-run with --dry-run to inspect planned actions, or open an issue at https://github.com/${REPO}/issues"
    exit "$exit_code"
}
trap 'on_err $LINENO' ERR

# ─── safety guards ──────────────────────────────────────────────────────────
if [[ "${EUID}" -eq 0 ]]; then
    err "Refusing to run as root. ULTRON installs into \$HOME — run as your normal user."
    exit 1
fi

# WSL guard (mirror install.sh behaviour)
if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
    warn "WSL detected. ULTRON Linux installer is for native Linux desktops."
    warn "On WSL the AppImage / .deb / .desktop entry will not surface in the Windows Start menu."
    warn "Prefer running bootstrap.ps1 from native Windows PowerShell instead."
    warn "Continuing in 5 seconds — Ctrl-C to abort."
    sleep 5
fi

# ─── tool checks / install helpers ──────────────────────────────────────────
detect_pkg() {
    if   command -v apt-get >/dev/null 2>&1; then echo "apt"
    elif command -v dnf     >/dev/null 2>&1; then echo "dnf"
    elif command -v pacman  >/dev/null 2>&1; then echo "pacman"
    elif command -v zypper  >/dev/null 2>&1; then echo "zypper"
    else echo "none"; fi
}

pkg_install() {
    # $1 = package name
    local pkg="$1"
    local mgr; mgr="$(detect_pkg)"
    if [[ "$mgr" == "none" ]]; then
        err "No supported package manager (apt/dnf/pacman/zypper) found. Install '$pkg' manually and re-run."
        return 1
    fi
    if ! command -v sudo >/dev/null 2>&1; then
        err "sudo not available; install '$pkg' manually and re-run."
        return 1
    fi
    step "Installing missing dep '$pkg' via $mgr (sudo may prompt)"
    case "$mgr" in
        apt)    sudo apt-get update -qq && sudo apt-get install -y "$pkg" ;;
        dnf)    sudo dnf install -y "$pkg" ;;
        pacman) sudo pacman -Sy --noconfirm "$pkg" ;;
        zypper) sudo zypper install -y "$pkg" ;;
    esac
}

require_tool() {
    # $1 = command, $2 = package name (may differ), $3 = optional fail-soft flag (0=hard, 1=soft)
    local cmd="$1" pkg="$2" soft="${3:-0}"
    if command -v "$cmd" >/dev/null 2>&1; then return 0; fi
    if pkg_install "$pkg"; then
        if command -v "$cmd" >/dev/null 2>&1; then return 0; fi
    fi
    if [[ "$soft" == "1" ]]; then
        warn "'$cmd' unavailable after install attempt — using fallback."
        return 1
    fi
    err "'$cmd' required and could not be installed. Aborting."
    exit 2
}

step "Repo: $REPO"
step "Install dir: $INSTALL_DIR"

require_tool curl       curl
require_tool sha256sum  coreutils
require_tool unzip      unzip
HAVE_JQ=1
if ! command -v jq >/dev/null 2>&1; then
    if ! pkg_install jq; then HAVE_JQ=0; fi
    command -v jq >/dev/null 2>&1 || HAVE_JQ=0
fi

# ─── 1. resolve latest release ──────────────────────────────────────────────
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
step "Fetching latest release manifest from $API_URL"

RELEASE_JSON="$(curl -fsSL -H 'User-Agent: ultron-bootstrap' "$API_URL")" || {
    err "Failed to fetch latest release manifest from $API_URL"
    exit 2
}

if [[ "$HAVE_JQ" -eq 1 ]]; then
    TAG="$(printf '%s' "$RELEASE_JSON" | jq -r '.tag_name // empty')"
else
    # Fallback parse: first "tag_name": "..."
    TAG="$(printf '%s' "$RELEASE_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
fi
[[ -n "${TAG:-}" ]] || { err "Could not resolve release tag from manifest."; exit 2; }
step "Latest tag: $TAG"

EXPECTED_ZIP="ultron-system-${TAG}.zip"

# Resolve asset URLs. jq path is strict; fallback uses grep over the JSON.
asset_url() {
    local name="$1"
    if [[ "$HAVE_JQ" -eq 1 ]]; then
        printf '%s' "$RELEASE_JSON" | jq -r --arg n "$name" \
            '.assets[] | select(.name == $n) | .browser_download_url' \
            | head -n1
    else
        # Heuristic: locate the asset block by name, then the next browser_download_url.
        printf '%s' "$RELEASE_JSON" \
            | tr -d '\n' \
            | grep -oE "\"name\"[[:space:]]*:[[:space:]]*\"${name//./\\.}\"[^}]*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" \
            | head -n1 \
            | sed -E 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
    fi
}

asset_url_match() {
    # Returns ALL matching URLs whose name matches the extended regex in $1.
    local re="$1"
    if [[ "$HAVE_JQ" -eq 1 ]]; then
        printf '%s' "$RELEASE_JSON" | jq -r --arg re "$re" \
            '.assets[] | select(.name | test($re)) | .browser_download_url'
    else
        # Fallback: list all asset name/url pairs, filter with grep -E.
        printf '%s' "$RELEASE_JSON" \
            | tr -d '\n' \
            | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"[^}]*"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
            | while read -r block; do
                name="$(echo "$block" | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
                url="$(echo "$block"  | sed -E 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
                if [[ "$name" =~ $re ]]; then printf '%s\n' "$url"; fi
            done
    fi
}

SYS_URL="$(asset_url "$EXPECTED_ZIP")"
SHA_URL="$(asset_url "${EXPECTED_ZIP}.sha256")"

# 2. validate system ZIP asset exists
if [[ -z "${SYS_URL:-}" ]]; then
    err "Release $TAG does not include the expected asset '$EXPECTED_ZIP'. Cannot bootstrap."
    exit 3
fi

# Linux artifact: prefer AppImage, fallback to .deb
APPIMAGE_URL="$(asset_url_match '\.AppImage$' | head -n1 || true)"
DEB_URL="$(asset_url_match '\.deb$' | head -n1 || true)"

if [[ "$SKIP_INSTALLER" -eq 0 && -z "${APPIMAGE_URL:-}" && -z "${DEB_URL:-}" ]]; then
    warn "Release $TAG has no .AppImage or .deb — system layer only will be installed."
    warn "Re-run with --skip-installer to suppress this warning, or wait for a Linux build."
fi

# ─── 3. download system ZIP + verify SHA ────────────────────────────────────
TMP_DIR="$(mktemp -d -t ultron-bootstrap-XXXXXX)"
ZIP_PATH="${TMP_DIR}/${EXPECTED_ZIP}"
SHA_PATH="${TMP_DIR}/${EXPECTED_ZIP}.sha256"

cleanup() { rm -rf "$TMP_DIR" 2>/dev/null || true; }
trap 'cleanup; on_err $LINENO' ERR
trap cleanup EXIT

step "Downloading system ZIP -> $ZIP_PATH"
if [[ "$DRY_RUN" -eq 0 ]]; then
    curl -fsSL -o "$ZIP_PATH" "$SYS_URL"
fi

if [[ -n "${SHA_URL:-}" && "$DRY_RUN" -eq 0 ]]; then
    step "Fetching ${EXPECTED_ZIP}.sha256 for integrity check"
    curl -fsSL -o "$SHA_PATH" "$SHA_URL"
    # Normalise to "<sha>  <filename>" with the actual local filename so
    # `sha256sum -c` is happy regardless of the manifest's filename column.
    EXPECTED_SHA="$(awk '{print tolower($1)}' "$SHA_PATH" | head -n1)"
    [[ -n "$EXPECTED_SHA" ]] || { err "Could not parse sha256 manifest."; exit 5; }
    printf '%s  %s\n' "$EXPECTED_SHA" "$(basename "$ZIP_PATH")" > "${SHA_PATH}.normalized"
    if (cd "$TMP_DIR" && sha256sum -c "${SHA_PATH}.normalized" >/dev/null 2>&1); then
        step "SHA256 verified: $EXPECTED_SHA"
    else
        ACTUAL_SHA="$(sha256sum "$ZIP_PATH" | awk '{print tolower($1)}')"
        err "SHA256 mismatch — ZIP corrupt or tampered."
        err "  expected: $EXPECTED_SHA"
        err "  actual:   $ACTUAL_SHA"
        exit 5
    fi
elif [[ -z "${SHA_URL:-}" ]]; then
    warn "Release $TAG does not include ${EXPECTED_ZIP}.sha256 — proceeding WITHOUT integrity check."
fi

# ─── 4. extract over INSTALL_DIR ────────────────────────────────────────────
if [[ ! -d "$INSTALL_DIR" ]]; then
    step "Creating $INSTALL_DIR"
    [[ "$DRY_RUN" -eq 0 ]] && mkdir -p "$INSTALL_DIR"
fi
step "Extracting to $INSTALL_DIR"
if [[ "$DRY_RUN" -eq 0 ]]; then
    unzip -oq "$ZIP_PATH" -d "$INSTALL_DIR"
fi

# ─── 5. run install.sh ──────────────────────────────────────────────────────
INSTALL_SCRIPT="${INSTALL_DIR}/install.sh"
if [[ ! -f "$INSTALL_SCRIPT" ]]; then
    err "install.sh missing after extract: $INSTALL_SCRIPT"
    exit 4
fi

step "Running install.sh (skills + agents + hooks wiring)"
if [[ "$DRY_RUN" -eq 0 ]]; then
    chmod +x "$INSTALL_SCRIPT" 2>/dev/null || true
    if ! bash "$INSTALL_SCRIPT"; then
        rc=$?
        err "install.sh exited with code $rc. Bootstrap aborted."
        err "Investigate the log above; fix the issue; re-run bootstrap.sh."
        exit "$rc"
    fi
fi

# ─── 6. download + install Tauri Linux artifact ─────────────────────────────
INSTALLED_APP_PATH=""
INSTALL_NOTE=""

if [[ "$SKIP_INSTALLER" -eq 1 ]]; then
    step "Skipping Control Center installer (--skip-installer)."
elif [[ -n "${APPIMAGE_URL:-}" ]]; then
    APPIMAGE_NAME="$(basename "$APPIMAGE_URL")"
    APPIMAGE_TMP="${TMP_DIR}/${APPIMAGE_NAME}"
    BIN_DIR="${HOME}/.local/bin"
    APPIMAGE_DEST="${BIN_DIR}/ultron-control-center"

    step "Downloading Control Center AppImage -> $APPIMAGE_TMP"
    if [[ "$DRY_RUN" -eq 0 ]]; then
        curl -fsSL -o "$APPIMAGE_TMP" "$APPIMAGE_URL"
        mkdir -p "$BIN_DIR"
        # Preserve any previous AppImage as .bak so a broken upgrade is recoverable.
        if [[ -f "$APPIMAGE_DEST" ]]; then
            mv -f "$APPIMAGE_DEST" "${APPIMAGE_DEST}.bak"
        fi
        mv -f "$APPIMAGE_TMP" "$APPIMAGE_DEST"
        chmod +x "$APPIMAGE_DEST"
    fi
    INSTALLED_APP_PATH="$APPIMAGE_DEST"

    # 7. .desktop launcher entry (AppImage path only)
    DESKTOP_DIR="${HOME}/.local/share/applications"
    DESKTOP_FILE="${DESKTOP_DIR}/ultron-control-center.desktop"
    step "Writing launcher entry -> $DESKTOP_FILE"
    if [[ "$DRY_RUN" -eq 0 ]]; then
        mkdir -p "$DESKTOP_DIR"
        cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ULTRON Control Center
Comment=ULTRON Control Center desktop app
Exec=${APPIMAGE_DEST}
Icon=ultron-control-center
Terminal=false
Categories=Development;Utility;
StartupWMClass=ultron-control-center
DESKTOP
        # Best-effort cache refresh; not fatal if absent.
        if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
        fi
    fi

    # Friendly reminder if ~/.local/bin is not on PATH.
    case ":${PATH}:" in
        *":${BIN_DIR}:"*) : ;;
        *) warn "${BIN_DIR} is not on PATH — add it to your shell rc to run 'ultron-control-center' from the terminal." ;;
    esac
elif [[ -n "${DEB_URL:-}" ]]; then
    DEB_NAME="$(basename "$DEB_URL")"
    DEB_DEST="${HOME}/Downloads/${DEB_NAME}"
    step "No AppImage available; downloading .deb fallback -> $DEB_DEST"
    if [[ "$DRY_RUN" -eq 0 ]]; then
        mkdir -p "$(dirname "$DEB_DEST")"
        curl -fsSL -o "$DEB_DEST" "$DEB_URL"
    fi
    INSTALLED_APP_PATH="$DEB_DEST"
    INSTALL_NOTE="The .deb was downloaded but NOT installed. Run: sudo dpkg -i \"${DEB_DEST}\" (then 'sudo apt-get -f install' to fix any missing deps)."
else
    step "No Linux desktop artifact in this release."
fi

# ─── done ───────────────────────────────────────────────────────────────────
echo ""
printf "%s[ULTRON-BOOT] Done.%s\n" "$C_GRN" "$C_RST"
printf "%s  System:%s        %s\n" "$C_GRN" "$C_RST" "$INSTALL_DIR"
if [[ -n "$INSTALLED_APP_PATH" ]]; then
    printf "%s  Control Center:%s %s\n" "$C_GRN" "$C_RST" "$INSTALLED_APP_PATH"
fi
if [[ -n "$INSTALL_NOTE" ]]; then
    printf "%s  Note:%s          %s\n" "$C_YEL" "$C_RST" "$INSTALL_NOTE"
fi
