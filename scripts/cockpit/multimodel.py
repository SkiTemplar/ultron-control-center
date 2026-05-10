"""
multimodel.py — ULTRON S2-C MMFP CLI
=====================================
Manages multi-model file-persistent peer-review requests.

Usage (via ultron dispatcher):
  ultron multimodel list                      # pending requests (no response yet)
  ultron multimodel list --all                # include processed/archived
  ultron multimodel show <id>                 # print request YAML + response JSON
  ultron multimodel process <id>              # invoke shared-duet.ps1 with request params
  ultron multimodel archive --older-than 7d   # move processed requests >N days to archive/
  ultron multimodel clean --dry-run           # preview archive without moving files

Direct invocation (dev/test):
  uv run python multimodel.py list
  uv run python multimodel.py process req-20260505-153000-a1b2c3d4
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import yaml  # PyYAML — installed for S2-B
except ImportError:
    yaml = None  # type: ignore

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

MMFP_ROOT  = Path.home() / ".ultron" / "multimodel"
REQUESTS   = MMFP_ROOT / "requests"
RESPONSES  = MMFP_ROOT / "responses"
CONSENSUS  = MMFP_ROOT / "consensus"
ARCHIVE    = MMFP_ROOT / "archive"

SHARED_DUET = (
    Path.home()
    / ".claude" / "skills" / "ultron" / "scripts" / "shared-duet.ps1"
)

# PILAR I: subprocess flags — no popup window
CREATE_NO_WINDOW = 0x08000000


def _ensure_dirs() -> None:
    for d in (REQUESTS, RESPONSES, CONSENSUS, ARCHIVE):
        d.mkdir(parents=True, exist_ok=True)


# Strict regex for request IDs. Format: req-YYYYMMDD-HHMMSS-fff-hash8 (subagent
# format) — but we accept any non-empty alnum/underscore/dash/dot id. The
# enforced character class blocks path traversal payloads (../, drive letters,
# absolute paths, NUL bytes, etc.).
_REQ_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class InvalidRequestId(ValueError):
    """Raised when a request_id fails validation or escapes the MMFP root."""


def _validate_request_id(req_id: str) -> str:
    """Codex C1 fix: sanitize request_id before using in path construction.

    1. Must match the strict charset regex (alnum + . _ -)
    2. Must NOT contain '..' substring (defense-in-depth — regex already excludes it)
    3. Resolved paths in REQUESTS/RESPONSES/CONSENSUS/ARCHIVE must stay
       inside MMFP_ROOT after Path.resolve() (catches symlink escapes if any).
    Returns the sanitized id. Raises InvalidRequestId on any violation.
    """
    if not isinstance(req_id, str) or not _REQ_ID_RE.fullmatch(req_id):
        raise InvalidRequestId(f"invalid request_id: {req_id!r}")
    if ".." in req_id:
        raise InvalidRequestId(f"request_id contains '..': {req_id!r}")
    # Containment check: resolve every candidate path and verify it stays
    # inside MMFP_ROOT. We resolve MMFP_ROOT once for the comparison.
    root = MMFP_ROOT.resolve(strict=False)
    for base in (REQUESTS, RESPONSES, CONSENSUS, ARCHIVE):
        for ext in (".yaml", ".json"):
            candidate = (base / f"{req_id}{ext}").resolve(strict=False)
            try:
                candidate.relative_to(root)
            except ValueError:
                raise InvalidRequestId(
                    f"request_id resolves outside MMFP root: {req_id!r}"
                )
    return req_id


# ---------------------------------------------------------------------------
# YAML loading (graceful fallback if PyYAML absent)
# ---------------------------------------------------------------------------

def _load_yaml(path: Path) -> dict:
    """Load a YAML file. Falls back to minimal line parser if PyYAML absent."""
    text = path.read_text(encoding="utf-8")
    if yaml is not None:
        return yaml.safe_load(text) or {}
    # Minimal fallback: parse simple key: value lines (no nested blocks)
    result: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            k, _, v = line.partition(":")
            result[k.strip()] = v.strip().strip('"')
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _list_requests(include_all: bool = False) -> list[Path]:
    """Return sorted list of request YAML files."""
    _ensure_dirs()
    files = sorted(REQUESTS.glob("req-*.yaml"))
    if include_all:
        files += sorted(ARCHIVE.glob("req-*.yaml"))
    return files


def _has_response(req_id: str) -> bool:
    return (RESPONSES / f"{req_id}.json").exists()


def _is_archived(req_id: str) -> bool:
    return (ARCHIVE / f"{req_id}.yaml").exists()


def _parse_duration(s: str) -> timedelta:
    """Parse duration strings like '7d', '30d', '2w', '1m'. Raises ValueError if invalid."""
    s = s.strip().lower()
    m = re.fullmatch(r"(\d+)([dwm])", s)
    if not m:
        raise ValueError(
            f"Invalid duration format: {s!r}. Use Nd (days), Nw (weeks), Nm (months)."
        )
    n, unit = int(m.group(1)), m.group(2)
    if unit == "d":
        return timedelta(days=n)
    if unit == "w":
        return timedelta(weeks=n)
    if unit == "m":
        return timedelta(days=n * 30)
    raise ValueError(f"Unknown unit: {unit}")


def _created_at(req: dict, path: Path) -> datetime:
    """Parse created_at from YAML dict, fallback to file mtime."""
    raw = req.get("created_at", "")
    if raw:
        try:
            # Handle both with and without trailing Z
            raw_clean = raw.replace("Z", "+00:00")
            return datetime.fromisoformat(raw_clean)
        except (ValueError, TypeError):
            pass
    # Fallback: use file modification time
    mtime = path.stat().st_mtime
    return datetime.fromtimestamp(mtime, tz=timezone.utc)


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> int:
    """List pending requests (and optionally all requests).

    Codex M2 fix: empty result yields empty stdout + exit 0 (script-friendly).
    Informational message goes to stderr so interactive users still get
    feedback but stdout stays clean for piping.
    """
    _ensure_dirs()
    files = _list_requests(include_all=args.all)

    if not files:
        label = "any" if args.all else "pending"
        print(f"[multimodel] No {label} requests found.", file=sys.stderr)
        return 0

    # Table header
    print(f"{'ID':<45} {'PEERS':<8} {'MODE':<8} {'RND':>3}  {'STATUS':<12} {'CREATED'}")
    print("-" * 100)

    for path in files:
        req_id = path.stem
        try:
            req = _load_yaml(path)
        except Exception:
            req = {}
        peers   = req.get("peers", "?")
        mode    = req.get("mode", "?")
        rounds  = req.get("rounds", "?")
        created = req.get("created_at", "?")[:19]  # truncate to seconds

        if _is_archived(req_id) or str(path).startswith(str(ARCHIVE)):
            status = "archived"
        elif _has_response(req_id):
            status = "processed"
        else:
            status = "PENDING"

        # Only show pending unless --all
        if not args.all and status != "PENDING":
            continue

        print(f"{req_id:<45} {peers:<8} {mode:<8} {str(rounds):>3}  {status:<12} {created}")

    return 0


def cmd_show(args: argparse.Namespace) -> int:
    """Show a request YAML and its response JSON if it exists."""
    _ensure_dirs()
    try:
        req_id = _validate_request_id(args.id)
    except InvalidRequestId as e:
        print(f"[multimodel] {e}", file=sys.stderr)
        return 2

    # Look in requests/ first, then archive/
    req_path = REQUESTS / f"{req_id}.yaml"
    if not req_path.exists():
        req_path = ARCHIVE / f"{req_id}.yaml"
    if not req_path.exists():
        print(f"[multimodel] Request not found: {req_id}", file=sys.stderr)
        return 1

    print(f"=== REQUEST: {req_id} ===")
    print(req_path.read_text(encoding="utf-8"))

    resp_path = RESPONSES / f"{req_id}.json"
    if not resp_path.exists():
        resp_path = ARCHIVE / f"{req_id}.json"

    if resp_path.exists():
        print(f"\n=== RESPONSE: {req_id} ===")
        raw = resp_path.read_text(encoding="utf-8")
        try:
            parsed = json.loads(raw)
            print(json.dumps(parsed, indent=2))
        except json.JSONDecodeError:
            print(raw)

        cons_path = CONSENSUS / f"{req_id}.json"
        if cons_path.exists():
            print(f"\n=== CONSENSUS: {req_id} ===")
            raw = cons_path.read_text(encoding="utf-8")
            try:
                parsed = json.loads(raw)
                print(json.dumps(parsed, indent=2))
            except json.JSONDecodeError:
                print(raw)
    else:
        print("\n[multimodel] No response yet (status: PENDING)")

    return 0


def cmd_process(args: argparse.Namespace) -> int:
    """Invoke shared-duet.ps1 for a pending request and save the response."""
    _ensure_dirs()
    try:
        req_id = _validate_request_id(args.id)
    except InvalidRequestId as e:
        print(f"[multimodel] {e}", file=sys.stderr)
        return 2

    req_path = REQUESTS / f"{req_id}.yaml"
    if not req_path.exists():
        print(f"[multimodel] Request not found in requests/: {req_id}", file=sys.stderr)
        return 1

    if _has_response(req_id):
        print(f"[multimodel] Already processed: {req_id} (response exists)")
        print(f"  Use: ultron multimodel show {req_id}")
        return 0

    try:
        req = _load_yaml(req_path)
    except Exception as e:
        print(f"[multimodel] Failed to parse YAML: {e}", file=sys.stderr)
        return 1

    # Map YAML fields back to shared-duet.ps1 params
    peers        = req.get("peers", "codex")
    mode         = req.get("mode", "Mini")
    rounds       = int(req.get("rounds", 1))
    prompt_text  = req.get("prompt", "")
    prompt_file  = req.get("prompt_file") or ""
    codex_model  = req.get("codex_model", "gpt-5.5")
    gemini_model = req.get("gemini_model", "pro")
    timeout_sec  = int(req.get("timeout_sec", 240))

    sids_raw = req.get("session_ids", {})
    if isinstance(sids_raw, dict):
        session_ids_json = json.dumps(sids_raw)
    else:
        session_ids_json = "{}"

    # Build powershell command
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", str(SHARED_DUET),
        "-Peers", peers,
        "-Mode", mode,
        "-Round", str(rounds),
        "-CodexModel", codex_model,
        "-GeminiModel", gemini_model,
        "-TimeoutSec", str(timeout_sec),
        "-SessionIds", session_ids_json,
    ]

    # Prompt source: prefer prompt_file if set and exists, else use inline prompt
    if prompt_file and Path(prompt_file).exists():
        cmd += ["-PromptFile", prompt_file]
    elif prompt_text:
        cmd += ["-Prompt", prompt_text]
    else:
        print("[multimodel] Request has no prompt or prompt_file", file=sys.stderr)
        return 1

    print(f"[multimodel] Invoking shared-duet.ps1 for {req_id}...")
    print(f"  peers={peers} mode={mode} round={rounds} model={codex_model}/{gemini_model}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
            timeout=timeout_sec + 30,  # extra buffer for startup
        )
    except subprocess.TimeoutExpired:
        print(f"[multimodel] Process timed out after {timeout_sec + 30}s", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[multimodel] Failed to invoke shared-duet.ps1: {e}", file=sys.stderr)
        return 1

    # Echo shared-duet output (minus the JSON sentinel lines — those are captured)
    stdout_lines = result.stdout.splitlines()
    json_output  = None
    in_json      = False
    json_buf     = []

    for line in stdout_lines:
        if line.strip() == "--- OUTPUT JSON ---":
            in_json = True
            continue
        if in_json:
            json_buf.append(line)
        else:
            print(line)

    if json_buf:
        raw_json = "\n".join(json_buf).strip()
        try:
            json_output = json.loads(raw_json)
        except json.JSONDecodeError:
            # Not valid JSON — store raw text under a wrapper field so
            # downstream consumers can still see it but it's clearly marked.
            json_output = {"raw_output": raw_json, "parse_error": True}

    if result.returncode != 0:
        print(f"[multimodel] shared-duet.ps1 exited {result.returncode}", file=sys.stderr)
        if result.stderr:
            print(result.stderr[:500], file=sys.stderr)
        if json_output is None:
            json_output = {
                "error": "non_zero_exit",
                "exit_code": result.returncode,
                "stderr_preview": result.stderr[:200] if result.stderr else "",
            }

    # Codex M1 fix: do NOT mark a request as processed when shared-duet exited
    # 0 but produced no parseable JSON (json_output is None means no JSON
    # sentinel was found OR no JSON content followed it). Writing null to
    # responses/<id>.json would silently mark this as processed. Better: error
    # explicitly so the user can re-process.
    if json_output is None:
        print(
            "[multimodel] shared-duet.ps1 exited 0 but produced no parseable JSON output. "
            "Refusing to write null response. Re-run with: ultron multimodel process "
            f"{req_id}",
            file=sys.stderr,
        )
        if result.stderr:
            print("--- stderr (first 500) ---", file=sys.stderr)
            print(result.stderr[:500], file=sys.stderr)
        return 3  # distinct exit code: parseable-output-missing

    # Write response
    resp_path = RESPONSES / f"{req_id}.json"
    resp_path.write_text(
        json.dumps(json_output, indent=2, default=str),
        encoding="utf-8",
    )
    print(f"\n[multimodel] Response saved: {resp_path}")

    # Update consensus if multi-round
    if mode.lower() in ("dual", "max", "triple") and isinstance(json_output, dict):
        _update_consensus(req_id, rounds, json_output, req)

    return result.returncode if result.returncode != 0 else 0


def _update_consensus(req_id: str, round_num: int, response: dict, req: dict) -> None:
    """Update or create consensus/<id>.json after a round completes."""
    cons_path = CONSENSUS / f"{req_id}.json"

    if cons_path.exists():
        try:
            consensus = json.loads(cons_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            consensus = {}
    else:
        consensus = {}

    # Build verdict entry for this round
    codex_r  = response.get("codex")
    gemini_r = response.get("gemini")
    verdict_entry = {
        "round":  round_num,
        "codex":  codex_r.get("verdict") if isinstance(codex_r, dict) else None,
        "gemini": gemini_r.get("verdict") if isinstance(gemini_r, dict) else None,
    }

    verdicts = consensus.get("verdicts", [])
    # Replace existing entry for same round, or append
    replaced = False
    for i, v in enumerate(verdicts):
        if v.get("round") == round_num:
            verdicts[i] = verdict_entry
            replaced = True
            break
    if not replaced:
        verdicts.append(verdict_entry)

    rounds_total = int(req.get("rounds", 1))
    rounds_done  = len(verdicts)
    session_ids  = response.get("session_ids", {})
    if not isinstance(session_ids, dict):
        session_ids = {}

    final_verdict = None
    if rounds_done >= rounds_total:
        # Simple consensus: all GREEN -> GREEN, any RED -> RED, else YELLOW
        all_v = [v for entry in verdicts for v in (entry.get("codex"), entry.get("gemini")) if v]
        if all(v == "GREEN" for v in all_v):
            final_verdict = "GREEN"
        elif any(v == "RED" for v in all_v):
            final_verdict = "RED"
        elif all_v:
            final_verdict = "YELLOW"

    consensus = {
        "request_id":    req_id,
        "peers":         req.get("peers", "?"),
        "mode":          req.get("mode", "?"),
        "rounds_done":   rounds_done,
        "rounds_total":  rounds_total,
        "verdicts":      verdicts,
        "final_verdict": final_verdict,
        "session_ids":   session_ids,
        "updated_at":    datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    cons_path.write_text(
        json.dumps(consensus, indent=2, default=str),
        encoding="utf-8",
    )
    print(f"[multimodel] Consensus updated: {cons_path}")


def cmd_archive(args: argparse.Namespace) -> int:
    """Move processed requests older than --older-than to archive/."""
    _ensure_dirs()
    dry_run = getattr(args, "dry_run", False)

    older_than_str = getattr(args, "older_than", "7d") or "7d"
    try:
        delta = _parse_duration(older_than_str)
    except ValueError as e:
        print(f"[multimodel] {e}", file=sys.stderr)
        return 1

    cutoff = datetime.now(tz=timezone.utc) - delta
    moved  = 0
    skipped = 0

    for req_path in sorted(REQUESTS.glob("req-*.yaml")):
        req_id = req_path.stem

        # Only archive if there's a response
        if not _has_response(req_id):
            skipped += 1
            continue

        try:
            req = _load_yaml(req_path)
        except Exception:
            req = {}

        created = _created_at(req, req_path)
        # Ensure timezone-aware for comparison
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)

        if created > cutoff:
            skipped += 1
            continue

        # Move request YAML
        dest_req  = ARCHIVE / req_path.name
        # Move response JSON
        resp_path = RESPONSES / f"{req_id}.json"
        dest_resp = ARCHIVE / f"{req_id}.json"
        # Move consensus JSON if exists
        cons_path = CONSENSUS / f"{req_id}.json"
        dest_cons = ARCHIVE / f"consensus-{req_id}.json"

        if dry_run:
            print(f"[DRY-RUN] Would archive: {req_id}")
            print(f"  {req_path} -> {dest_req}")
            if resp_path.exists():
                print(f"  {resp_path} -> {dest_resp}")
            if cons_path.exists():
                print(f"  {cons_path} -> {dest_cons}")
        else:
            # Copy then verify before removing original
            shutil.copy2(req_path, dest_req)
            if dest_req.exists() and dest_req.stat().st_size > 0:
                req_path.unlink()
            if resp_path.exists():
                shutil.copy2(resp_path, dest_resp)
                if dest_resp.exists() and dest_resp.stat().st_size > 0:
                    resp_path.unlink()
            if cons_path.exists():
                shutil.copy2(cons_path, dest_cons)
                if dest_cons.exists() and dest_cons.stat().st_size > 0:
                    cons_path.unlink()
            print(f"[multimodel] Archived: {req_id}")

        moved += 1

    label = "Would archive" if dry_run else "Archived"
    print(f"\n[multimodel] {label} {moved} request(s). Skipped {skipped} (pending or too recent).")
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    """Alias for archive --dry-run when called with --dry-run, else run archive."""
    return cmd_archive(args)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        prog="multimodel",
        description="ULTRON MMFP — multi-model file-persistent peer review",
    )
    sub = parser.add_subparsers(dest="action", metavar="ACTION")

    # list
    p_list = sub.add_parser("list", help="List requests")
    p_list.add_argument("--all", action="store_true",
                        help="Include processed and archived requests")

    # show
    p_show = sub.add_parser("show", help="Show a request + its response")
    p_show.add_argument("id", help="Request ID (req-...)")

    # process
    p_proc = sub.add_parser("process", help="Process a pending request via shared-duet.ps1")
    p_proc.add_argument("id", help="Request ID (req-...)")

    # archive
    p_arch = sub.add_parser("archive", help="Move old processed requests to archive/")
    p_arch.add_argument("--older-than", default="7d", metavar="DURATION",
                        help="Archive requests older than this (e.g. 7d, 2w, 1m). Default: 7d")
    p_arch.add_argument("--dry-run", action="store_true",
                        help="Preview without moving files")

    # clean (alias for archive with --dry-run semantics)
    p_clean = sub.add_parser("clean", help="Preview what archive would do (dry-run)")
    p_clean.add_argument("--older-than", default="7d", metavar="DURATION",
                         help="Same as archive --older-than")
    p_clean.add_argument("--dry-run", action="store_true", default=True,
                         help="Always dry-run for 'clean' (use 'archive' to actually move)")

    args = parser.parse_args()

    if args.action is None:
        parser.print_help()
        return 0

    dispatch = {
        "list":    cmd_list,
        "show":    cmd_show,
        "process": cmd_process,
        "archive": cmd_archive,
        "clean":   cmd_clean,
    }

    fn = dispatch.get(args.action)
    if fn is None:
        print(f"Unknown action: {args.action}", file=sys.stderr)
        parser.print_help()
        return 1

    return fn(args)


if __name__ == "__main__":
    sys.exit(main())
