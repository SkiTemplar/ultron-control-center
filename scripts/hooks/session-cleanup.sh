#!/usr/bin/env bash
# =============================================================================
# ULTRON SessionEnd hook (Linux sibling of session-cleanup.ps1).
#
# Trims ephemeral state under ~/.ultron/.tmp/ that should not survive past
# the end of a session. Best-effort, never blocks session close.
# =============================================================================
set -uo pipefail

TMP_DIR="${HOME}/.ultron/.tmp"
[[ -d "$TMP_DIR" ]] || exit 0

# Remove session-scoped JSON state. Keep aggregated caches (decay-prime,
# recent-highlights, pending-actions-primed) since SessionStart consumes
# them next time and re-priming costs ~1-2s per file.
EPHEMERAL=(
    "current-session.json"
    "current-session-mode.json"
)
for f in "${EPHEMERAL[@]}"; do
    rm -f "${TMP_DIR}/${f}" 2>/dev/null || true
done

# Truncate per-session brain_update / mcp_health logs so they don't grow
# unbounded across days.
for log in brain_update mcp_health generate_L0; do
    : > "${TMP_DIR}/${log}.log" 2>/dev/null || true
    : > "${TMP_DIR}/${log}_err.log" 2>/dev/null || true
done

exit 0
