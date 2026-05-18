#!/usr/bin/env bash
# === maintainer-only as of v15.5.16 (folded into stop-memory-sync.sh) ===
# =============================================================================
# ULTRON SessionEnd hook  (DEPRECATED for live hook use)
#
# As of v15.5.16 (internal-review-note consolidation) this script is NO LONGER wired into
# the Stop hook chain. Its behavior is inlined at the TAIL of
# scripts/hooks/stop-memory-sync.sh so the Stop chain spends one fewer
# bash launch per session.
#
# Kept on disk for manual maintainer use and parity with session-cleanup.ps1.
# See docs/MAINTAINERS.md.
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
