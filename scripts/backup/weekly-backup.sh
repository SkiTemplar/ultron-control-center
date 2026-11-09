#!/usr/bin/env bash
# weekly-backup.sh - Linux sibling of weekly-backup.ps1
#
# ULTRON v14.7 BACKUP-WATCH — weekly rsync backup (mirror, overwrite).
#
# Backs up the user's data sources to $ULTRON_BACKUP_ROOT/<src>/ (NO
# dated subdir). Each run overwrites the previous mirror via
# `rsync -a --delete` — single up-to-date snapshot, no history. Logs
# are still dated (~/.ultron/logs/backup-<DATE>.log). Reads exclusions
# from ~/.ultron/config/backup-exclusions.txt (gitignore-style).
# Designed to run via cron / systemd timer. Idempotent and safe:
# --delete removes destination files no longer in source.
#
# Usage:
#   weekly-backup.sh                    # run real backup
#   weekly-backup.sh --dry-run           # log what would happen, no copy
#   weekly-backup.sh --source .ultron    # restrict to a single source
#   weekly-backup.sh --status            # print last-run summary, exit
#
# --keep-weeks is accepted but ignored (kept for backward compat with
# the .ps1 sibling). Mirror mode does not retain history.
#
# Exit codes:
#   0 success / nothing to do
#   1 partial (some sources failed)
#   2 fatal: no destination configured, destination parent missing (drive
#     not mounted), or destination on the same device as a source. A fatal
#     abort still writes backup-last-run.json with status "failed",
#     aborted=true, error_code (no_destination | drive_missing |
#     same_volume) and error, like the .ps1 sibling.
#
# --keep-logs N (default 8) keeps the newest N dated backup logs.
# ULTRON_BACKUP_ALLOW_SAME_VOLUME=1 disables the same-device guard (selftest
# only; do not set it for real runs).
#
# Sources are anchored at $HOME. Paths configured below.
#
# Windows sibling: weekly-backup.ps1 in the same directory.

set -uo pipefail
# We deliberately do NOT use `set -e` because we want to accumulate
# per-source failures and report them in one pass, mirroring the .ps1.

# ── Argument parsing ─────────────────────────────────────────────────────

DRY_RUN=0
SOURCE_FILTER=""
KEEP_WEEKS=4
KEEP_LOGS=8
STATUS_ONLY=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run)      DRY_RUN=1; shift ;;
        --source)       SOURCE_FILTER="${2:-}"; shift 2 ;;
        --source=*)     SOURCE_FILTER="${1#*=}"; shift ;;
        --keep-weeks)   KEEP_WEEKS="${2:-4}"; shift 2 ;;
        --keep-logs)    KEEP_LOGS="${2:-8}"; shift 2 ;;
        --status)       STATUS_ONLY=1; shift ;;
        -h|--help)
            sed -n '1,30p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

# ── Configuration ────────────────────────────────────────────────────────

# Mirror the order/contents of the .ps1's $Sources array.
#
# Resolution order (v15.5.20: backups-modular-ui added the JSON UI layer):
#   1. ~/.ultron/cockpit/backup-config.json -> { "sources": ["..."] }
#      (written by Settings -> Backups -> Sources panel)
#   2. $ULTRON_BACKUP_SOURCES (comma-separated, fallback for CLI users)
#   3. Defaults: .ultron, .ultron-vault, .claude
# Personal trees like Documents / source / your-folder are opt-in via the UI.
DEFAULT_SOURCES=(
    ".ultron"
    ".ultron-vault"
    ".claude"
)
SOURCES_CONFIG_PATH="${HOME}/.ultron/cockpit/backup-config.json"
SOURCES=()
if [[ -r "${SOURCES_CONFIG_PATH}" ]]; then
    # Extract the "sources" array from JSON via Python (always present in installs);
    # fall back to env/defaults if parsing fails.
    while IFS= read -r line; do
        [[ -n "$line" ]] && SOURCES+=("$line")
    done < <(python3 -c "
import json, sys
try:
    with open('${SOURCES_CONFIG_PATH}', 'r', encoding='utf-8') as f:
        data = json.load(f)
    for s in (data.get('sources') or []):
        s = str(s).strip()
        if s:
            print(s)
except Exception as e:
    sys.stderr.write(f'warn: could not parse ${SOURCES_CONFIG_PATH}: {e}\n')
" 2>/dev/null)
fi
if [[ ${#SOURCES[@]} -eq 0 ]]; then
    if [[ -n "${ULTRON_BACKUP_SOURCES:-}" ]]; then
        IFS=', ' read -r -a SOURCES <<< "${ULTRON_BACKUP_SOURCES}"
    else
        SOURCES=( "${DEFAULT_SOURCES[@]}" )
    fi
fi

# Backup destination root. Resolution order MUST match
# control-center/src-tauri/src/backup_status/root.rs::backup_root():
#   1. ~/.ultron/.tmp/backup-root.txt  (set via Settings -> Backups UI)
#   2. $ULTRON_BACKUP_ROOT             (e.g. /mnt/backup)
#   3. nothing: the run aborts (exit 2, status "failed").
# 2026-10-23 (audit N1): the "$HOME/BACKUP" fallback was removed; a mirror
# on the same disk as the sources is not a backup.
BACKUP_ROOT_FILE="${HOME}/.ultron/.tmp/backup-root.txt"
BACKUP_ROOT=""
if [ -r "${BACKUP_ROOT_FILE}" ]; then
    BACKUP_ROOT="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' "${BACKUP_ROOT_FILE}" | head -n 1)"
fi
if [ -z "${BACKUP_ROOT}" ] && [ -n "${ULTRON_BACKUP_ROOT:-}" ]; then
    BACKUP_ROOT="${ULTRON_BACKUP_ROOT}"
fi
EXCLUSIONS_FILE="${HOME}/.ultron/config/backup-exclusions.txt"
LOG_DIR="${HOME}/.ultron/logs"
STATUS_FILE="${HOME}/.ultron/.tmp/backup-last-run.json"

# ── Status mode (early exit) ─────────────────────────────────────────────

if [ "${STATUS_ONLY}" -eq 1 ]; then
    if [ -f "${STATUS_FILE}" ]; then
        cat "${STATUS_FILE}"
    else
        printf '{"status":"never_run","status_file":"%s"}\n' "${STATUS_FILE}"
    fi
    exit 0
fi

# ── Pre-flight: destination (before rsync, so it also aborts without it) ─

if [ -n "${SOURCE_FILTER}" ]; then
    sources_to_run=("${SOURCE_FILTER}")
else
    sources_to_run=("${SOURCES[@]}")
fi

# Build JSON strings without depending on jq.
escape_json() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

source_abs() {
    case "$1" in
        /*) printf '%s' "$1" ;;
        *)  printf '%s' "${HOME}/$1" ;;
    esac
}

abort_run() {
    # abort_run <error_code> <message>: record the failure where the Control
    # Center reads the last run, then exit 2. Nothing has been copied.
    local code="$1" msg="$2" root_json="null" dry="false" srcs="" s
    [ -n "${BACKUP_ROOT}" ] && root_json="\"$(escape_json "${BACKUP_ROOT}")\""
    [ "${DRY_RUN}" -eq 1 ] && dry="true"
    for s in "${sources_to_run[@]}"; do
        srcs="${srcs:+${srcs},}\"$(escape_json "${s}")\""
    done
    mkdir -p "$(dirname "${STATUS_FILE}")"
    printf '{"last_run":"%s","date":"%s","dry_run":%s,"status":"failed","aborted":true,"error_code":"%s","error":"%s","sources":[%s],"results":{},"backup_root":%s,"any_failed":true}\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$(date '+%Y-%m-%d')" "${dry}" "${code}" \
        "$(escape_json "${msg}")" "${srcs}" "${root_json}" > "${STATUS_FILE}"
    echo "weekly-backup.sh: ABORT (${code}): ${msg}" >&2
    exit 2
}

device_of() {
    # Device id of a path, or of its nearest existing ancestor.
    local p="$1"
    while [ ! -e "${p}" ] && [ "${p}" != "/" ] && [ "${p}" != "." ]; do
        p="$(dirname "${p}")"
    done
    stat -c %d "${p}" 2>/dev/null || stat -f %d "${p}" 2>/dev/null
}

assert_destination() {
    if [ -z "${BACKUP_ROOT}" ]; then
        abort_run no_destination "No backup destination configured: pick one on another drive in Settings -> Backups (writes ~/.ultron/.tmp/backup-root.txt) or set ULTRON_BACKUP_ROOT. There is no fallback folder on the system disk."
    fi
    local parent
    parent="$(dirname "${BACKUP_ROOT}")"
    if [ -n "${parent}" ] && [ ! -d "${parent}" ]; then
        abort_run drive_missing "Backup parent dir missing (drive not mounted?): ${parent} (destination ${BACKUP_ROOT})."
    fi
    [ "${ULTRON_BACKUP_ALLOW_SAME_VOLUME:-}" = "1" ] && return 0
    local root_dev clash="" s s_abs
    root_dev="$(device_of "${BACKUP_ROOT}")"
    for s in "${sources_to_run[@]}"; do
        s_abs="$(source_abs "${s}")"
        [ -e "${s_abs}" ] || continue
        if [ "$(device_of "${s_abs}")" = "${root_dev}" ]; then
            clash="${clash:+${clash}, }${s}"
        fi
    done
    if [ -n "${clash}" ]; then
        abort_run same_volume "Destination ${BACKUP_ROOT} is on the same volume (device ${root_dev}) as the sources: ${clash}. A mirror on the same disk is not a backup; pick a folder on another drive."
    fi
}

assert_destination

# ── Required binaries (checked AFTER --status so a status query works on
#    boxes without rsync, mirroring the .ps1's early-exit ordering) ──────

if ! command -v rsync >/dev/null 2>&1; then
    echo "weekly-backup.sh: rsync is required but not installed" >&2
    exit 2
fi

# ── Helpers ──────────────────────────────────────────────────────────────

DATE_STR="$(date '+%Y-%m-%d')"
LOG_FILE="${LOG_DIR}/backup-${DATE_STR}.log"

mkdir -p "${LOG_DIR}"

log() {
    # log <level> <message>
    local level="$1"; shift
    local msg="$*"
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    printf '[%s] %s %s\n' "${ts}" "${level}" "${msg}" | tee -a "${LOG_FILE}"
}

# Parse the gitignore-style exclusions file into two arrays:
#   EXCLUDE_DIRS  - bare directory names (trailing slash in file, or no dot)
#   EXCLUDE_FILES - glob patterns matching files (containing a dot)
EXCLUDE_DIRS=()
EXCLUDE_FILES=()

read_exclusions() {
    local path="$1"
    if [ ! -f "${path}" ]; then
        return 0
    fi
    while IFS= read -r raw_line || [ -n "${raw_line}" ]; do
        # Trim leading/trailing whitespace.
        local line
        line="$(printf '%s' "${raw_line}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        # Skip blanks and comments.
        [ -z "${line}" ] && continue
        case "${line}" in
            \#*) continue ;;
        esac
        # Trailing slash -> directory.
        case "${line}" in
            */)
                EXCLUDE_DIRS+=("${line%/}")
                ;;
            *.*)
                # Contains a dot — treat as a file glob (matches the .ps1's
                # `-like "*.*"` heuristic).
                EXCLUDE_FILES+=("${line}")
                ;;
            *)
                # Bare name — defensive, treat as directory like the .ps1.
                EXCLUDE_DIRS+=("${line}")
                ;;
        esac
    done < "${path}"
}

read_exclusions "${EXCLUSIONS_FILE}"

# Build the rsync --exclude argument list. Directory excludes match at any
# depth; file excludes match by name. This mirrors robocopy /XD /XF
# semantics in the .ps1 sibling, which match by name (not full path).
RSYNC_EXCLUDES=()
for d in "${EXCLUDE_DIRS[@]:-}"; do
    [ -z "${d}" ] && continue
    RSYNC_EXCLUDES+=("--exclude=${d}/")
    RSYNC_EXCLUDES+=("--exclude=**/${d}/")
done
for f in "${EXCLUDE_FILES[@]:-}"; do
    [ -z "${f}" ] && continue
    RSYNC_EXCLUDES+=("--exclude=${f}")
done

invoke_rsync() {
    # invoke_rsync <source> <dest>
    local src_path="$1"
    local dst_path="$2"

    if [ ! -d "${src_path}" ]; then
        log WARN "SKIP: source missing: ${src_path}"
        # Use a sentinel code analogous to robocopy 16 (fatal).
        RSYNC_LAST_CODE=16
        RSYNC_LAST_SKIPPED=1
        return 0
    fi

    RSYNC_LAST_SKIPPED=0

    local mode
    if [ "${DRY_RUN}" -eq 1 ]; then mode="DRY-RUN"; else mode="COPY"; fi
    log INFO "rsync ${src_path}/ -> ${dst_path}/ (${mode})"

    # Trailing slash on src makes rsync mirror src's contents into dst
    # (not src itself nested inside dst). Matches robocopy /MIR semantics.
    local rsync_args=(-a --delete --human-readable)
    if [ "${DRY_RUN}" -eq 1 ]; then rsync_args+=(--dry-run); fi
    rsync_args+=("${RSYNC_EXCLUDES[@]:-}")
    rsync_args+=("${src_path}/" "${dst_path}/")

    if rsync "${rsync_args[@]}" >>"${LOG_FILE}" 2>&1; then
        RSYNC_LAST_CODE=0
    else
        RSYNC_LAST_CODE=$?
    fi
}

rsync_ok() {
    # rsync exit codes: 0 = success, 23/24 = partial (vanished files,
    # usually harmless), anything else = fatal. Map to the .ps1's
    # `<8 means ok` heuristic — we treat 0/23/24 as "ok".
    case "${1}" in
        0|23|24) return 0 ;;
        *)       return 1 ;;
    esac
}

remove_legacy_dated_backups() {
    # One-shot cleanup: remove old YYYY-MM-DD dated subdirs left over from
    # the pre-mirror version of this script. Safe to call repeatedly.
    local root="$1"
    [ -d "${root}" ] || return 0
    local dir base
    for dir in "${root}"/*/; do
        [ -d "${dir}" ] || continue
        base="$(basename "${dir}")"
        if printf '%s' "${base}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
            log INFO "CLEANUP: removing legacy dated backup ${dir}"
            if [ "${DRY_RUN}" -eq 0 ]; then
                rm -rf "${dir}"
            fi
        fi
    done
}

# ── Pre-flight ───────────────────────────────────────────────────────────

# The destination checks ran in assert_destination (before rsync).

mkdir -p "${BACKUP_ROOT}"

log INFO "v14.7 BACKUP-WATCH start (DryRun=${DRY_RUN}, mode=mirror-overwrite)"
log INFO "exclusions: ${#EXCLUDE_DIRS[@]} dirs · ${#EXCLUDE_FILES[@]} files"
log INFO "destination root: ${BACKUP_ROOT} (one folder per source, mirrored)"

# ── Per-source backup ────────────────────────────────────────────────────

any_failed=0
declare -a RESULT_NAMES=()
declare -a RESULT_CODES=()
declare -a RESULT_SKIPPED=()

for src in "${sources_to_run[@]}"; do
    src_abs="${HOME}/${src}"
    # Match .ps1: absolute sources are used as-is and mirrored to
    # abs-<sanitised path>; hidden sources (.something) get a "dot-something"
    # destination dir for explorer friendliness.
    case "${src}" in
        /*)
            src_abs="${src}"
            slug="$(printf '%s' "${src}" | sed -E 's#[/:]+#-#g; s#^-##; s#-$##')"
            dst_abs="${BACKUP_ROOT}/abs-${slug}"
            ;;
        .*)
            dst_abs="${BACKUP_ROOT}/dot-${src#.}"
            ;;
        *)
            dst_abs="${BACKUP_ROOT}/${src}"
            ;;
    esac
    # Only create the destination when the source exists, so a missing
    # source does not leave an empty mirror with a fresh mtime.
    if [ -d "${src_abs}" ]; then mkdir -p "${dst_abs}"; fi

    invoke_rsync "${src_abs}" "${dst_abs}"

    RESULT_NAMES+=("${src}")
    RESULT_CODES+=("${RSYNC_LAST_CODE}")
    RESULT_SKIPPED+=("${RSYNC_LAST_SKIPPED}")

    if [ "${RSYNC_LAST_SKIPPED}" -eq 1 ]; then
        # A configured source that does not exist is a failure, not a skip.
        any_failed=1
        log ERROR "FAIL: ${src} source missing (${src_abs})"
    elif ! rsync_ok "${RSYNC_LAST_CODE}"; then
        any_failed=1
        log ERROR "FAIL: ${src} rsync exit code ${RSYNC_LAST_CODE}"
    else
        log INFO "OK: ${src} rsync exit code ${RSYNC_LAST_CODE}"
        # v15.4.7 — touch destination mtime so the Doctor backup-stale
        # detector sees a fresh timestamp even when rsync had no deltas.
        if [ "${DRY_RUN}" -eq 0 ] && [ -d "${dst_abs}" ]; then
            touch "${dst_abs}" 2>/dev/null \
                || log WARN "could not touch mtime on ${dst_abs}"
        fi
    fi
done

# ── Retention prune ─────────────────────────────────────────────────────

if [ -z "${SOURCE_FILTER}" ]; then
    remove_legacy_dated_backups "${BACKUP_ROOT}"
fi

# ── Persist status ──────────────────────────────────────────────────────

mkdir -p "$(dirname "${STATUS_FILE}")"

# Build JSON arrays / object without depending on jq (escape_json is
# defined in the destination pre-flight).

sources_json=""
for s in "${sources_to_run[@]}"; do
    if [ -z "${sources_json}" ]; then
        sources_json="\"$(escape_json "${s}")\""
    else
        sources_json="${sources_json},\"$(escape_json "${s}")\""
    fi
done

results_json=""
i=0
while [ "${i}" -lt "${#RESULT_NAMES[@]}" ]; do
    name="${RESULT_NAMES[${i}]}"
    code="${RESULT_CODES[${i}]}"
    skipped="${RESULT_SKIPPED[${i}]}"
    skipped_bool="false"
    [ "${skipped}" -eq 1 ] && skipped_bool="true"
    ok_bool="false"
    if rsync_ok "${code}"; then ok_bool="true"; fi
    failed_bool="false"
    if [ "${skipped_bool}" = "true" ] || [ "${ok_bool}" = "false" ]; then failed_bool="true"; fi
    entry="\"$(escape_json "${name}")\":{\"code\":${code},\"skipped\":${skipped_bool},\"ok\":${ok_bool},\"failed\":${failed_bool}}"
    if [ -z "${results_json}" ]; then
        results_json="${entry}"
    else
        results_json="${results_json},${entry}"
    fi
    i=$((i + 1))
done

dry_run_bool="false"
[ "${DRY_RUN}" -eq 1 ] && dry_run_bool="true"

last_run="$(date '+%Y-%m-%dT%H:%M:%S%z')"

# UTF-8, no BOM.
{
    printf '{'
    printf '"last_run":"%s",' "${last_run}"
    printf '"date":"%s",' "${DATE_STR}"
    printf '"dry_run":%s,' "${dry_run_bool}"
    if [ "${any_failed}" -eq 1 ]; then printf '"status":"failed",'; else printf '"status":"ok",'; fi
    printf '"aborted":false,'
    printf '"sources":[%s],' "${sources_json}"
    printf '"results":{%s},' "${results_json}"
    printf '"log":"%s",' "$(escape_json "${LOG_FILE}")"
    printf '"backup_root":"%s",' "$(escape_json "${BACKUP_ROOT}")"
    printf '"keep_weeks":%d,' "${KEEP_WEEKS}"
    if [ "${any_failed}" -eq 1 ]; then printf '"any_failed":true'; else printf '"any_failed":false'; fi
    printf '}\n'
} > "${STATUS_FILE}"

log INFO "v14.7 BACKUP-WATCH end · failed=${any_failed}"

# Log retention (audit N5): keep the newest KEEP_LOGS dated logs of each
# kind; the date prefix makes the name order chronological.
prune_old_logs() {
    local pattern f
    for pattern in '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}\.log(\.gz)?$' \
                   '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}\.robocopy\.log(\.gz)?$'; do
        # shellcheck disable=SC2012
        ls -1 "${LOG_DIR}" 2>/dev/null | grep -E "${pattern}" | sort -r | tail -n +"$((KEEP_LOGS + 1))" |
            while IFS= read -r f; do
                if [ "${DRY_RUN}" -eq 1 ]; then
                    log INFO "CLEANUP (dry-run): would prune old log ${f}"
                elif rm -f -- "${LOG_DIR}/${f}"; then
                    log INFO "CLEANUP: pruned old log ${f}"
                else
                    log WARN "could not prune ${f}"
                fi
            done
    done
}
prune_old_logs

if [ "${any_failed}" -eq 1 ]; then
    exit 1
fi
exit 0
