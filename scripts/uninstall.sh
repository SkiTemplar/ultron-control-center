#!/usr/bin/env bash
#
# ULTRON v15.2 uninstaller (POSIX bash).
#
# Removes $HOME/.ultron/ after preserving any existing backups.
# Does NOT touch $HOME/.claude/ (global Claude Code CLI state).
#
# Usage:
#   ./scripts/uninstall.sh         # interactive
#   ./scripts/uninstall.sh --yes   # CI / no prompt

set -u

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.ultron}"
ASSUME_YES=0

for arg in "$@"; do
    case "$arg" in
        -y|--yes) ASSUME_YES=1 ;;
        --install-root=*) INSTALL_ROOT="${arg#*=}" ;;
        -h|--help)
            sed -n '2,15p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $arg"
            exit 1
            ;;
    esac
done

step() { printf '[ STEP ] %s\n' "$1"; }
ok()   { printf '  ok    %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }

die() {
    printf '\n'
    printf 'UNINSTALL FAILED at stage: %s\n' "$1"
    printf '  command : %s\n' "$2"
    printf '  fix     : %s\n' "$3"
    printf '\n'
    exit 1
}

printf '\n'
printf '=======================================================\n'
printf ' ULTRON uninstaller\n'
printf '=======================================================\n'
printf ' target : %s\n' "$INSTALL_ROOT"
printf '\n'

if [ ! -d "$INSTALL_ROOT" ]; then
    printf 'Nothing to do — install root does not exist:\n'
    printf '  %s\n' "$INSTALL_ROOT"
    exit 0
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_SRC="$INSTALL_ROOT/backups"
PARENT_DIR="$(dirname "$INSTALL_ROOT")"
BACKUP_DST="$PARENT_DIR/.ultron-backup-$TS"

printf 'This will:\n'
printf '  1. Move %s (if it exists) to %s\n' "$BACKUP_SRC" "$BACKUP_DST"
printf '  2. Remove %s\n' "$INSTALL_ROOT"
printf '  3. Leave $HOME/.claude/ untouched (global Claude CLI state)\n'
printf '\n'

if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "Continue? [y/N]: " answer || answer=""
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
        y|yes) ;;
        *) printf 'Aborted.\n'; exit 0 ;;
    esac
fi

step "preserving backups"
if [ -d "$BACKUP_SRC" ]; then
    if mv "$BACKUP_SRC" "$BACKUP_DST" 2>/dev/null; then
        ok "backups moved to $BACKUP_DST"
    else
        die "preserve-backups" "mv $BACKUP_SRC -> $BACKUP_DST" \
            "Close any process holding files inside backups/ and re-run."
    fi
else
    info "no backups/ directory found — nothing to preserve"
fi

step "removing $INSTALL_ROOT"
if rm -rf "$INSTALL_ROOT" 2>/dev/null; then
    ok "install root removed"
else
    die "remove-root" "rm -rf $INSTALL_ROOT" \
        "Close any shell or editor with a working directory inside ~/.ultron and re-run."
fi

printf '\n'
printf '=======================================================\n'
printf ' ULTRON uninstall complete\n'
printf '=======================================================\n'
if [ -d "$BACKUP_DST" ]; then
    printf ' Backups preserved at: %s\n' "$BACKUP_DST"
fi
printf ' $HOME/.claude/ was NOT touched.\n'
printf '=======================================================\n'
exit 0
