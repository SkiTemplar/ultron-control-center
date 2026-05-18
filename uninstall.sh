#!/usr/bin/env bash
# uninstall.sh — ULTRON Linux uninstall (mirror of uninstall.ps1).
#
# What it removes:
#   - ~/.ultron/                            (system files, plans, sessions, telemetry, qdrant native binary)
#   - ~/.local/bin/ultron-control-center    (AppImage launcher placed by bootstrap.sh)
#   - ~/.local/share/applications/ultron-control-center.desktop  (launcher)
#   - The ULTRON hooks block inside ~/.claude/settings.json (the rest of settings.json is preserved)
#
# What it KEEPS (by default):
#   - ~/.ultron-vault/                      (your long-term knowledge — opt-in to delete with -KeepBackups)
#   - ~/.claude/skills/                     (third-party skills you installed yourself)
#   - ~/.claude/agents/                     (third-party agents you installed yourself)
#   - The Linux package binary if installed via `.deb` (uninstall with: sudo apt remove ultron-control-center)
#
# Flags:
#   --dry-run                preview only, do not delete
#   --keep-backups           rename ~/.ultron → ~/.ultron-uninstalled-<ts> instead of deleting
#   --yes                    non-interactive, accept all prompts (CI / scripted)
#   --remove-vault           ALSO delete ~/.ultron-vault/ (irreversible)
#   -h, --help               show this banner

set -euo pipefail

DRY_RUN=0
KEEP_BACKUPS=0
ASSUME_YES=0
REMOVE_VAULT=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)        DRY_RUN=1 ;;
        --keep-backups)   KEEP_BACKUPS=1 ;;
        --yes|-y)         ASSUME_YES=1 ;;
        --remove-vault)   REMOVE_VAULT=1 ;;
        -h|--help)
            sed -n 's/^# \{0,1\}//p' "$0" | sed -n '/^uninstall\.sh/,/^$/p'
            exit 0
            ;;
        *)
            echo "[uninstall.sh] unknown flag: $1" >&2
            exit 64
            ;;
    esac
    shift
done

ULTRON_DIR="${HOME}/.ultron"
VAULT_DIR="${HOME}/.ultron-vault"
APPIMAGE_PATH="${HOME}/.local/bin/ultron-control-center"
DESKTOP_FILE="${HOME}/.local/share/applications/ultron-control-center.desktop"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"

step() { printf '\n[uninstall.sh] %s\n' "$*"; }
warn() { printf '[uninstall.sh][warn] %s\n' "$*" >&2; }
info() { printf '[uninstall.sh] %s\n' "$*"; }

confirm() {
    local prompt="$1"
    if [[ $ASSUME_YES -eq 1 ]]; then
        return 0
    fi
    read -r -p "${prompt} (y/N) " ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

remove_path() {
    local p="$1"
    if [[ ! -e "$p" ]]; then
        info "skip (not present): $p"
        return 0
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        info "[dry-run] would remove: $p"
        return 0
    fi
    rm -rf -- "$p"
    info "removed: $p"
}

step "ULTRON Linux uninstall"
info "Install root: ${ULTRON_DIR}"
info "Vault:        ${VAULT_DIR} (kept by default; pass --remove-vault to delete)"
info "AppImage:     ${APPIMAGE_PATH}"
info "Desktop file: ${DESKTOP_FILE}"
info "Mode:         $([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo destructive)"

if ! confirm "Proceed?"; then
    info "aborted by user"
    exit 0
fi

# 1. ULTRON system directory
if [[ -d "$ULTRON_DIR" ]]; then
    if [[ $KEEP_BACKUPS -eq 1 ]]; then
        ts="$(date +%Y%m%d-%H%M%S)"
        backup="${ULTRON_DIR}-uninstalled-${ts}"
        if [[ $DRY_RUN -eq 1 ]]; then
            info "[dry-run] would rename ${ULTRON_DIR} → ${backup}"
        else
            mv "$ULTRON_DIR" "$backup"
            info "renamed: ${ULTRON_DIR} → ${backup}"
        fi
    else
        remove_path "$ULTRON_DIR"
    fi
fi

# 2. AppImage + .desktop file
remove_path "$APPIMAGE_PATH"
remove_path "$DESKTOP_FILE"

# 3. Optional vault
if [[ $REMOVE_VAULT -eq 1 ]]; then
    remove_path "$VAULT_DIR"
else
    info "vault preserved: ${VAULT_DIR} (use --remove-vault to delete)"
fi

# 4. Strip the ULTRON PATH export from ~/.bashrc (install.sh appends one
#    marked with '# Added by ULTRON installer' so we can locate + remove it
#    surgically without touching unrelated user customisations).
if [[ -f "${HOME}/.bashrc" ]] && grep -q '# Added by ULTRON installer' "${HOME}/.bashrc"; then
    if [[ $DRY_RUN -eq 1 ]]; then
        info "[dry-run] would strip ULTRON PATH line from ~/.bashrc"
    else
        sed -i '/# Added by ULTRON installer/,/.npm-global\/bin/d' "${HOME}/.bashrc"
        info "stripped ULTRON PATH line from ~/.bashrc"
    fi
else
    info "skip ~/.bashrc cleanup (no ULTRON marker present)"
fi

# 5. Strip the ULTRON hooks block from ~/.claude/settings.json
#    (we wrote it during install.sh; remove it but leave the rest alone)
if [[ -f "$CLAUDE_SETTINGS" ]]; then
    if command -v jq >/dev/null 2>&1; then
        if [[ $DRY_RUN -eq 1 ]]; then
            info "[dry-run] would remove .hooks key from $CLAUDE_SETTINGS"
        else
            ts="$(date +%Y%m%d-%H%M%S)"
            cp "$CLAUDE_SETTINGS" "${CLAUDE_SETTINGS}.bak-uninstall-${ts}"
            jq 'del(.hooks)' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp"
            mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
            info "stripped .hooks from $CLAUDE_SETTINGS (backup: ${CLAUDE_SETTINGS}.bak-uninstall-${ts})"
        fi
    else
        warn "jq missing — leaving $CLAUDE_SETTINGS untouched. Remove the 'hooks' block manually."
    fi
else
    info "skip (not present): $CLAUDE_SETTINGS"
fi

step "Done."
info "If you installed the Control Center via .deb, also run: sudo apt remove ultron-control-center"
info "If installed via .AppImage only, the AppImage at ${APPIMAGE_PATH} has already been removed."
