#!/usr/bin/env bash
# ensure-qdrant.sh - Linux sibling of ensure-qdrant.ps1
#
# Background hook called from the ULTRON-QdrantBoot scheduled job (and
# SessionStart). Goal: when the user logs in, guarantee Qdrant is up
# *eventually*, without blocking. Status to
# ~/.ultron/.tmp/qdrant-health.json for the panel + context_primer.
#
# Strategy (mirrors the .ps1 sibling — v15.0.2+: Docker eliminado):
#   1. Probe http://localhost:6333/healthz. If it responds, done.
#   2. Otherwise launch the native binary ~/.ultron/qdrant-native/qdrant
#      (extracted from the Linux tarball, NOT qdrant.exe) and wait for
#      healthz (60s).
#   3. If the binary doesn't exist or won't start -> status native-failed
#      or native-missing.
#
# Exit codes:
#   0 up             - healthz 200 from someone
#   3 unhealthy      - service answered but not 200
#   6 native-failed  - native binary present but won't start
#   7 native-missing - native binary not installed at all
#
# Windows sibling: ensure-qdrant.ps1 in the same directory.

set -euo pipefail

MAX_WAIT_SEC=60
POLL_SEC=2

TMP_DIR="${HOME}/.ultron/.tmp"
mkdir -p "${TMP_DIR}"
OUT="${TMP_DIR}/qdrant-health.json"

# Require curl for the healthz probe. nc would also work, but curl gives
# us the HTTP status code cleanly.
if ! command -v curl >/dev/null 2>&1; then
    printf '{"status":"native-failed","message":"curl not installed; cannot probe healthz","elapsed_sec":0,"timestamp":"%s"}\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S%z')" > "${OUT}"
    echo "ensure-qdrant.sh: curl is required but not found in PATH" >&2
    exit 6
fi

write_state() {
    # write_state <status> <message> <elapsed_sec>
    local status="$1"
    local message="$2"
    local elapsed="${3:-0}"
    local ts
    ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
    # Escape backslashes and double-quotes in the message for safe JSON.
    local escaped_msg
    escaped_msg=$(printf '%s' "${message}" | sed 's/\\/\\\\/g; s/"/\\"/g')
    # Write UTF-8 without BOM.
    printf '{"status":"%s","message":"%s","elapsed_sec":%d,"timestamp":"%s"}\n' \
        "${status}" "${escaped_msg}" "${elapsed}" "${ts}" > "${OUT}"
}

test_healthz() {
    # test_healthz [timeout_sec]
    local timeout="${1:-3}"
    local code
    code=$(curl -fsS -o /dev/null -w '%{http_code}' \
        --max-time "${timeout}" \
        'http://localhost:6333/healthz' 2>/dev/null || echo "000")
    [ "${code}" = "200" ]
}

# ========================================================================
# Phase 1: probe healthz first. If anyone's already serving, we're done.
# ========================================================================
if test_healthz 3; then
    write_state 'up' 'Qdrant healthz OK (already running)' 0
    exit 0
fi

# ========================================================================
# Phase 2: try native qdrant binary (primary path post-v15.0.2).
# ========================================================================
NATIVE_DIR="${HOME}/.ultron/qdrant-native"
NATIVE_BIN="${NATIVE_DIR}/qdrant"
NATIVE_CFG="config/production.yaml"

if [ -x "${NATIVE_BIN}" ]; then
    # Kill any lingering qdrant process that may be in a bad state.
    if pgrep -x qdrant >/dev/null 2>&1; then
        pkill -x qdrant 2>/dev/null || true
        sleep 2
    fi

    LOG_FILE="${TMP_DIR}/qdrant-native.log"
    ERR_FILE="${TMP_DIR}/qdrant-native.err"

    # Launch detached in the background. nohup + setsid keeps it alive
    # after this script exits, mirroring Start-Process -WindowStyle Hidden.
    if ! (
        cd "${NATIVE_DIR}" && \
        nohup setsid "${NATIVE_BIN}" --config-path "${NATIVE_CFG}" \
            >"${LOG_FILE}" 2>"${ERR_FILE}" </dev/null &
    ); then
        write_state 'native-failed' "Failed to launch ${NATIVE_BIN}" 0
        exit 6
    fi

    # Wait up to MAX_WAIT_SEC for the native binary to start serving.
    elapsed=0
    while [ "${elapsed}" -lt "${MAX_WAIT_SEC}" ]; do
        sleep "${POLL_SEC}"
        elapsed=$((elapsed + POLL_SEC))
        if test_healthz 2; then
            write_state 'up' "Qdrant native binary up (${elapsed}s warm-up)" "${elapsed}"
            exit 0
        fi
    done

    write_state 'native-failed' \
        "Native qdrant launched but healthz unreachable after ${elapsed}s. See ${LOG_FILE}" \
        "${elapsed}"
    exit 6
fi

# ========================================================================
# Phase 3: No native binary installed.
# ========================================================================
write_state 'native-missing' \
    "Native qdrant binary not found at ${NATIVE_BIN}. Extract the v1.18.0 Linux tarball into ${NATIVE_DIR} and re-run." \
    0
exit 7
