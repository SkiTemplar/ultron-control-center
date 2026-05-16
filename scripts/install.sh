#!/usr/bin/env bash
#
# ULTRON v15.2 bootstrap installer (POSIX bash).
#
# Companion to scripts/install.ps1. Same behavior, same prompts, same
# features.json output. Honors $HOME, never hardcodes a path.
#
# Hard rules:
#   - No sudo / root required.
#   - No external API keys requested.
#   - Idempotent: re-running is safe.
#   - Every step prints a pre and post line.
#   - On failure, prints the offending command, a suggested fix, and
#     exits non-zero.
#
# Usage:
#   chmod +x scripts/install.sh
#   ./scripts/install.sh                 # interactive
#   ./scripts/install.sh --non-interactive  # CI, accept all defaults
#   INSTALL_ROOT=/opt/ultron ./scripts/install.sh
#
# NOTE on macOS: macOS is not explicitly tested. Uses POSIX features
# only (no GNU-specific flags). bash 3.2+ is required (macOS ships
# bash 3.2). Bash 4+ features (associative arrays, mapfile) are NOT
# used so the script stays portable.

set -u
# We deliberately do NOT use `set -e` because the installer wants to
# accumulate warnings and provide friendlier messages. Each command
# that must succeed is checked manually.

# ---------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------
VERSION_FALLBACK="v15.2.0"

# Resolve repo root: scripts/install.sh -> repo root is parent dir.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.ultron}"
NON_INTERACTIVE=0

WARNINGS=""
HARD_ERRORS=""

# ---------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --non-interactive|-y)
            NON_INTERACTIVE=1
            ;;
        --install-root=*)
            INSTALL_ROOT="${arg#*=}"
            ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $arg"
            echo "use --help for usage."
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------
# Logging helpers (no emoji, no color).
# ---------------------------------------------------------------------
step()    { printf '[ STEP ] %s\n' "$1"; }
ck()      { printf 'checking %s...\n' "$1"; }
ok()      { printf '  ok    %s\n' "$1"; }
warn()    { printf '  warn  %s\n' "$1"; WARNINGS="$WARNINGS
  - $1"; }
fail()    { printf '  fail  %s\n' "$1"; HARD_ERRORS="$HARD_ERRORS
  - $1"; }
info()    { printf '        %s\n' "$1"; }

die() {
    # die <stage> <command> <fix>
    printf '\n'
    printf 'INSTALL FAILED at stage: %s\n' "$1"
    printf '  command : %s\n' "$2"
    printf '  fix     : %s\n' "$3"
    printf '\n'
    exit 1
}

banner() {
    local v
    v="$(detect_version)"
    printf '\n'
    printf '=======================================================\n'
    printf ' ULTRON installer %s\n' "$v"
    printf ' https://github.com/anonuser/ultron\n'
    printf '=======================================================\n\n'
}

# ---------------------------------------------------------------------
# Version detection (best-effort, no jq required).
# ---------------------------------------------------------------------
detect_version() {
    local pj="$REPO_ROOT/package.json"
    if [ ! -f "$pj" ]; then
        pj="$REPO_ROOT/control-center/package.json"
    fi
    if [ -f "$pj" ]; then
        # Minimal grep extraction: "version": "x.y.z"
        local v
        v="$(grep -E '"version"[[:space:]]*:' "$pj" | head -n 1 \
             | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
        if [ -n "$v" ]; then
            printf 'v%s' "$v"
            return 0
        fi
    fi
    printf '%s' "$VERSION_FALLBACK"
}

# ---------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------
preflight() {
    step "preflight"

    ck "host OS"
    local uname_s
    uname_s="$(uname -s 2>/dev/null || echo unknown)"
    case "$uname_s" in
        Linux*|Darwin*|FreeBSD*)
            ok "$uname_s host"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            ok "Windows-Unix shim ($uname_s) — prefer scripts/install.ps1 for full support"
            warn "running install.sh on Windows shell — symlinks and npm paths may behave differently"
            ;;
        *)
            warn "unrecognized host: $uname_s — continuing on a best-effort basis"
            ;;
    esac

    ck "bash version"
    if [ -n "${BASH_VERSION:-}" ]; then
        ok "bash $BASH_VERSION"
    else
        warn "BASH_VERSION not set — script targets bash 3.2+"
    fi

    ck "internet reachability"
    if command -v curl >/dev/null 2>&1; then
        if curl -fsS --max-time 5 -o /dev/null https://github.com; then
            ok "github.com reachable"
        else
            warn "could not reach github.com — uv sync / npm install may fail"
        fi
    elif command -v wget >/dev/null 2>&1; then
        if wget -q --spider --timeout=5 https://github.com; then
            ok "github.com reachable"
        else
            warn "could not reach github.com (wget probe)"
        fi
    else
        warn "neither curl nor wget present — skipping network probe"
    fi
}

# ---------------------------------------------------------------------
# Dependency probe — warn only, never auto-install.
# ---------------------------------------------------------------------
probe_cmd() {
    # probe_cmd <name> <version-flag> <link> [optional]
    local name="$1"
    local flag="$2"
    local link="$3"
    local optional="${4:-}"

    ck "$name"
    if ! command -v "$name" >/dev/null 2>&1; then
        if [ "$optional" = "optional" ]; then
            warn "$name: missing (optional) — $link"
        else
            fail "$name: missing — $link"
        fi
        return 1
    fi
    local ver
    ver="$("$name" "$flag" 2>/dev/null | head -n 1)"
    if [ -z "$ver" ]; then
        ver="(version not reported)"
    fi
    ok "$name $ver"
    return 0
}

probe_dependencies() {
    step "dependencies (warn-only — installer will not auto-install)"

    probe_cmd rustc  --version  "https://rustup.rs"                                       || true

    if probe_cmd node --version "https://nodejs.org"; then
        local nodev
        nodev="$(node --version 2>/dev/null | head -n 1)"
        # nodev is like "v22.4.1"
        local major
        major="$(printf '%s' "$nodev" | sed -E 's/^v([0-9]+).*/\1/')"
        if [ -n "$major" ] && [ "$major" -lt 22 ] 2>/dev/null; then
            warn "node $nodev is older than v22 — control-center expects v22+"
        fi
    fi

    probe_cmd uv     --version  "https://docs.astral.sh/uv"                               || true
    probe_cmd claude --version  "https://docs.claude.com/en/docs/claude-code"             || true

    probe_cmd codex  --version  "https://github.com/openai/codex"             optional || true
    probe_cmd gemini --version  "https://github.com/google-gemini/gemini-cli" optional || true

    if [ -n "$HARD_ERRORS" ]; then
        printf '\n'
        printf 'Required dependencies missing:\n'
        printf '%s\n' "$HARD_ERRORS"
        die "dependencies" "(see list above)" \
            "Install the missing tools using the links above, then re-run scripts/install.sh."
    fi
}

# ---------------------------------------------------------------------
# Directory tree
# ---------------------------------------------------------------------
make_tree() {
    step "provisioning directory tree at $INSTALL_ROOT"

    local dirs="
$INSTALL_ROOT
$INSTALL_ROOT/cockpit
$INSTALL_ROOT/plans
$INSTALL_ROOT/skills
$INSTALL_ROOT/scripts
$INSTALL_ROOT/brain_index
$INSTALL_ROOT/.tmp
$INSTALL_ROOT/personal
"
    local d
    for d in $dirs; do
        ck "dir $d"
        if [ -d "$d" ]; then
            ok "exists"
        else
            if mkdir -p "$d" 2>/dev/null; then
                ok "created"
            else
                die "dirtree" "mkdir -p '$d'" \
                    "Ensure your user has write access to the parent path."
            fi
        fi
    done
}

# ---------------------------------------------------------------------
# Claude skills wiring — leave existing dir untouched, else create empty.
# ---------------------------------------------------------------------
wire_claude_skills() {
    step "wiring \$HOME/.claude/skills"

    local claude_root="$HOME/.claude"
    local skills_root="$claude_root/skills"

    ck "$skills_root"
    if [ -d "$skills_root" ]; then
        ok "existing skills dir — leaving untouched"
        return 0
    fi
    if [ ! -d "$claude_root" ]; then
        if ! mkdir -p "$claude_root" 2>/dev/null; then
            die "claude-skills" "mkdir -p '$claude_root'" \
                "Ensure your user can write to \$HOME."
        fi
    fi
    if mkdir -p "$skills_root" 2>/dev/null; then
        ok "created empty skills dir"
    else
        die "claude-skills" "mkdir -p '$skills_root'" \
            "Create $skills_root manually."
    fi
}

# ---------------------------------------------------------------------
# uv sync
# ---------------------------------------------------------------------
run_uv_sync() {
    step "uv sync in $REPO_ROOT"
    ck "uv on PATH"
    if ! command -v uv >/dev/null 2>&1; then
        die "uv-sync" "uv sync" \
            "Install uv from https://docs.astral.sh/uv and re-run."
    fi
    ok "uv available"

    (
        cd "$REPO_ROOT" && uv sync
    )
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        die "uv-sync" "uv sync (in $REPO_ROOT)" \
            "Inspect uv output. Common cause: Python version mismatch — pyproject.toml requires Python >=3.12."
    fi
    ok "python venv synced"
}

# ---------------------------------------------------------------------
# npm install
# ---------------------------------------------------------------------
run_npm_install() {
    local cc="$REPO_ROOT/control-center"
    step "npm install in $cc"

    ck "control-center/ exists"
    if [ ! -d "$cc" ]; then
        warn "control-center/ missing — skipping npm install"
        return 0
    fi
    ok "found"

    ck "npm on PATH"
    if ! command -v npm >/dev/null 2>&1; then
        die "npm-install" "npm install" \
            "Install Node 22+ from https://nodejs.org (npm ships with it)."
    fi
    ok "npm available"

    (
        cd "$cc" && npm install
    )
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        die "npm-install" "npm install (in control-center/)" \
            "Delete control-center/node_modules and package-lock.json, then re-run."
    fi
    ok "node modules installed"
}

# ---------------------------------------------------------------------
# Feature toggles.
# ---------------------------------------------------------------------
ask_feature() {
    # ask_feature <name> <default 0|1> <note>
    # Echoes "true" or "false".
    local name="$1"
    local default="$2"
    local note="$3"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        if [ "$default" = "1" ]; then printf 'true'; else printf 'false'; fi
        return 0
    fi

    local label
    if [ "$default" = "1" ]; then label="Y/n"; else label="y/N"; fi

    local prompt
    if [ -n "$note" ]; then
        prompt="  $(printf '%-20s' "$name") [$label]  -- $note: "
    else
        prompt="  $(printf '%-20s' "$name") [$label]: "
    fi

    local tries=0
    local raw
    while [ "$tries" -lt 2 ]; do
        # `read -r -p` is POSIX-friendly in bash.
        read -r -p "$prompt" raw || raw=""
        if [ -z "$raw" ]; then
            if [ "$default" = "1" ]; then printf 'true'; else printf 'false'; fi
            return 0
        fi
        case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')" in
            y|yes) printf 'true'; return 0 ;;
            n|no)  printf 'false'; return 0 ;;
            *)
                printf '    please answer y or n (Enter = default)\n' 1>&2
                tries=$((tries + 1))
                ;;
        esac
    done
    if [ "$default" = "1" ]; then printf 'true'; else printf 'false'; fi
}

write_features() {
    step "feature toggles"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        info "non-interactive mode: using defaults"
    else
        info "Enable optional features? Press Enter to accept the default."
    fi

    local f_news f_gaming f_personal f_schedules f_self
    f_news=$(ask_feature      "News digest"      0 "default N (costs Gemini tokens)")
    f_gaming=$(ask_feature    "Gaming utilities" 1 "default Y")
    f_personal=$(ask_feature  "Personal section" 1 "default Y")
    f_schedules=$(ask_feature "Schedules"        1 "default Y")
    f_self=$(ask_feature      "Self-improve"     1 "default Y")

    local out_dir="$INSTALL_ROOT/cockpit"
    local out_file="$out_dir/features.json"
    mkdir -p "$out_dir"

    cat > "$out_file" <<EOF
{
  "news": $f_news,
  "gaming": $f_gaming,
  "personal": $f_personal,
  "schedules": $f_schedules,
  "self_improve": $f_self
}
EOF
    if [ ! -s "$out_file" ]; then
        die "features" "cat > $out_file" \
            "Check write permissions on $out_dir."
    fi
    ok "features.json written to $out_file"

    # Stash for the summary printout.
    FEATURE_NEWS="$f_news"
    FEATURE_GAMING="$f_gaming"
    FEATURE_PERSONAL="$f_personal"
    FEATURE_SCHEDULES="$f_schedules"
    FEATURE_SELF="$f_self"
}

# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
print_summary() {
    local v
    v="$(detect_version)"
    printf '\n'
    printf '=======================================================\n'
    printf ' ULTRON installer summary\n'
    printf '=======================================================\n'
    printf ' install root : %s\n' "$INSTALL_ROOT"
    printf ' repo root    : %s\n' "$REPO_ROOT"
    printf ' version      : %s\n' "$v"
    printf '\n features enabled:\n'
    printf '   [%s] news\n'         "$(label "$FEATURE_NEWS")"
    printf '   [%s] gaming\n'       "$(label "$FEATURE_GAMING")"
    printf '   [%s] personal\n'     "$(label "$FEATURE_PERSONAL")"
    printf '   [%s] schedules\n'    "$(label "$FEATURE_SCHEDULES")"
    printf '   [%s] self_improve\n' "$(label "$FEATURE_SELF")"
    if [ -n "$WARNINGS" ]; then
        printf '\n warnings (non-fatal):\n%s\n' "$WARNINGS"
    fi
    printf '\n next step:\n'
    printf '   cd control-center\n'
    printf '   npx tauri dev\n'
    printf '\n uninstall:\n'
    printf '   scripts/uninstall.sh\n'
    printf '=======================================================\n'
}

label() {
    # label <true|false>  ->  "on " or "off"
    if [ "$1" = "true" ]; then printf 'on '; else printf 'off'; fi
}

# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------
main() {
    banner
    preflight
    probe_dependencies
    make_tree
    wire_claude_skills
    run_uv_sync
    run_npm_install
    write_features
    print_summary
}

main
exit 0
