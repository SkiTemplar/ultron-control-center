#!/usr/bin/env python3
"""auto-changelog.py — Stop hook that auto-appends release notes to CHANGELOG.md
when a recent commit contains a version bump (e.g. "feat(v15.2.0): ...").

Why a hook (not a Git hook)? Because the user wants the auto-changelog to fire
from inside Claude Code sessions — we already commit from there, and we want
the CHANGELOG bump to happen WITHOUT needing to remember a follow-up command.

Idempotent: each version gets its own anchor (`<!-- vX.Y.Z -->`) and we never
write the same section twice. If CHANGELOG.md already contains the anchor we
exit 0 silently.

Stop-hook contract (Claude Code):
  - Reads JSON from stdin (we don't need it, we just don't error on it).
  - Exits 0 to let the session terminate normally. Even on internal errors
    we exit 0 — a failing changelog must never block a session stop.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# How many commits to scan for a version bump. We only look at the last
# few — running this on every Stop event means it's enough to cover the
# fresh commits the user just authored.
COMMIT_LOOKBACK = 10

VERSION_RE = re.compile(r"\bv(\d+\.\d+\.\d+(?:[\.-][A-Za-z0-9.-]+)?)\b")


def repo_root() -> Path | None:
    """Return the ULTRON repo root (~/.ultron) if it's a git repo, else None.

    The hook fires from arbitrary cwd, so we anchor on the well-known repo.
    """
    home = Path.home()
    candidate = home / ".ultron"
    if (candidate / ".git").exists():
        return candidate
    return None


def recent_commits(root: Path) -> list[tuple[str, str]]:
    """Return [(sha, subject), ...] for the last COMMIT_LOOKBACK commits."""
    try:
        out = subprocess.check_output(
            [
                "git",
                "-C",
                str(root),
                "log",
                f"-{COMMIT_LOOKBACK}",
                "--pretty=format:%H%x09%s",
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return []
    rows: list[tuple[str, str]] = []
    for line in out.splitlines():
        if "\t" in line:
            sha, subject = line.split("\t", 1)
            rows.append((sha.strip(), subject.strip()))
    return rows


def find_version_bump(commits: list[tuple[str, str]]) -> tuple[str, str, str] | None:
    """Return (version, sha, subject) of the newest bump commit, or None."""
    for sha, subject in commits:
        m = VERSION_RE.search(subject)
        if m:
            return (m.group(1), sha, subject)
    return None


def already_recorded(changelog: Path, version: str) -> bool:
    if not changelog.exists():
        return False
    try:
        text = changelog.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return f"<!-- v{version} -->" in text


def collect_section_commits(root: Path, version: str, anchor_sha: str) -> list[str]:
    """Collect commit subjects from the anchor commit back to the previous
    version tag (or COMMIT_LOOKBACK commits, whichever is shorter)."""
    # Take everything from the anchor backwards within our lookback window.
    # We intentionally don't walk all of git history — the user can edit
    # CHANGELOG.md by hand for deeper releases.
    try:
        # Explicit utf-8: on Windows, text=True defaults to cp1252 which
        # mangles em-dashes / unicode in commit subjects (mojibake `â€"`
        # in the rendered CHANGELOG).
        out = subprocess.check_output(
            [
                "git",
                "-C",
                str(root),
                "log",
                f"-{COMMIT_LOOKBACK}",
                "--pretty=format:%s",
                anchor_sha,
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return []
    subjects: list[str] = []
    for line in out.splitlines():
        s = line.strip()
        if not s:
            continue
        # Stop at the previous version bump so we don't duplicate older
        # entries on every release.
        if s != f"v{version}" and VERSION_RE.search(s) and not s.startswith(f"feat(v{version}") and version not in s:
            other = VERSION_RE.search(s)
            if other and other.group(1) != version:
                break
        subjects.append(s)
    return subjects


def render_section(version: str, sha: str, subjects: list[str]) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    lines = [
        f"<!-- v{version} -->",
        f"## v{version} — {today}",
        "",
    ]
    if subjects:
        for s in subjects:
            lines.append(f"- {s}")
    else:
        lines.append("- (no commit subjects captured)")
    lines.append("")
    lines.append(f"_Auto-generated from {sha[:8]} by scripts/hooks/auto-changelog.py_")
    lines.append("")
    return "\n".join(lines) + "\n"


def append_to_ndjson(root: Path, version: str, sha: str, subject: str, subjects: list[str]) -> None:
    """Mirror the changelog entry into ~/.ultron/cockpit/changelog.ndjson —
    that's what the Control Center reads. Idempotent: skip if the version
    is already represented in the ndjson.
    """
    ndjson = root / "cockpit" / "changelog.ndjson"
    if not ndjson.parent.exists():
        try:
            ndjson.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return
    # Skip if already recorded.
    if ndjson.exists():
        try:
            for line in ndjson.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if version in (rec.get("related_ids") or []):
                    return
                if rec.get("id") == f"v{version.replace('.', '-')}":
                    return
        except OSError:
            pass

    # Best-effort type / scope extraction from the bump subject:
    #   feat(v15.2.x): blah        -> type=feat, scope=v15.2.x
    #   fix(v15.2.x-thing): blah  -> type=fix,  scope=v15.2.x-thing
    m = re.match(r"^(\w+)\(([^)]+)\):\s*(.*)$", subject)
    if m:
        kind = m.group(1)
        scope = m.group(2)
        title = m.group(3).strip()
    else:
        kind = "feat"
        scope = f"v{version}"
        title = subject.strip()

    body_lines = [s for s in subjects[:8] if s.strip() and s != subject]
    body = "\n".join(f"- {s}" for s in body_lines) if body_lines else f"Release v{version}"

    entry = {
        "id": f"v{version.replace('.', '-')}",
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        "type": kind,
        "scope": scope,
        "title": title[:200] if title else f"ULTRON Control Center v{version}",
        "body": body,
        "related_ids": [f"v{version}"],
        "applied_by": "auto-changelog",
    }
    try:
        with ndjson.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        return


def prepend_section(changelog: Path, section: str) -> None:
    existing = ""
    if changelog.exists():
        try:
            existing = changelog.read_text(encoding="utf-8", errors="replace")
        except OSError:
            existing = ""
    # Keep the very first line if it's a top-level title so we don't break
    # markdown structure. Otherwise just prepend.
    if existing.lstrip().startswith("# "):
        first_nl = existing.find("\n")
        header = existing[: first_nl + 1] if first_nl != -1 else existing
        rest = existing[first_nl + 1 :] if first_nl != -1 else ""
        merged = header + "\n" + section + rest
    else:
        merged = section + ("\n" + existing if existing else "")
    changelog.write_text(merged, encoding="utf-8")


def _session_mode() -> str:
    """Return the current session mode (LOW/MEDIUM/HIGH/ULTRA) or empty string.

    Reads ``~/.ultron/.tmp/current-session-mode.json`` (written by the
    ``mode-trigger`` UserPromptSubmit hook). Best-effort — any read/parse
    failure is treated as "unknown" so the caller can fall back safely.
    """
    try:
        path = Path.home() / ".ultron" / ".tmp" / "current-session-mode.json"
        if not path.exists():
            return ""
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        mode = data.get("mode")
        if isinstance(mode, str):
            return mode.upper()
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return ""


def main() -> int:
    # Be tolerant of stdin shape — Stop hooks pass JSON but we don't use it.
    try:
        _ = sys.stdin.read()
    except Exception:
        pass

    # v15.5.14 Task 4b: gate the (expensive) git-log scan + CHANGELOG rewrite
    # behind HIGH/ULTRA modes. Every Stop on MEDIUM/LOW would otherwise fork a
    # git process for the same lookback window. When mode is unknown (file
    # missing on first run) we err on the side of running — it's idempotent.
    mode = _session_mode()
    if mode and mode not in ("HIGH", "ULTRA"):
        return 0

    root = repo_root()
    if root is None:
        return 0  # silent no-op when not in the ULTRON repo

    commits = recent_commits(root)
    if not commits:
        return 0

    bump = find_version_bump(commits)
    if not bump:
        return 0
    version, sha, _subject = bump

    changelog = root / "CHANGELOG.md"
    if already_recorded(changelog, version):
        return 0

    section_subjects = collect_section_commits(root, version, sha)
    section = render_section(version, sha, section_subjects)
    try:
        prepend_section(changelog, section)
        # Mirror into the ndjson the Control Center reads.
        append_to_ndjson(root, version, sha, _subject, section_subjects)
    except OSError as e:
        # Best-effort: write a one-line debug trace next to ~/.ultron/logs
        # so the user can investigate but we still exit 0.
        try:
            log_dir = root / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            (log_dir / "auto-changelog.err").write_text(
                f"{datetime.now(timezone.utc).isoformat()} {type(e).__name__}: {e}\n",
                encoding="utf-8",
            )
        except OSError:
            pass

    # Stop hooks may also receive {"hookEventName": "..."} — we don't react.
    # Exit 0 unconditionally so we never block session shutdown.
    return 0


if __name__ == "__main__":
    sys.exit(main())
