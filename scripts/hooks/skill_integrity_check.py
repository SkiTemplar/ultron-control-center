#!/usr/bin/env python3
"""
ULTRON HOOK · skill_integrity_check · v1.0 (Sprint 6 S5-C)

PreToolUse hook on Skill invocations. Computes SHA1 of the target SKILL.md
and compares it against the baseline recorded in skill-provenance.json at
install/scan time. Mismatches indicate the file was modified after the last
security scan — could be legitimate (user edited) or injection (tampered).

Decision logic:
  - Skill not in provenance baseline → allow silently (no baseline to check)
  - SHA1 matches → allow silently
  - SHA1 differs → warn user + allow (soft-block: surfaces the issue without
    breaking workflow; hard-block can be enabled via ULTRON_INTEGRITY=strict)

Re-establish baseline after legitimate edits:
  uv run python ~/.ultron/scripts/cockpit/registry_sync.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


_SKILLS_DIR = Path.home() / ".claude" / "skills"
_PROVENANCE = Path.home() / ".ultron" / "skill-provenance.json"
_STRICT = os.environ.get("ULTRON_INTEGRITY", "").lower() == "strict"


def _sha1_file(path: Path) -> str:
    h = hashlib.sha1(usedforsecurity=False)
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_provenance() -> dict:
    if not _PROVENANCE.exists():
        return {}
    try:
        return json.loads(_PROVENANCE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main() -> None:
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    if data.get("hook_event_name") != "PreToolUse":
        sys.exit(0)
    if data.get("tool_name") != "Skill":
        sys.exit(0)

    skill_name: str = (data.get("tool_input") or {}).get("skill", "")
    if not skill_name:
        sys.exit(0)

    # Resolve SKILL.md path (handles plugin:skill form)
    base_name = skill_name.split(":")[0] if ":" in skill_name else skill_name
    skill_md = _SKILLS_DIR / base_name / "SKILL.md"
    if not skill_md.exists():
        sys.exit(0)

    provenance = _load_provenance()
    baseline = (provenance.get("skills") or {}).get(base_name, {})
    stored_sha1: str | None = baseline.get("skill_md_sha1")

    if not stored_sha1:
        sys.exit(0)

    try:
        current_sha1 = _sha1_file(skill_md)
    except OSError:
        sys.exit(0)

    if current_sha1 == stored_sha1:
        sys.exit(0)

    # Hash mismatch — SKILL.md was modified since last security scan
    msg = (
        f"[ULTRON-INTEGRITY] SKILL.md hash mismatch for '{base_name}'. "
        f"Stored: {stored_sha1[:12]}… | Current: {current_sha1[:12]}… — "
        f"The file changed since the last security scan. "
        f"Run `registry_sync.py` after verifying the change is intentional."
    )

    if _STRICT:
        print(json.dumps({
            "systemMessage": msg,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"BLOCKED integrity: {base_name}",
            },
        }))
    else:
        print(json.dumps({"systemMessage": msg}))

    sys.exit(0)


if __name__ == "__main__":
    main()
