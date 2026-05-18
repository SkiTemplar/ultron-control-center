#!/usr/bin/env bash
# =============================================================================
# ULTRON SessionStart hook (Linux sibling of session-init.ps1).
#
# Claude Code passes session metadata via stdin (JSON). We:
#   1. Capture session_id (8-char prefix) and the MODE arg
#   2. Generate current-session.json
#   3. Best-effort: fire context_primer.py to regenerate context.md
#
# Failures are logged but never block session start (exit 0 always).
# =============================================================================
set -uo pipefail

MODE="${1:-MEDIUM}"
SESSION_ID="${2:-}"

ULTRON_DIR="${HOME}/.ultron"
TMP_DIR="${ULTRON_DIR}/.tmp"
mkdir -p "$TMP_DIR"

# Read stdin if redirected (Claude Code passes JSON; we tolerate missing).
if [[ -p /dev/stdin || ! -t 0 ]]; then
    STDIN_RAW="$(cat 2>/dev/null || echo '')"
    if [[ -n "$STDIN_RAW" ]]; then
        # Tiny grep — avoids requiring jq for a single field.
        STDIN_SID="$(printf '%s' "$STDIN_RAW" \
            | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
            | head -1 \
            | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
        if [[ -n "$STDIN_SID" && -z "$SESSION_ID" ]]; then
            SESSION_ID="${STDIN_SID:0:8}"
        fi
    fi
fi

# Fallback id from /proc/sys/kernel/random/uuid (always present on Linux).
if [[ -z "$SESSION_ID" ]]; then
    if [[ -r /proc/sys/kernel/random/uuid ]]; then
        SESSION_ID="$(cut -c1-8 < /proc/sys/kernel/random/uuid)"
    else
        SESSION_ID="$(printf '%08x' $RANDOM$RANDOM | head -c 8)"
    fi
fi

echo "[OK] ULTRON session init - MODE=${MODE}"

# Write current-session.json (cheap, no deps).
START_TIME="$(date '+%Y-%m-%d %H:%M:%S')"
cat > "${TMP_DIR}/current-session.json" <<JSON
{
  "SessionId": "${SESSION_ID}",
  "Mode": "${MODE}",
  "StartTime": "${START_TIME}",
  "MemoryReady": true
}
JSON

# Fire context_primer in background with a small timeout — degrades silently.
PRIMER="${ULTRON_DIR}/scripts/cockpit/context_primer.py"
if [[ -x "$(command -v uv 2>/dev/null)" && -f "$PRIMER" ]]; then
    ( timeout 8 uv run python "$PRIMER" generate >/dev/null 2>&1 || true ) &
fi

echo "[OK] Session ready - primed (see ~/.ultron/.tmp/current-session.json)"
exit 0
