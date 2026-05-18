#!/usr/bin/env bash
# =============================================================================
# ULTRON one-shot bootstrap installer — Linux counterpart of install.ps1
# =============================================================================
#
# Mirrors install.ps1 for native Linux hosts (Debian/Ubuntu via apt, Fedora/RHEL
# via dnf, Arch via pacman). WSL is best-effort: ULTRON is designed for native
# Windows / native Linux. zypper/yum/portage are not detected.
#
# Flow (parallel to install.ps1):
#   1.  Preflight       - OS, distro, RAM, disk, internet, refuse-root, WSL warn
#   2.  Dependencies    - curl, git, Node 22+, uv, Rust toolchain, Claude CLI
#   3.  Qdrant native   - download Linux binary tarball, no Docker (per design)
#   4.  Tauri deps      - webkit2gtk-4.1, libsoup-3.0, librsvg2-bin, build-essential
#   5.  Dir layout      - ~/.ultron, ~/.ultron-vault, ~/.claude/{skills,agents}
#   6.  Templates       - CLAUDE.md / SYSTEM-MAP.md / MEMORY.md / cockpit seeds
#   7.  Hooks merge     - templates/settings-hooks.json -> ~/.claude/settings.json
#   8.  Skills + agents - copy templates/skills-manifest.example.yaml entries,
#                         flat-copy repo/agents/*.md -> ~/.claude/agents/
#   9.  Feature flags   - ~/.ultron/cockpit/features.json
#   10. Summary         - lists installed / present / skipped / qdrant path
#
# Re-running is safe: every step detects whether the work is already done and
# skips it. The only destructive choice the script makes is `set -euo pipefail`
# so a non-zero from a critical step aborts the whole run; non-critical steps
# wrap their failures in `|| warn ...`.
#
# Flags:
#   --non-interactive   : default-Y to every prompt (CI / unattended)
#   --no-app            : skip Tauri build deps + Control Center build
#   --no-docker         : skip Qdrant native binary (semantic recall disabled)
#   --verbose           : set -x
#   --install-root DIR  : override ~/.ultron
#   -h | --help         : usage
#
# Requirements: bash >= 4.0, sudo with passwordless system installs OR
# pre-installed deps. Refuses to run as root.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
readonly ULTRON_VERSION="v15.5.15"
readonly QDRANT_VERSION="v1.18.0"
# Native Linux x86_64 tarball from the official qdrant/qdrant GitHub release.
readonly QDRANT_TARBALL="qdrant-x86_64-unknown-linux-gnu.tar.gz"
readonly QDRANT_URL="https://github.com/qdrant/qdrant/releases/download/${QDRANT_VERSION}/${QDRANT_TARBALL}"
# TODO: pin Linux Qdrant SHA — fetch from
#   https://github.com/qdrant/qdrant/releases/tag/v1.18.0
# Override at runtime with:  ULTRON_QDRANT_SHA=<sha256> ./install.sh
# When empty we warn + skip verification (current behaviour, matches the
# zero-check baseline). The verification scaffolding below is wired in
# install_qdrant() so the moment a SHA is supplied, integrity gating is on.
QDRANT_SHA256="${ULTRON_QDRANT_SHA:-}"
readonly NODE_MIN_MAJOR=22

# Resolve the directory this script lives in (the repo root) without relying on
# `realpath` (not present on minimal Alpine). BASH_SOURCE[0] + cd + pwd is the
# portable idiom that works on bash 4.x everywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="${SCRIPT_DIR}"

# ---------------------------------------------------------------------------
# CLI flag parsing (must happen before we read $HOME / refuse-root)
# ---------------------------------------------------------------------------
NON_INTERACTIVE=0
NO_APP=0
NO_DOCKER=0
VERBOSE=0
INSTALL_ROOT_OVERRIDE=""

usage() {
    cat <<EOF
ULTRON installer (Linux) ${ULTRON_VERSION}

Usage: install.sh [flags]

  --non-interactive       Default-Y to every prompt (CI / unattended)
  --no-app                Skip Tauri build deps + Control Center compile
  --no-docker             Skip Qdrant native binary (semantic recall disabled)
  --verbose               Trace shell execution (set -x)
  --install-root DIR      Override install root (default: \$HOME/.ultron)
  -h, --help              Show this message

ULTRON detects apt-get / dnf / pacman in that order. Other package managers
(yum, zypper, portage) are not supported — install dependencies manually and
re-run with --non-interactive if you need to skip the install prompts.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --non-interactive)  NON_INTERACTIVE=1; shift ;;
        --no-app)           NO_APP=1; shift ;;
        --no-docker)        NO_DOCKER=1; shift ;;
        --verbose)          VERBOSE=1; shift ;;
        --install-root)
            if [[ $# -lt 2 ]]; then
                echo "ERROR: --install-root requires a directory argument" >&2
                exit 64
            fi
            INSTALL_ROOT_OVERRIDE="$2"
            shift 2
            ;;
        -h|--help)          usage; exit 0 ;;
        *)                  echo "ERROR: unknown flag '$1'" >&2; usage; exit 64 ;;
    esac
done

if [[ $VERBOSE -eq 1 ]]; then
    set -x
fi

# ---------------------------------------------------------------------------
# Refuse to run as root or without HOME
# ---------------------------------------------------------------------------
# Claude Code, npm global, uv and rustup all expect a user-owned $HOME. Running
# as root creates files only root can edit, which breaks every subsequent
# `claude`, `uv` and `npm i -g` the user runs unprivileged.
if [[ -z "${HOME:-}" ]]; then
    echo "ERROR: \$HOME is unset. Refusing to install — no place to put user files." >&2
    exit 78
fi
if [[ "$(id -u)" -eq 0 ]]; then
    echo "ERROR: do not run install.sh as root." >&2
    echo "       Claude / npm / uv / rustup should own their files as your user." >&2
    echo "       Re-run as a normal user. The script will use sudo only for" >&2
    echo "       system package installs (apt/dnf/pacman)." >&2
    exit 77
fi

readonly INSTALL_ROOT="${INSTALL_ROOT_OVERRIDE:-${HOME}/.ultron}"
readonly VAULT_DIR="${HOME}/.ultron-vault"
readonly CLAUDE_DIR="${HOME}/.claude"

# ---------------------------------------------------------------------------
# Logging + state tracking
# ---------------------------------------------------------------------------
declare -a STEPS_OK=()
declare -a STEPS_SKIPPED=()
declare -a WARNINGS=()
declare -a ERRORS=()
declare -a DEPS_INSTALLED=()   # populated by install_pkg
declare -a DEPS_PRESENT=()     # populated by have_cmd_record

step()  { printf '[ STEP ] %s\n' "$*"; }
ok()    { printf '  ok    %s\n' "$*"; STEPS_OK+=("$*"); }
skip()  { printf '  skip  %s\n' "$*"; STEPS_SKIPPED+=("$*"); }
warn()  { printf '  warn  %s\n' "$*"; WARNINGS+=("$*"); }
fail()  { printf '  fail  %s\n' "$*"; ERRORS+=("$*"); }
info()  { printf '        %s\n' "$*"; }
verb()  { if [[ $VERBOSE -eq 1 ]]; then printf '    .   %s\n' "$*"; fi; }

# Confirm Y/N prompt. $1 = question. $2 = default ("y" or "n"). Honours
# --non-interactive (always returns the default).
confirm() {
    local q="$1" default="${2:-n}" prompt ans
    if [[ $NON_INTERACTIVE -eq 1 ]]; then
        [[ "$default" == "y" ]] && return 0 || return 1
    fi
    if [[ "$default" == "y" ]]; then prompt="Y/n"; else prompt="y/N"; fi
    printf '  %s [%s] ' "$q" "$prompt"
    read -r ans || ans=""
    ans="${ans,,}"   # lowercase (bash 4+)
    case "${ans:-$default}" in
        y|yes) return 0 ;;
        *)     return 1 ;;
    esac
}

# Trap any uncaught error and print where it died. `set -e` is great, but a
# bare 'apt-get install' failure with no context is unfriendly — this gives the
# user a line number and a chance to retry.
on_error() {
    local rc=$? line=$1
    echo ""
    echo "======================================================="
    echo " INSTALL ABORTED at line ${line} (exit ${rc})"
    echo "======================================================="
    echo " The last command failed. Re-run with --verbose to see"
    echo " the full command trace. Common causes:"
    echo "   - missing sudo / wrong password"
    echo "   - no internet (GitHub releases unreachable)"
    echo "   - distro-specific package name differs"
    echo " See INSTALL.md for manual recovery."
    echo "======================================================="
    exit "$rc"
}
trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# have_cmd + book-keeping for the final summary.
have_cmd_record() {
    if have_cmd "$1"; then
        DEPS_PRESENT+=("$1")
        return 0
    fi
    return 1
}

# Detect distro package manager. Sets PKG_MGR to one of: apt, dnf, pacman. Aborts
# if none found.
detect_pkg_mgr() {
    if   have_cmd apt-get;  then PKG_MGR="apt"
    elif have_cmd dnf;      then PKG_MGR="dnf"
    elif have_cmd pacman;   then PKG_MGR="pacman"
    else
        fail "no supported package manager found (need apt-get, dnf or pacman)"
        echo "" >&2
        echo "ULTRON only auto-installs deps on Debian/Ubuntu, Fedora/RHEL and Arch." >&2
        echo "Install the dependencies manually (curl, git, nodejs>=${NODE_MIN_MAJOR})," >&2
        echo "then re-run with --non-interactive to skip the auto-install steps." >&2
        exit 70
    fi
    readonly PKG_MGR
    ok "package manager: ${PKG_MGR}"
}

# Check sudo non-interactively. If sudo prompts for a password we want to know
# now, not 15 minutes into the install. With --non-interactive we treat a
# missing sudo as a hard error; in interactive mode we ask the user to escalate.
SUDO=""
ensure_sudo() {
    if [[ "$(id -u)" -eq 0 ]]; then
        SUDO=""
        return 0
    fi
    if ! have_cmd sudo; then
        fail "sudo not installed but system packages need root"
        info "install sudo (or run as root once for the system pkg install only)"
        exit 77
    fi
    # `sudo -n true` succeeds iff sudo can run without prompting (cached creds
    # or NOPASSWD). If it fails, we ask the user to authenticate now so the
    # rest of the install is non-blocking.
    if sudo -n true >/dev/null 2>&1; then
        SUDO="sudo"
        verb "sudo: passwordless OK"
        return 0
    fi
    if [[ $NON_INTERACTIVE -eq 1 ]]; then
        fail "sudo requires a password but --non-interactive was passed"
        info "either configure NOPASSWD for the installer user, or run interactively"
        exit 77
    fi
    info "sudo will be needed for system package installs. Please authenticate:"
    if sudo -v; then
        SUDO="sudo"
        ok "sudo authenticated"
    else
        fail "sudo authentication failed"
        exit 77
    fi
}

# Install a system package using the detected manager. $@ is one or more
# package names. Idempotent: if any of the listed packages are already
# installed we still ask the manager to install the rest. Logs which deps were
# actually installed vs. already present.
install_pkg() {
    local pkgs=("$@")
    [[ ${#pkgs[@]} -eq 0 ]] && return 0
    case "$PKG_MGR" in
        apt)
            # apt-get update is idempotent but slow; only run it once per install.
            if [[ "${APT_UPDATED:-0}" -ne 1 ]]; then
                verb "apt-get update"
                $SUDO apt-get update -qq || warn "apt-get update returned non-zero (continuing)"
                APT_UPDATED=1
            fi
            $SUDO apt-get install -y --no-install-recommends "${pkgs[@]}"
            ;;
        dnf)
            $SUDO dnf install -y "${pkgs[@]}"
            ;;
        pacman)
            # --needed makes pacman idempotent (skip already-installed packages).
            $SUDO pacman -S --noconfirm --needed "${pkgs[@]}"
            ;;
    esac
    for p in "${pkgs[@]}"; do DEPS_INSTALLED+=("${p} (${PKG_MGR})"); done
}

# ---------------------------------------------------------------------------
# Step 1: preflight
# ---------------------------------------------------------------------------
preflight() {
    step "1. preflight"

    # OS detection — we only run on Linux. /proc/version is a more reliable
    # signal than `uname` since `uname` reports "Linux" on WSL too (which we
    # want to flag, not refuse).
    local kernel; kernel="$(uname -s)"
    if [[ "$kernel" != "Linux" ]]; then
        fail "non-Linux kernel detected: ${kernel}"
        info "Use install.ps1 on Windows or install.sh-macos (not yet shipped) on macOS"
        exit 70
    fi
    ok "Linux host (kernel $(uname -r))"

    # WSL detection. install.ps1 explicitly states ULTRON is designed for
    # native Windows; the mirror promise here is that we're designed for
    # native Linux. WSL works but Tauri's webkit2gtk + Qdrant boot are best-
    # effort. Warn + ask for confirmation in interactive mode.
    if grep -qi -e "microsoft" -e "wsl" /proc/version 2>/dev/null; then
        warn "WSL detected — ULTRON is designed for native Linux, WSL is best-effort"
        info "Known issues: Tauri webkit2gtk render glitches, Qdrant systemd unit"
        info "won't auto-start (use the qdrant binary directly), GUI apps need WSLg."
        if ! confirm "Continue anyway?" "y"; then
            echo "Aborted by user (WSL)." >&2
            exit 130
        fi
    fi

    # Distro detection (informational only; we already picked PKG_MGR).
    if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        verb "distro: ${PRETTY_NAME:-${NAME:-unknown}}"
    fi

    # RAM — warn-only. /proc/meminfo gives kB.
    local mem_kb mem_gb
    mem_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    if [[ "$mem_kb" -gt 0 ]]; then
        mem_gb=$(( mem_kb / 1024 / 1024 ))
        if [[ "$mem_gb" -lt 8 ]]; then
            warn "RAM ${mem_gb} GB (recommended >= 8 GB)"
        else
            ok "RAM ${mem_gb} GB"
        fi
    fi

    # Disk — hard block at <5 GB free on $HOME. df -BG drops the 'G' suffix
    # cleanly with awk substr. POSIX-portable.
    local free_gb
    free_gb="$(df -BG "$HOME" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}')"
    if [[ -n "$free_gb" ]]; then
        if (( free_gb < 5 )); then
            fail "only ${free_gb} GB free on \$HOME — need >= 5 GB"
            exit 28
        fi
        ok "disk ${free_gb} GB free on \$HOME"
    fi

    # Internet — single ping to github.com, warn-only. Some networks block
    # ICMP entirely (corporate VPNs, container hosts); we don't make it fatal.
    if ping -c 1 -W 3 github.com >/dev/null 2>&1; then
        ok "github.com reachable"
    else
        warn "github.com unreachable (ICMP may be blocked — HTTPS downloads might still work)"
    fi
}

# ---------------------------------------------------------------------------
# Step 2: core deps (curl + git)
# ---------------------------------------------------------------------------
install_curl_git() {
    step "2a. curl + git"
    local need=()
    if have_cmd_record curl; then ok "curl present ($(curl --version | head -1))"; else need+=(curl); fi
    if have_cmd_record git;  then ok "git present ($(git --version))"; else need+=(git); fi
    if [[ ${#need[@]} -gt 0 ]]; then
        ensure_sudo
        info "installing: ${need[*]}"
        install_pkg "${need[@]}"
        ok "curl + git ready"
    fi
}

# ---------------------------------------------------------------------------
# Step 3: Node.js >= 22
#
# Distro packages routinely lag (Debian stable ships 18.x). When the system
# Node is too old we install NodeSource's apt/rpm repo, or community/nodejs on
# Arch. We DO NOT use nvm here — install.ps1 uses winget (system-wide); the
# Linux mirror uses the system package manager for symmetry.
# ---------------------------------------------------------------------------
install_node() {
    step "2b. Node.js >= ${NODE_MIN_MAJOR}"
    if have_cmd node; then
        local ver_str major
        ver_str="$(node --version 2>/dev/null)"   # e.g. v22.4.0
        major="${ver_str#v}"; major="${major%%.*}"
        if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge "$NODE_MIN_MAJOR" ]]; then
            DEPS_PRESENT+=("node ${ver_str}")
            ok "node ${ver_str}"
            return 0
        fi
        warn "node ${ver_str} is older than v${NODE_MIN_MAJOR} — upgrading"
    fi

    ensure_sudo
    case "$PKG_MGR" in
        apt)
            # NodeSource setup script registers the deb repo. We pipe to bash
            # under sudo only after curl validated the TLS handshake.
            info "adding NodeSource ${NODE_MIN_MAJOR}.x repo"
            curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | $SUDO bash -
            install_pkg nodejs
            ;;
        dnf)
            # Fedora modular streams: 'dnf module reset nodejs' clears any pin.
            $SUDO dnf module reset -y nodejs 2>/dev/null || true
            $SUDO dnf module enable -y "nodejs:${NODE_MIN_MAJOR}" 2>/dev/null || true
            install_pkg nodejs
            ;;
        pacman)
            install_pkg nodejs npm
            ;;
    esac

    if have_cmd node; then
        ok "node $(node --version) installed"
    else
        fail "node install reported success but binary not on PATH"
        exit 2
    fi
}

# ---------------------------------------------------------------------------
# Step 4: uv (official installer; lands in ~/.local/bin)
#
# We use the official `curl | sh` installer because it's the only path that
# delivers the same version Astral publishes for macOS/Windows on a given day.
# Distro packages lag (Debian stable doesn't ship uv at all as of 2026-05).
# The script is short and well-known; matches install.ps1's winget call.
# ---------------------------------------------------------------------------
install_uv() {
    step "3. uv (Python package manager)"
    # Make sure ~/.local/bin is searchable for the rest of this script,
    # otherwise the post-install `uv --version` probe misses it.
    export PATH="${HOME}/.local/bin:${PATH}"
    if have_cmd uv; then
        DEPS_PRESENT+=("uv $(uv --version 2>/dev/null | head -1)")
        ok "uv $(uv --version 2>/dev/null)"
        return 0
    fi
    info "installing uv via https://astral.sh/uv/install.sh"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # The installer drops uv into ~/.local/bin; re-export PATH so this same
    # shell sees it without rehash.
    export PATH="${HOME}/.local/bin:${PATH}"
    if have_cmd uv; then
        ok "uv $(uv --version) installed"
        DEPS_INSTALLED+=("uv (official installer)")
    else
        warn "uv installed to ~/.local/bin but PATH does not include it for this shell"
        info "open a new shell or 'export PATH=\$HOME/.local/bin:\$PATH' and re-run"
    fi
}

# ---------------------------------------------------------------------------
# Step 5: Rust (rustup)
#
# Skipped when --no-app (no Tauri build needed). rustup's official installer
# lands in ~/.cargo/bin; we export PATH so post-install probes find rustc.
# ---------------------------------------------------------------------------
install_rust() {
    step "3b. Rust toolchain (rustup + cargo)"
    if [[ $NO_APP -eq 1 ]]; then
        skip "Rust install skipped via --no-app (no Tauri build needed)"
        return 0
    fi
    export PATH="${HOME}/.cargo/bin:${PATH}"
    if have_cmd rustc; then
        DEPS_PRESENT+=("rustc $(rustc --version | awk '{print $2}')")
        ok "rustc $(rustc --version)"
        return 0
    fi
    info "installing Rust via https://sh.rustup.rs"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --no-modify-path
    export PATH="${HOME}/.cargo/bin:${PATH}"
    if have_cmd rustc; then
        ok "rustc $(rustc --version) installed"
        DEPS_INSTALLED+=("rustup (official installer)")
    else
        warn "rustup ran but rustc not on PATH; open a new shell or 'source ~/.cargo/env'"
    fi
}

# ---------------------------------------------------------------------------
# Step 6: Claude Code CLI (HARD requirement)
#
# We install into a user-scope npm prefix (~/.npm-global) so we never need
# sudo for `npm i -g`. This is the npm idiom for global packages on Linux
# without root and matches what most JS devs already have configured.
#
# CHOICE FLAGGED FOR USER: npm prefix path = ~/.npm-global. If you prefer
# /usr/local (sudo) or some other path, edit NPM_PREFIX below.
# ---------------------------------------------------------------------------
NPM_PREFIX="${HOME}/.npm-global"
install_claude() {
    step "4. Claude Code CLI"
    export PATH="${NPM_PREFIX}/bin:${PATH}"
    if have_cmd claude; then
        DEPS_PRESENT+=("claude $(claude --version 2>/dev/null | head -1)")
        ok "claude $(claude --version 2>/dev/null | head -1)"
        return 0
    fi
    if ! have_cmd npm; then
        fail "npm missing — Node install (step 2b) must have failed"
        info "manual: install Node ${NODE_MIN_MAJOR}+, then 'npm i -g @anthropic-ai/claude-code'"
        exit 2
    fi

    if ! confirm "Install Claude Code CLI via 'npm i -g @anthropic-ai/claude-code'?" "y"; then
        fail "Claude Code CLI declined — ULTRON cannot run without it"
        info "manual: npm i -g @anthropic-ai/claude-code && claude login"
        exit 2
    fi

    # Configure a user-scope npm prefix so we don't need sudo. Idempotent.
    mkdir -p "${NPM_PREFIX}"
    npm config set prefix "${NPM_PREFIX}"
    info "npm prefix set to ${NPM_PREFIX}"
    info "running: npm i -g @anthropic-ai/claude-code (1-3 minutes)"
    npm install -g @anthropic-ai/claude-code

    # Persist the PATH addition into the user's shell rc so future sessions
    # see `claude`. Idempotent grep check.
    local rc
    if [[ -n "${BASH_VERSION:-}" ]] && [[ -f "${HOME}/.bashrc" ]]; then
        rc="${HOME}/.bashrc"
    elif [[ -f "${HOME}/.profile" ]]; then
        rc="${HOME}/.profile"
    else
        rc=""
    fi
    if [[ -n "$rc" ]] && ! grep -q '.npm-global/bin' "$rc" 2>/dev/null; then
        printf '\n# Added by ULTRON installer\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$rc"
        info "added ${NPM_PREFIX}/bin to ${rc}"
    fi

    if have_cmd claude; then
        ok "claude $(claude --version 2>/dev/null | head -1) installed"
        DEPS_INSTALLED+=("claude code CLI (npm global)")
        info "Run 'claude login' once to authenticate against your Claude.ai subscription."
    else
        fail "claude installed but not on PATH — open a new shell and re-run"
        exit 2
    fi
}

# ---------------------------------------------------------------------------
# Step 7: Qdrant native binary
#
# We install the Qdrant native binary per ULTRON design (no Docker since
# v15.0.2). The tarball ships a single binary; we extract it to
# ~/.ultron/qdrant-native/qdrant, chmod +x, and seed a minimal config.
#
# Unlike install.ps1 we don't pin a SHA256 — the Linux release zip is not yet
# part of the install.ps1 hardening matrix and pinning one without the
# maintainer's explicit say-so risks breaking future Qdrant bumps. Flagged in the summary.
# ---------------------------------------------------------------------------
install_qdrant() {
    step "5. Qdrant native (no Docker)"
    if [[ $NO_DOCKER -eq 1 ]]; then
        skip "Qdrant skipped via --no-docker (semantic recall disabled)"
        return 0
    fi

    local native_dir="${INSTALL_ROOT}/qdrant-native"
    local exe="${native_dir}/qdrant"
    local cfg_dir="${native_dir}/config"
    local cfg="${cfg_dir}/production.yaml"

    if [[ -x "$exe" ]]; then
        ok "qdrant binary already present at ${exe}"
    else
        mkdir -p "$native_dir"
        local tmp_tar="/tmp/${QDRANT_TARBALL}"
        info "downloading ${QDRANT_URL}"
        curl -fSL --retry 3 -o "$tmp_tar" "$QDRANT_URL"
        # Optional SHA256 verification — mirrors install.ps1's pinned check.
        # When QDRANT_SHA256 is set (env or future hard-coded constant), the
        # download is verified; mismatch aborts before we extract. When empty,
        # we warn + continue so the installer keeps working before a maintainer
        # pins the SHA — same end-state as pre-v15.5.14.
        if [[ -n "$QDRANT_SHA256" ]]; then
            local actual_sha
            actual_sha="$(sha256sum "$tmp_tar" | awk '{print tolower($1)}')"
            local expected_sha
            expected_sha="$(printf '%s' "$QDRANT_SHA256" | tr '[:upper:]' '[:lower:]')"
            if [[ "$actual_sha" != "$expected_sha" ]]; then
                fail "Qdrant tarball SHA256 mismatch — refusing to extract"
                fail "  expected: ${expected_sha}"
                fail "  actual:   ${actual_sha}"
                rm -f "$tmp_tar"
                return 1
            fi
            ok "Qdrant SHA256 verified: ${actual_sha}"
        else
            warn "Qdrant SHA256 not pinned (set ULTRON_QDRANT_SHA=<sha> to gate)"
        fi
        info "extracting to ${native_dir}"
        tar -xzf "$tmp_tar" -C "$native_dir"
        rm -f "$tmp_tar"
        # The tarball ships a single 'qdrant' binary at the top level. If the
        # release ever changes layout (e.g. nests under qdrant-<version>/) we
        # surface it loudly instead of silently leaving the wrong path.
        if [[ ! -f "$exe" ]]; then
            warn "tarball layout changed — qdrant binary not at ${exe}"
            local found
            found="$(find "$native_dir" -maxdepth 3 -type f -name qdrant | head -1)"
            if [[ -n "$found" ]]; then
                mv "$found" "$exe"
                info "moved ${found} -> ${exe}"
            else
                fail "could not find qdrant binary in extracted tarball"
                return 1
            fi
        fi
        chmod +x "$exe"
        ok "qdrant binary installed at ${exe}"
    fi

    # Minimal config so the binary can be launched with --config-path. Mirrors
    # the YAML install.ps1 seeds — same ports, same storage layout.
    mkdir -p "$cfg_dir"
    if [[ ! -f "$cfg" ]]; then
        cat > "$cfg" <<'YAML'
storage:
  storage_path: ./storage
  snapshots_path: ./snapshots

service:
  host: 127.0.0.1
  http_port: 6333
  grpc_port: 6334

log_level: INFO
YAML
        ok "production.yaml seeded"
    fi

    # Probe — already running?
    if curl -fsS --max-time 3 http://localhost:6333/healthz >/dev/null 2>&1; then
        ok "Qdrant /healthz 200 (already running)"
    else
        info "Qdrant binary ready. Start with: ${exe} --config-path ${cfg}"
    fi
}

# ---------------------------------------------------------------------------
# Step 8: Tauri Linux build deps
#
# webkit2gtk-4.1 is required by Tauri 2.x. On Debian/Ubuntu it's split across
# webkit2gtk-4.1-dev + libsoup-3.0-dev. On Fedora the equivalent rpms are
# webkit2gtk4.1-devel + libsoup3-devel. On Arch the packages don't carry a
# -dev suffix.
# ---------------------------------------------------------------------------
install_tauri_deps() {
    step "6. Tauri Linux build deps"
    if [[ $NO_APP -eq 1 ]]; then
        skip "Tauri deps skipped via --no-app"
        return 0
    fi
    ensure_sudo
    case "$PKG_MGR" in
        apt)
            install_pkg \
                libwebkit2gtk-4.1-dev \
                libsoup-3.0-dev \
                librsvg2-bin \
                build-essential \
                libssl-dev \
                pkg-config
            ;;
        dnf)
            install_pkg \
                webkit2gtk4.1-devel \
                libsoup3-devel \
                librsvg2-tools \
                gcc gcc-c++ make \
                openssl-devel \
                pkgconf-pkg-config
            ;;
        pacman)
            install_pkg \
                webkit2gtk-4.1 \
                libsoup3 \
                librsvg \
                base-devel \
                openssl \
                pkgconf
            ;;
    esac
    ok "Tauri build deps installed"
}

# ---------------------------------------------------------------------------
# Step 9: directory layout (mirrors install.ps1 New-DirectoryLayout)
# ---------------------------------------------------------------------------
make_dirs() {
    step "7. directory layout"
    local dirs=(
        "${INSTALL_ROOT}"
        "${INSTALL_ROOT}/cockpit"
        "${INSTALL_ROOT}/plans"
        "${INSTALL_ROOT}/skills"
        "${INSTALL_ROOT}/scripts"
        "${INSTALL_ROOT}/brain_index"
        "${INSTALL_ROOT}/.tmp"
        "${INSTALL_ROOT}/personal"
        "${INSTALL_ROOT}/sessions"
        "${VAULT_DIR}"
        "${CLAUDE_DIR}/skills"
        "${CLAUDE_DIR}/agents"
    )
    for d in "${dirs[@]}"; do
        if [[ -d "$d" ]]; then
            verb "exists: $d"
        else
            mkdir -p "$d"
            verb "created: $d"
        fi
    done
    ok "directory tree provisioned"
}

# ---------------------------------------------------------------------------
# Step 7b: brain_index FTS5 init
#
# install.ps1 calls `brain_index.py build` after the cockpit copy. Without an
# equivalent step here, Linux users finish install with an empty
# ~/.ultron/brain_index/index.db and the first SessionStart `auto-recall` hook
# returns 0 hits (CLAUDE.md says deep-dive recall depends on this DB).
# Skipped if uv is missing — brain_index.py needs uv-managed deps.
# ---------------------------------------------------------------------------
init_brain_index() {
    step "7b. brain_index FTS5 build (cold)"
    local script="${INSTALL_ROOT}/scripts/cockpit/brain_index.py"
    if [[ ! -f "$script" ]]; then
        # Fall back to the in-repo copy (fresh install hasn't bootstrapped yet).
        script="${REPO_ROOT}/scripts/cockpit/brain_index.py"
    fi
    if [[ ! -f "$script" ]]; then
        warn "brain_index.py not found in install root or repo — skip"
        return 0
    fi
    if ! have_cmd uv; then
        warn "uv missing — cannot build brain_index (re-run after uv install)"
        return 0
    fi
    local db="${INSTALL_ROOT}/brain_index/index.db"
    if [[ -f "$db" ]]; then
        verb "brain_index already present at ${db} — running incremental update"
        ( cd "$REPO_ROOT" && uv run python "$script" update >/dev/null 2>&1 ) \
            || warn "brain_index update returned non-zero (continuing)"
    else
        info "building FTS5 index (one-time, ~5-15s depending on vault size)"
        ( cd "$REPO_ROOT" && uv run python "$script" build >/dev/null 2>&1 ) \
            || warn "brain_index build returned non-zero (continuing)"
    fi
    ok "brain_index ready at ${db}"
}

# ---------------------------------------------------------------------------
# Step 10: template seeds (CLAUDE.md global, SYSTEM-MAP, MEMORY, cockpit seeds)
# ---------------------------------------------------------------------------
seed_templates() {
    step "8. wake-up stubs + cockpit / vault seeds"
    # Pair format: src_rel|dst_abs
    local pairs=(
        "templates/CLAUDE.md.example|${CLAUDE_DIR}/CLAUDE.md"
        "templates/SYSTEM-MAP.md.example|${INSTALL_ROOT}/SYSTEM-MAP.md"
        "templates/MEMORY.md.example|${INSTALL_ROOT}/MEMORY.md"
        "templates/projects.empty.json|${INSTALL_ROOT}/cockpit/projects.json"
        "templates/apps.default.json|${INSTALL_ROOT}/cockpit/apps.json"
        "templates/profile.template.md|${INSTALL_ROOT}/personal/profile.md"
        "templates/known.empty.json|${INSTALL_ROOT}/personal/known.json"
        "templates/VAULT-README.md|${VAULT_DIR}/README.md"
    )
    for pair in "${pairs[@]}"; do
        local src="${REPO_ROOT}/${pair%%|*}"
        local dst="${pair##*|}"
        if [[ ! -f "$src" ]]; then
            warn "template missing: ${pair%%|*}"
            continue
        fi
        if [[ -e "$dst" ]]; then
            verb "kept existing: $dst"
            continue
        fi
        mkdir -p "$(dirname "$dst")"
        cp "$src" "$dst"
        verb "seeded: $dst"
    done
    ok "templates seeded"
}

# ---------------------------------------------------------------------------
# Step 11: merge hooks into ~/.claude/settings.json
#
# install.ps1 replaces the whole "hooks" object with the template's version
# because the template IS the authoritative ULTRON hook set. We mirror that.
# Requires `jq` for safe JSON merging — installed via the package manager
# if missing.
# ---------------------------------------------------------------------------
merge_hooks() {
    step "9. Claude Code hooks (settings.json merge)"
    local tpl="${REPO_ROOT}/templates/settings-hooks.json"
    if [[ ! -f "$tpl" ]]; then
        warn "hook template missing: ${tpl}"
        return 0
    fi
    mkdir -p "${CLAUDE_DIR}"
    local settings="${CLAUDE_DIR}/settings.json"

    if ! have_cmd jq; then
        info "jq missing — installing via ${PKG_MGR} for JSON merge"
        ensure_sudo
        install_pkg jq
    fi

    # The template is Windows-canonical: it hardcodes `.venv/Scripts/python.exe`
    # and `PowerShell -WindowStyle Hidden -File ... .ps1` invocations. install.ps1
    # uses it as-is; install.sh has to rewrite it before merging so the resulting
    # ~/.claude/settings.json fires real Linux binaries (Kirkardo audit v15.5.0).
    #
    # Three substitutions:
    #   1. {USERPROFILE}            -> $HOME (placeholder expansion)
    #   2. .venv/Scripts/python.exe -> .venv/bin/python (uv venv layout on Linux)
    #   3. PowerShell -WindowStyle Hidden -NoProfile -NonInteractive
    #      -ExecutionPolicy Bypass -File <path>.ps1
    #      -> bash <path>.sh
    # Then jq filters out any hook whose `.command` still references
    # `.ps1` — those scripts have no .sh sibling yet (session-init,
    # stop-memory-sync, session-cleanup; flagged in v15.5.x backlog).
    local expanded
    expanded="$(sed \
        -e "s|{USERPROFILE}|${HOME}|g" \
        -e "s|\.venv/Scripts/python\.exe|.venv/bin/python|g" \
        -e "s|PowerShell -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \\([^\"]*\\)\\.ps1|bash \\1.sh|g" \
        "$tpl")"

    # Drop any remaining hook entry that still references a .ps1 file —
    # those scripts have no Linux sibling yet and would silently fail
    # every session. The Python hooks (auto-recall, intent-dispatcher,
    # mode-trigger, etc.) are cross-platform and stay wired.
    expanded="$(printf '%s' "$expanded" | jq '
        .hooks |= with_entries(
            .value |= map(
                .hooks |= map(select(.command | test("\\.ps1") | not))
            ) | map(select(.hooks | length > 0))
        )
    ')"

    if [[ -f "$settings" ]]; then
        # Back up first — never blow away a user-edited settings.json silently.
        local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
        cp "$settings" "${settings}.bak-${stamp}"
        verb "backup: ${settings}.bak-${stamp}"
        # Merge: overwrite ONLY the "hooks" key, preserve everything else.
        # jq's `* {hooks: $tpl.hooks}` would deep-merge; we want a hard
        # replace of hooks per install.ps1 semantics, hence the explicit form.
        local merged
        merged="$(jq --argjson tpl "$expanded" '. + {hooks: $tpl.hooks}' "$settings")"
        printf '%s\n' "$merged" > "${settings}.tmp"
        mv "${settings}.tmp" "$settings"
    else
        # Fresh install — just write the template wrapped in a top-level object.
        printf '%s\n' "$expanded" > "$settings"
    fi
    ok "settings.json hooks merged"
}

# ---------------------------------------------------------------------------
# Step 12: skills picker (tiny YAML reader)
#
# Mirrors install.ps1 Install-Skills: parse templates/skills-manifest.example.yaml,
# install all `core: true` entries unconditionally, ask one-by-one for
# `personal: true`. `repo://` source = copy from repo. `claude://` = leave
# whatever the user already has alone.
# ---------------------------------------------------------------------------
install_skills() {
    step "10. skills picker"
    local manifest="${REPO_ROOT}/templates/skills-manifest.example.yaml"
    if [[ ! -f "$manifest" ]]; then
        warn "manifest missing: ${manifest}"
        return 0
    fi
    local target_root="${CLAUDE_DIR}/skills"
    mkdir -p "$target_root"

    local installed=0 skipped=0
    local name="" core="false" personal="false" source_str="" description=""

    # Flush a parsed entry to disk. Declared first so it's hoisted before the
    # awk-like loop body below references it.
    flush_entry() {
        [[ -z "$name" ]] && return
        local dest="${target_root}/${name}"
        local should=0
        if [[ "$core" == "true" ]]; then
            should=1
        elif [[ "$personal" == "true" ]]; then
            if confirm "install personal skill: ${name} — ${description}" "n"; then
                should=1
            fi
        fi
        if [[ $should -eq 0 ]]; then
            skipped=$((skipped + 1))
            return
        fi
        if [[ -e "$dest" ]]; then
            verb "${name} already at ${dest}"
            installed=$((installed + 1))
            return
        fi
        case "$source_str" in
            repo://*)
                local rel="${source_str#repo://}"
                local src="${REPO_ROOT}/${rel}"
                if [[ -e "$src" ]]; then
                    cp -R "$src" "$dest"
                    verb "copied ${rel} -> ${dest}"
                    installed=$((installed + 1))
                else
                    verb "repo source missing for ${name}: ${src} - skip"
                    skipped=$((skipped + 1))
                fi
                ;;
            claude://*)
                verb "claude:// skill ${name} - leaving user's local copy alone"
                installed=$((installed + 1))
                ;;
        esac
        # Reset for next entry
        name=""; core="false"; personal="false"; source_str=""; description=""
    }

    while IFS= read -r line; do
        # Match: '  - name: foo'
        if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*name:[[:space:]]*(.+)$ ]]; then
            flush_entry
            name="$(echo "${BASH_REMATCH[1]}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        elif [[ "$line" =~ ^[[:space:]]*core:[[:space:]]*(true|false)[[:space:]]*$ ]]; then
            core="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^[[:space:]]*personal:[[:space:]]*(true|false)[[:space:]]*$ ]]; then
            personal="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^[[:space:]]*source:[[:space:]]*\"?(.+)\"?[[:space:]]*$ ]]; then
            source_str="$(echo "${BASH_REMATCH[1]}" | sed 's/"//g;s/^[[:space:]]*//;s/[[:space:]]*$//')"
        elif [[ "$line" =~ ^[[:space:]]*description:[[:space:]]*\"(.+)\"[[:space:]]*$ ]]; then
            description="${BASH_REMATCH[1]}"
        fi
    done < "$manifest"
    flush_entry  # last record

    ok "skills: ${installed} installed, ${skipped} skipped"
}

# ---------------------------------------------------------------------------
# Step 10c: install skills-catalog by category (mirror of install.ps1
# Install-SkillSets). Reads skills-catalog/manifest.json with jq, prompts
# per category (or installs the default-on set in --non-interactive),
# copies each chosen category's skill dirs into ~/.claude/skills/.
# ---------------------------------------------------------------------------
DEFAULT_SKILL_SETS=("meta" "memory")  # parity with install.ps1

install_skill_sets() {
    step "10c. skills-catalog (per-category picker, 332 skills total)"
    local manifest="${REPO_ROOT}/skills-catalog/manifest.json"
    if [[ ! -f "$manifest" ]]; then
        verb "skills-catalog/manifest.json missing - skip"
        return 0
    fi
    if ! have_cmd jq; then
        warn "jq missing - cannot parse skills-catalog manifest; skipping"
        return 0
    fi

    local cats; cats="$(jq -r '.by_category | keys[]' "$manifest" 2>/dev/null)"
    if [[ -z "$cats" ]]; then
        warn "no categories in manifest - skip"
        return 0
    fi

    local dest="${CLAUDE_DIR}/skills"
    mkdir -p "$dest"
    local installed_cats=0 installed_skills=0 skipped_cats=0

    while IFS= read -r cat; do
        [[ -z "$cat" ]] && continue
        local is_default=0
        for d in "${DEFAULT_SKILL_SETS[@]}"; do
            [[ "$cat" == "$d" ]] && is_default=1 && break
        done

        local count; count="$(jq -r ".by_category[\"${cat}\"]" "$manifest")"
        local pick="n"
        if [[ $NON_INTERACTIVE -eq 1 ]]; then
            [[ $is_default -eq 1 ]] && pick="y"
        else
            if [[ $is_default -eq 1 ]]; then
                read -r -p "[skill-sets] install '${cat}' (${count} skills)? [Y/n] " ans
                [[ -z "$ans" || "$ans" =~ ^[YySs]$ ]] && pick="y"
            else
                read -r -p "[skill-sets] install '${cat}' (${count} skills)? [y/N] " ans
                [[ "$ans" =~ ^[YySs]$ ]] && pick="y"
            fi
        fi

        if [[ "$pick" != "y" ]]; then
            skipped_cats=$((skipped_cats + 1))
            continue
        fi

        local cat_dir="${REPO_ROOT}/skills-catalog/${cat}"
        if [[ ! -d "$cat_dir" ]]; then
            verb "category dir missing: ${cat_dir}"
            continue
        fi
        local n=0
        for skill_dir in "$cat_dir"/*/; do
            [[ -d "$skill_dir" ]] || continue
            local name; name="$(basename "$skill_dir")"
            local dst="${dest}/${name}"
            if [[ -e "$dst" ]]; then
                verb "already installed: ${name}"
                continue
            fi
            cp -r "$skill_dir" "$dst"
            n=$((n + 1))
        done
        installed_skills=$((installed_skills + n))
        installed_cats=$((installed_cats + 1))
        verb "category '${cat}': ${n} skills installed"
    done <<< "$cats"

    ok "skill-sets: ${installed_cats} categories / ${installed_skills} skills installed, ${skipped_cats} categories skipped"
}

# ---------------------------------------------------------------------------
# Step 13: flat-copy repo/agents/*.md -> ~/.claude/agents/
# ---------------------------------------------------------------------------
install_agents() {
    step "10b. agents (copy repo/agents -> ~/.claude/agents)"
    local src="${REPO_ROOT}/agents"
    if [[ ! -d "$src" ]]; then
        verb "agents/ directory missing in repo - skip"
        return 0
    fi
    local dest="${CLAUDE_DIR}/agents"
    mkdir -p "$dest"
    local installed=0 skipped=0
    for f in "$src"/*.md; do
        [[ -f "$f" ]] || continue
        local name; name="$(basename "$f")"
        if [[ -e "${dest}/${name}" ]]; then
            skipped=$((skipped + 1))
        else
            cp "$f" "${dest}/${name}"
            installed=$((installed + 1))
        fi
    done
    ok "agents: ${installed} installed, ${skipped} already present"
}

# ---------------------------------------------------------------------------
# Step 14: write features.json (mirrors install.ps1 Set-FeatureFlags defaults)
#
# We DO NOT run a wizard on Linux (install.ps1's wizard is WinForms-only). The
# defaults match install.ps1's baseline. If --non-interactive we just write
# the defaults; otherwise we ask once per toggle.
# ---------------------------------------------------------------------------
write_feature_flags() {
    step "11. feature flags (~/.ultron/cockpit/features.json)"
    local cockpit_dir="${INSTALL_ROOT}/cockpit"
    mkdir -p "$cockpit_dir"
    local features_file="${cockpit_dir}/features.json"

    # Read previous answers as defaults if features.json already exists; this
    # is what makes re-running idempotent — your previous choices win.
    local d_news="false" d_gaming="true" d_personal="true" d_schedules="true"
    local d_selfimp="true" d_notif="true" d_usage="false" d_sessions="true"
    local d_projects="true" d_plans="false"
    if [[ -f "$features_file" ]] && have_cmd jq; then
        d_news="$(jq -r '.news // false'         "$features_file" 2>/dev/null || echo false)"
        d_gaming="$(jq -r '.gaming // true'      "$features_file" 2>/dev/null || echo true)"
        d_personal="$(jq -r '.personal // true'  "$features_file" 2>/dev/null || echo true)"
        d_schedules="$(jq -r '.schedules // true' "$features_file" 2>/dev/null || echo true)"
        d_selfimp="$(jq -r '.self_improve // true' "$features_file" 2>/dev/null || echo true)"
        d_notif="$(jq -r '.notifications // true' "$features_file" 2>/dev/null || echo true)"
        d_usage="$(jq -r '.usage // false'       "$features_file" 2>/dev/null || echo false)"
        d_sessions="$(jq -r '.sessions // true'  "$features_file" 2>/dev/null || echo true)"
        d_projects="$(jq -r '.projects // true'  "$features_file" 2>/dev/null || echo true)"
        d_plans="$(jq -r '.plans // false'       "$features_file" 2>/dev/null || echo false)"
    fi

    # Tiny helper: ask one toggle, return "true"/"false" on stdout.
    ask_toggle() {
        local name="$1" default="$2" note="$3"
        local def_yn; [[ "$default" == "true" ]] && def_yn="y" || def_yn="n"
        if confirm "${name} (${note})" "$def_yn"; then echo "true"; else echo "false"; fi
    }

    local news gaming personal schedules selfimp notif usage sessions projects plans
    if [[ $NON_INTERACTIVE -eq 1 ]]; then
        news="$d_news"; gaming="$d_gaming"; personal="$d_personal"
        schedules="$d_schedules"; selfimp="$d_selfimp"; notif="$d_notif"
        usage="$d_usage"; sessions="$d_sessions"; projects="$d_projects"; plans="$d_plans"
        info "non-interactive: keeping previous / default toggle values"
    else
        info "Enable optional features? Press Enter to accept the default."
        news="$(ask_toggle      "News digest"       "$d_news"      "Gemini-generated daily newsletter (cost-heavy)")"
        gaming="$(ask_toggle    "Gaming utilities"  "$d_gaming"    "game detector + tweaks panel")"
        personal="$(ask_toggle  "Personal section"  "$d_personal"  "private profile slots in the cockpit")"
        schedules="$(ask_toggle "Schedules"         "$d_schedules" "systemd timer / cron management")"
        selfimp="$(ask_toggle   "Self-improve"      "$d_selfimp"   "route telemetry feeds the dispatcher tuner")"
        notif="$(ask_toggle     "Notifications"     "$d_notif"     "desktop notifications + pending-actions panel")"
        usage="$(ask_toggle     "Usage tracking"    "$d_usage"     "token budget + /usage cache (Anthropic API only)")"
        sessions="$(ask_toggle  "Sessions archive"  "$d_sessions"  "session replay + highlights + compactor")"
        projects="$(ask_toggle  "Project manager"   "$d_projects"  "project editor + scan + notes panel")"
        plans="$(ask_toggle     "Plans & goals"     "$d_plans"     "lifecycle open -> in-progress -> resolved")"
    fi

    cat > "$features_file" <<EOF
{
  "news": ${news},
  "gaming": ${gaming},
  "personal": ${personal},
  "schedules": ${schedules},
  "self_improve": ${selfimp},
  "notifications": ${notif},
  "usage": ${usage},
  "sessions": ${sessions},
  "projects": ${projects},
  "plans": ${plans}
}
EOF
    ok "features.json -> ${features_file}"
}

# ---------------------------------------------------------------------------
# Step 15: structured summary
# ---------------------------------------------------------------------------
print_summary() {
    echo ""
    echo "======================================================="
    echo " ULTRON install summary (Linux ${ULTRON_VERSION})"
    echo "======================================================="
    echo " install root  : ${INSTALL_ROOT}"
    echo " repo root     : ${REPO_ROOT}"
    echo " vault         : ${VAULT_DIR}"
    echo " claude dir    : ${CLAUDE_DIR}"
    echo " package mgr   : ${PKG_MGR:-?}"
    echo " qdrant binary : ${INSTALL_ROOT}/qdrant-native/qdrant"
    echo ""
    echo " deps already present (${#DEPS_PRESENT[@]}):"
    if [[ ${#DEPS_PRESENT[@]} -eq 0 ]]; then
        echo "   (none)"
    else
        for d in "${DEPS_PRESENT[@]}"; do echo "   - ${d}"; done
    fi
    echo ""
    echo " deps installed (${#DEPS_INSTALLED[@]}):"
    if [[ ${#DEPS_INSTALLED[@]} -eq 0 ]]; then
        echo "   (none — everything was already present)"
    else
        for d in "${DEPS_INSTALLED[@]}"; do echo "   - ${d}"; done
    fi
    echo ""
    echo " steps ok      : ${#STEPS_OK[@]}"
    echo " steps skipped : ${#STEPS_SKIPPED[@]}"
    echo " warnings      : ${#WARNINGS[@]}"
    echo " errors        : ${#ERRORS[@]}"
    if [[ ${#WARNINGS[@]} -gt 0 ]]; then
        echo ""
        echo " warnings:"
        for w in "${WARNINGS[@]}"; do echo "   - ${w}"; done
    fi
    if [[ ${#ERRORS[@]} -gt 0 ]]; then
        echo ""
        echo " errors:"
        for e in "${ERRORS[@]}"; do echo "   - ${e}"; done
    fi
    echo ""
    echo " next steps:"
    echo "   cd ${INSTALL_ROOT} && uv sync                 # provision .venv for hooks"
    echo "   claude login                                  # authenticate Claude"
    echo "   ${INSTALL_ROOT}/qdrant-native/qdrant \\"
    echo "       --config-path ${INSTALL_ROOT}/qdrant-native/config/production.yaml"
    if [[ $NO_APP -eq 0 ]]; then
        echo "   cd ${REPO_ROOT}/control-center && npm install && npm run tauri dev"
    fi
    echo "======================================================="
}

# ---------------------------------------------------------------------------
# Banner + main pipeline
# ---------------------------------------------------------------------------
echo ""
echo "======================================================="
echo " ULTRON installer (root, Linux) ${ULTRON_VERSION}"
echo " https://github.com/SkiTemplar/ultron"
echo "======================================================="
echo ""
echo " Auto-install enabled: missing dependencies (curl, git,"
echo " Node ${NODE_MIN_MAJOR}+, uv, rustup, Claude Code) will be installed"
echo " via the detected package manager unless you decline."
[[ $NON_INTERACTIVE -eq 1 ]] && echo " (non-interactive: auto-accepting all installs)"
[[ $NO_APP          -eq 1 ]] && echo " (--no-app: skipping Tauri build deps)"
[[ $NO_DOCKER       -eq 1 ]] && echo " (--no-docker: skipping Qdrant native)"
[[ $VERBOSE         -eq 1 ]] && echo " (verbose mode)"
echo ""

preflight
detect_pkg_mgr
install_curl_git
install_node
install_uv
install_rust
install_claude
install_qdrant
install_tauri_deps
make_dirs
init_brain_index
seed_templates
merge_hooks
install_skills
install_skill_sets
install_agents
write_feature_flags
print_summary

if [[ ${#ERRORS[@]} -gt 0 ]]; then
    exit 1
fi
exit 0
