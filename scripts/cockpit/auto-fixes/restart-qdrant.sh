#!/usr/bin/env bash
# auto-fixes/restart-qdrant.sh - Linux sibling of restart-qdrant.ps1
#
# Restarts the local Qdrant native binary if it's unhealthy.
#
# Strategy (mirrors restart-qdrant.ps1):
#   1. pkill any stale qdrant process in the user session
#      (the .ps1 sibling uses `Stop-Process -Name qdrant -Force`).
#   2. Hand off to scripts/hooks/ensure-qdrant.sh, which knows the
#      native-binary boot path and waits for /healthz.
#
# Returns a single-line JSON {fix, actions[], success, error} report so
# the Dashboard "Apply selected fixes" panel can render the outcome.
#
# Windows sibling: restart-qdrant.ps1 in the same directory.

set -euo pipefail

# We accumulate actions in a single string (one per line) and serialize
# to a JSON array at the end. Avoids needing jq.
actions=""
success="false"
error="null"

append_action() {
    if [ -z "${actions}" ]; then
        actions="$1"
    else
        actions="${actions}"$'\n'"$1"
    fi
}

emit_report() {
    # Convert the accumulated newline-separated actions list into a JSON
    # array, escaping backslashes and double-quotes.
    local json_actions="[]"
    if [ -n "${actions}" ]; then
        local items=""
        while IFS= read -r line; do
            local escaped
            escaped=$(printf '%s' "${line}" | sed 's/\\/\\\\/g; s/"/\\"/g')
            if [ -z "${items}" ]; then
                items="\"${escaped}\""
            else
                items="${items},\"${escaped}\""
            fi
        done <<< "${actions}"
        json_actions="[${items}]"
    fi

    local err_field
    if [ "${error}" = "null" ]; then
        err_field="null"
    else
        local escaped_err
        escaped_err=$(printf '%s' "${error}" | sed 's/\\/\\\\/g; s/"/\\"/g')
        err_field="\"${escaped_err}\""
    fi

    printf '{"fix":"restart-qdrant","actions":%s,"success":%s,"error":%s}\n' \
        "${json_actions}" "${success}" "${err_field}"
}

# 1) Kill any stale qdrant processes.
if pgrep -x qdrant >/dev/null 2>&1; then
    count=$(pgrep -x qdrant | wc -l | tr -d ' ')
    append_action "stop-process qdrant (${count} process(es))"
    pkill -x qdrant 2>/dev/null || true
    sleep 1
fi

# 2) Hand off to ensure-qdrant.sh — the canonical boot path.
ENSURE="${HOME}/.ultron/scripts/hooks/ensure-qdrant.sh"
if [ -f "${ENSURE}" ]; then
    append_action "ensure-qdrant.sh"
    if bash "${ENSURE}" >/dev/null 2>&1; then
        success="true"
    else
        rc=$?
        # ensure-qdrant.sh exits non-zero on failure but still writes a
        # detailed status file. We surface only the success flag here.
        success="false"
        error="ensure-qdrant.sh exit code ${rc}"
    fi
else
    error="ensure-qdrant.sh missing at ${ENSURE}"
fi

emit_report
