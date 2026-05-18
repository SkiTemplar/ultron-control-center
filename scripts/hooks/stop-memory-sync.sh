#!/usr/bin/env bash
# =============================================================================
# ULTRON Stop hook (Linux sibling of stop-memory-sync.ps1).
#
# Always runs (every session, cheap local ops):
#   - memory_bridge ingest
#   - brain_index update
#   - decay_queue prime
#   - embed_vault / embed_skills / embed_agents (best-effort, Qdrant may be down)
#   - context_primer regenerate
#
# HIGH/ULTRA only (memory_sync.py reports should-push exit 0):
#   - vault sync + push-async
#   - session_compactor (Codex)
#
# Failures are logged but never block Stop (exit 0 always).
# Debounce: skip Phase A entirely if same session fired <90s ago.
# =============================================================================
set -uo pipefail

ULTRON_DIR="${HOME}/.ultron"
VAULT_DIR="${HOME}/.ultron-vault"
TMP_DIR="${ULTRON_DIR}/.tmp"
LOG_FILE="${ULTRON_DIR}/logs/stop-memory-sync.log"
COCKPIT="${ULTRON_DIR}/scripts/cockpit"
SYNC_SCRIPT="${COCKPIT}/memory_sync.py"
DEBOUNCE_PATH="${TMP_DIR}/last-stop-sync.json"
DEBOUNCE_WINDOW=90

mkdir -p "${TMP_DIR}" "$(dirname "${LOG_FILE}")"

log() {
    local ts; ts="$(date '+%Y-%m-%d %H:%M:%S')"
    printf '[%s] %s\n' "$ts" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# Read stdin session_id (best-effort grep).
STDIN_SID=""
if [[ ! -t 0 ]]; then
    STDIN_RAW="$(cat 2>/dev/null || echo '')"
    STDIN_SID="$(printf '%s' "$STDIN_RAW" \
        | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | head -1 \
        | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
fi

# Debounce — same session_id within DEBOUNCE_WINDOW seconds = skip.
if [[ -n "$STDIN_SID" && -r "$DEBOUNCE_PATH" ]]; then
    LAST_SID="$(grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' "$DEBOUNCE_PATH" 2>/dev/null \
        | head -1 \
        | sed -E 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    LAST_TS="$(grep -oE '"ts"[[:space:]]*:[[:space:]]*"[^"]+"' "$DEBOUNCE_PATH" 2>/dev/null \
        | head -1 \
        | sed -E 's/.*"ts"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    if [[ "$LAST_SID" == "$STDIN_SID" && -n "$LAST_TS" ]]; then
        NOW_EPOCH="$(date +%s)"
        LAST_EPOCH="$(date -d "$LAST_TS" +%s 2>/dev/null || echo 0)"
        if (( NOW_EPOCH - LAST_EPOCH < DEBOUNCE_WINDOW )); then
            log "DEBOUNCE: same session ${STDIN_SID} fired $((NOW_EPOCH - LAST_EPOCH))s ago — skipping"
            exit 0
        fi
    fi
fi

# Record this fire BEFORE the work so a crash doesn't disable debounce.
cat > "$DEBOUNCE_PATH" <<JSON 2>/dev/null || true
{"session_id": "${STDIN_SID}", "ts": "$(date -Iseconds)"}
JSON

# Resolve Python launcher.
PY=""
if command -v uv >/dev/null 2>&1; then
    PY="uv run python"
else
    PY="python"
fi

run_py() {
    local script="$1"; shift
    [[ -f "$script" ]] || { log "skip: $(basename "$script") not found"; return 0; }
    timeout 30 $PY "$script" "$@" >/dev/null 2>&1 || true
}

# Phase A — always (cheap local ops). Linux runs sequentially with a 30s
# timeout per script; the Windows version parallelises with Start-Job, but
# bash + timeout keeps it simple and bounded.
PHASE_A=(
    "memory_bridge.py:ingest"
    "brain_index.py:update"
    "route_quality_aggregator.py:aggregate --today"
    "decay_queue.py:prime --output ${TMP_DIR}/decay-prime.json"
    "embed_vault.py:index"
    "embed_skills.py:index"
    "embed_agents.py:index"
    "skill_vault.py:registry"
    "system_snapshot.py:refresh --quiet --skip-doctor"
    "memory_md_generator.py:generate"
)

PHASE_A_START="$(date +%s)"
for entry in "${PHASE_A[@]}"; do
    script_name="${entry%%:*}"
    args_str="${entry#*:}"
    script="${COCKPIT}/${script_name}"
    # shellcheck disable=SC2086 # intentional word splitting of args_str
    run_py "$script" $args_str
    log "phase-A ${script_name} done"
done
log "phase-A elapsed=$(( $(date +%s) - PHASE_A_START ))s"

# Always run context_primer last so next SessionStart has fresh context.md.
PRIMER="${COCKPIT}/context_primer.py"
if [[ -f "$PRIMER" ]]; then
    timeout 8 $PY "$PRIMER" generate >/dev/null 2>&1 || log "context_primer timeout/err"
fi

# Phase B — HIGH+ only (vault push + Codex compactor).
[[ -f "$SYNC_SCRIPT" ]] || { log "skip phase-B: memory_sync.py not found"; exit 0; }
[[ -d "$VAULT_DIR" ]]   || { log "skip phase-B: vault not found"; exit 0; }

if ! $PY "$SYNC_SCRIPT" should-push >/dev/null 2>&1; then
    log "skip phase-B: session not HIGH+"
    exit 0
fi

timeout 30 $PY "$SYNC_SCRIPT" sync       >/dev/null 2>&1 || log "vault sync err"
if git -C "$VAULT_DIR" remote get-url origin >/dev/null 2>&1; then
    timeout 30 $PY "$SYNC_SCRIPT" push-async >/dev/null 2>&1 || log "push-async err"
fi

COMPACTOR="${COCKPIT}/session_compactor.py"
if [[ -f "$COMPACTOR" ]]; then
    if [[ -n "$STDIN_SID" ]]; then
        timeout 60 $PY "$COMPACTOR" run --session-id "$STDIN_SID" >/dev/null 2>&1 || log "compactor err"
    else
        timeout 60 $PY "$COMPACTOR" auto >/dev/null 2>&1 || log "compactor auto err"
    fi
fi

HIGHLIGHTS="${COCKPIT}/session_highlights.py"
if [[ -f "$HIGHLIGHTS" ]]; then
    timeout 10 $PY "$HIGHLIGHTS" extract-recent --limit 3 >/dev/null 2>&1 || true
    timeout 10 $PY "$HIGHLIGHTS" prime --max 5 >/dev/null 2>&1 || true
fi

exit 0
