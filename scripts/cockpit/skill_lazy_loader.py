"""ULTRON v14.4 TOKEN HUNTER — Phase 1 lazy skill loader.

Computes per-skill `skillOverrides` for ~/.claude/settings.local.json based on
routing.jsonl telemetry × 14-day exponential decay × ULTRON-persona pin. Top-N
skills stay "on" (full description); the rest go "name-only" — the model still
sees the skill name and can be told to invoke it, but its description tokens
disappear from the system-prompt skill listing block.

Native CC mechanism: `skillOverrides` setting introduced in Claude Code v2.1.129.
Plugin-namespaced skills are immune (Anthropic-side limitation); the lazy loader
operates only on local `~/.claude/skills/<name>/` entries.

CLI:
  skill_lazy_loader.py score [--top N]      # preview ranking, no writes
  skill_lazy_loader.py apply [--dry-run]    # write overrides
  skill_lazy_loader.py restore              # remove overrides (back to full)
  skill_lazy_loader.py status               # current mode + diff vs target

Safety contract:
  * Atomic write (tempfile + os.replace) to ~/.claude/settings.local.json
  * Backup to settings.local.json.bak before any write
  * Refuse if CC version < 2.1.129
  * Refuse if telemetry < ROUTING_MIN_EVENTS (insufficient signal)
  * Pin ULTRON personas always "on" regardless of usage
  * Never use "off" (issue anthropics/claude-agent-sdk-typescript#291)
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    """Resolve user home, recomputed each call so tests can monkeypatch."""
    return Path.home()


def _settings_local() -> Path:
    return _user_home() / ".claude" / "settings.local.json"


def _local_skills_dir() -> Path:
    return _user_home() / ".claude" / "skills"


def _sessions_dir() -> Path:
    return _user_home() / ".ultron" / "sessions"


def _state_file() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "skill-listing-mode.json"


def _config_file() -> Path:
    return _user_home() / ".ultron" / "config" / "lazy-loader.yaml"


# ── Constants ──────────────────────────────────────────────────────────────────

MIN_CC_VERSION = (2, 1, 129)
DEFAULT_TOP_N = 25
DECAY_HALF_LIFE_DAYS = 14
ROUTING_MIN_EVENTS = 50
NAME_ONLY = "name-only"
ON = "on"

# Built-in agents that share the routing.jsonl tool=Agent stream but should
# never count as skill activations.
BUILTIN_AGENTS = frozenset({"general-purpose", "Explore", "Plan", "Output"})

# Backwards-compat alias map: old skill name → new canonical name. Resolved at
# routing/normalization boundaries so legacy telemetry, configs and tests still
# work without breaking the deprecated stubs in ~/.claude/skills/<old>/.
SKILL_ALIASES = {
    "pana": "personal-assistant",
    "alfred": "windows-admin",
    "don-claudio": "gamedev-engineer",
}


def resolve_skill_alias(name: str) -> str:
    """Return canonical skill name, mapping deprecated aliases to their replacement."""
    return SKILL_ALIASES.get(name, name)


# ULTRON personas pinned "on" regardless of usage. Source: ~/.ultron/MEMORY.md
# skill-memory map + L0 context primer. Edit ~/.ultron/config/lazy-loader.yaml
# `persona_pin` to override.
# Includes both canonical names AND deprecated aliases so legacy lookups
# (e.g., older settings.local.json with "alfred") still get pinned.
ULTRON_PERSONAS = frozenset({
    "ultron",
    "windows-admin",
    "novalbos",
    "gamedev-engineer",
    "terry-davis",
    "tio-gilito",
    "mike-tyson",
    "warren",
    "einstein",
    "manolo-lama",
    "jordan-belfort",
    "personal-assistant",
    "tolkien",
    "repo-evaluator",
    "profesor-fisica",
    # Deprecated aliases (kept for backwards-compat with stub skills)
    "alfred",
    "don-claudio",
    "pana",
})


# ── Version guard ──────────────────────────────────────────────────────────────


_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def parse_cc_version(text: str) -> tuple[int, int, int] | None:
    """Extract (major, minor, patch) from `claude --version` output."""
    match = _VERSION_RE.search(text)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _detect_cc_version() -> tuple[int, int, int] | None:
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=creationflags,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    return parse_cc_version(result.stdout or "")


def check_version_floor(detected: tuple[int, int, int] | None) -> tuple[bool, str]:
    """Return (ok, message). ok=False means caller must abort apply()."""
    if detected is None:
        return False, "claude --version not parseable; skipping apply"
    if detected < MIN_CC_VERSION:
        formatted = ".".join(str(x) for x in detected)
        floor = ".".join(str(x) for x in MIN_CC_VERSION)
        return False, f"requires CC >= {floor}, current {formatted}"
    return True, "ok"


# ── Skill enumeration ──────────────────────────────────────────────────────────


def list_local_skills() -> list[str]:
    """Return sorted names of skills under ~/.claude/skills/.

    Plugin skills (under ~/.claude/plugins/cache/...) are intentionally excluded
    because skillOverrides does not apply to them.
    """
    skills_dir = _local_skills_dir()
    if not skills_dir.exists():
        return []
    out = []
    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir():
            continue
        if (entry / "SKILL.md").exists():
            out.append(entry.name)
    return out


# ── Routing telemetry ──────────────────────────────────────────────────────────


def load_routing_events(window_days: int = 14) -> list[dict[str, Any]]:
    """Yield Skill+Agent invocations from routing.jsonl files within window.

    Built-in agents (general-purpose, Explore, Plan) are filtered out — they
    represent harness-level dispatches, not skill listing usage.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    out: list[dict[str, Any]] = []
    sessions = _sessions_dir()
    if not sessions.exists():
        return out
    for jsonl in sessions.rglob("routing.jsonl"):
        try:
            text = jsonl.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            target = ev.get("target")
            if not target or target in BUILTIN_AGENTS:
                continue
            ts_raw = ev.get("ts") or ev.get("timestamp")
            if not ts_raw:
                continue
            try:
                ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
            except ValueError:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                continue
            ev["_ts_parsed"] = ts
            out.append(ev)
    return out


def _canonical_skill_name(target: str) -> str:
    """Strip plugin prefix `<plugin>:<skill>` → `<skill>`. Idempotent."""
    if ":" in target:
        return target.split(":", 1)[1]
    return target


# ── Scoring ────────────────────────────────────────────────────────────────────


def score_skills(
    events: Iterable[dict[str, Any]],
    half_life_days: float = DECAY_HALF_LIFE_DAYS,
    now: datetime | None = None,
) -> dict[str, float]:
    """Aggregate score per canonical skill name with exponential decay.

    score = sum_i exp(-Δdays_i / half_life_days)
    """
    if now is None:
        now = datetime.now(timezone.utc)
    scores: dict[str, float] = collections.defaultdict(float)
    for ev in events:
        target = ev.get("target")
        if not target:
            continue
        skill = _canonical_skill_name(target)
        ts = ev.get("_ts_parsed")
        if ts is None:
            ts_raw = ev.get("ts") or ev.get("timestamp")
            try:
                ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        delta_days = max(0.0, (now - ts).total_seconds() / 86400.0)
        scores[skill] += math.exp(-delta_days / half_life_days)
    return dict(scores)


def select_keep_full(
    scores: dict[str, float],
    candidate_skills: Iterable[str],
    top_n: int = DEFAULT_TOP_N,
    pin_personas: bool = True,
) -> set[str]:
    """Pick the set of skill names that should remain "on" (full description).

    Personas are pinned first (if pin_personas), filling slots from top_n. The
    remaining slots are filled by the highest-scoring non-persona skills that
    actually exist on disk.
    """
    candidates = set(candidate_skills)
    keep: set[str] = set()
    if pin_personas:
        keep |= ULTRON_PERSONAS & candidates
    remaining = max(0, top_n - len(keep))
    sorted_others = sorted(
        ((name, sc) for name, sc in scores.items()
         if name in candidates and name not in keep),
        key=lambda kv: -kv[1],
    )
    for name, _ in sorted_others[:remaining]:
        keep.add(name)
    return keep


# ── Override computation ───────────────────────────────────────────────────────


ListingMode = Literal["lazy", "full"]


def compute_overrides(
    mode: ListingMode = "lazy",
    top_n: int = DEFAULT_TOP_N,
    pin_personas: bool = True,
    window_days: int = 14,
) -> dict[str, str]:
    """Build the skillOverrides map for ~/.claude/settings.local.json.

    mode='full': return {} (clear all overrides).
    mode='lazy': bottom skills get NAME_ONLY, top stay ON (or are absent which
                 is equivalent to ON — we emit them explicitly for transparency).
    """
    if mode == "full":
        return {}
    skills = list_local_skills()
    events = load_routing_events(window_days=window_days)
    scores = score_skills(events)
    keep = select_keep_full(
        scores, candidate_skills=skills, top_n=top_n, pin_personas=pin_personas
    )
    overrides: dict[str, str] = {}
    for skill in skills:
        if skill in keep:
            overrides[skill] = ON
        else:
            overrides[skill] = NAME_ONLY
    return overrides


# ── Settings I/O ───────────────────────────────────────────────────────────────


def _read_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def read_overrides() -> dict[str, str]:
    settings = _read_settings(_settings_local())
    raw = settings.get("skillOverrides", {})
    if not isinstance(raw, dict):
        return {}
    return {k: str(v) for k, v in raw.items()}


def apply_overrides(
    overrides: dict[str, str],
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Atomically merge `overrides` into ~/.claude/settings.local.json.

    Returns a diff summary. Backs up the previous file as
    `settings.local.json.bak` before writing.
    """
    target = _settings_local()
    settings = _read_settings(target)
    previous = settings.get("skillOverrides", {}) if isinstance(settings.get("skillOverrides"), dict) else {}

    added = {k: v for k, v in overrides.items() if previous.get(k) != v}
    removed = [k for k in previous if k not in overrides]
    diff = {
        "target": str(target),
        "added_or_changed": added,
        "removed": removed,
        "total_after": len(overrides),
        "name_only": sum(1 for v in overrides.values() if v == NAME_ONLY),
        "on": sum(1 for v in overrides.values() if v == ON),
    }
    if dry_run:
        diff["dry_run"] = True
        return diff

    if target.exists():
        backup = target.with_suffix(target.suffix + ".bak")
        backup.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
        diff["backup"] = str(backup)

    settings["skillOverrides"] = overrides
    _atomic_write_json(target, settings)

    state = {
        "mode": "lazy" if any(v == NAME_ONLY for v in overrides.values()) else "full",
        "applied_at": datetime.now(timezone.utc).isoformat(),
        "skills_total": len(overrides),
        "skills_name_only": diff["name_only"],
        "skills_on": diff["on"],
    }
    _atomic_write_json(_state_file(), state)
    diff["state"] = state
    return diff


def restore_full_listing(*, dry_run: bool = False) -> dict[str, Any]:
    target = _settings_local()
    settings = _read_settings(target)
    if "skillOverrides" not in settings:
        return {"noop": True, "reason": "no skillOverrides present"}
    removed = list(settings["skillOverrides"].keys())
    if dry_run:
        return {"dry_run": True, "would_remove": removed}

    backup = target.with_suffix(target.suffix + ".bak")
    backup.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
    del settings["skillOverrides"]
    _atomic_write_json(target, settings)
    state = {
        "mode": "full",
        "applied_at": datetime.now(timezone.utc).isoformat(),
        "skills_total": 0,
    }
    _atomic_write_json(_state_file(), state)
    return {"restored": removed, "backup": str(backup), "state": state}


# ── State / preview ────────────────────────────────────────────────────────────


def is_lazy_mode() -> bool:
    state_path = _state_file()
    if not state_path.exists():
        return False
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return state.get("mode") == "lazy"


def get_state() -> dict[str, Any]:
    state_path = _state_file()
    if not state_path.exists():
        return {"mode": "full", "applied_at": None}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"mode": "full", "applied_at": None, "error": "state file unreadable"}


def build_skill_listing(mode: ListingMode = "lazy", top_n: int = DEFAULT_TOP_N) -> str:
    """Human-readable preview of the listing CC will render post-override.

    Useful for QA and the planned doctor detector D23_LAZY_LISTING_HEALTH.
    """
    skills = list_local_skills()
    if mode == "full":
        return "\n".join(f"- {s}: <full description>" for s in skills)
    overrides = compute_overrides(mode="lazy", top_n=top_n)
    lines = []
    for skill in skills:
        verdict = overrides.get(skill, ON)
        if verdict == ON:
            lines.append(f"- {skill}: <full description>")
        else:
            lines.append(f"- {skill} [{verdict}]")
    return "\n".join(lines)


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_score(args: argparse.Namespace) -> int:
    events = load_routing_events(window_days=args.window)
    if len(events) < ROUTING_MIN_EVENTS:
        print(
            f"WARN: only {len(events)} routing events in last {args.window}d "
            f"(< {ROUTING_MIN_EVENTS}); ranking may be noisy.",
            file=sys.stderr,
        )
    scores = score_skills(events)
    skills = list_local_skills()
    keep = select_keep_full(scores, skills, top_n=args.top)

    rows = []
    for skill in skills:
        verdict = ON if skill in keep else NAME_ONLY
        rows.append((scores.get(skill, 0.0), skill, verdict))
    rows.sort(key=lambda r: (-r[0], r[1]))

    print(f"score  skill                                          verdict")
    print("-" * 70)
    for score, skill, verdict in rows[: args.limit]:
        print(f"{score:>5.2f}  {skill:<46} {verdict}")
    print(
        f"\nSummary: {sum(1 for _,_,v in rows if v == ON)} on / "
        f"{sum(1 for _,_,v in rows if v == NAME_ONLY)} name-only "
        f"(top_n={args.top}, events={len(events)})"
    )
    return 0


def _cmd_apply(args: argparse.Namespace) -> int:
    if not args.skip_version_check:
        version = _detect_cc_version()
        ok, msg = check_version_floor(version)
        if not ok:
            print(f"ERROR: {msg}", file=sys.stderr)
            return 2

    events = load_routing_events(window_days=args.window)
    if len(events) < ROUTING_MIN_EVENTS and not args.force:
        print(
            f"ERROR: only {len(events)} routing events (< {ROUTING_MIN_EVENTS}); "
            f"refusing to apply. Use --force to override.",
            file=sys.stderr,
        )
        return 2

    overrides = compute_overrides(mode="lazy", top_n=args.top)
    diff = apply_overrides(overrides, dry_run=args.dry_run)
    print(json.dumps(diff, indent=2, ensure_ascii=False))
    return 0


def _cmd_restore(args: argparse.Namespace) -> int:
    diff = restore_full_listing(dry_run=args.dry_run)
    print(json.dumps(diff, indent=2, ensure_ascii=False))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    state = get_state()
    overrides = read_overrides()
    payload = {
        "state": state,
        "overrides_count": len(overrides),
        "name_only": sum(1 for v in overrides.values() if v == NAME_ONLY),
        "on": sum(1 for v in overrides.values() if v == ON),
        "settings_local_path": str(_settings_local()),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="skill_lazy_loader.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_score = sub.add_parser("score", help="preview ranking without writes")
    p_score.add_argument("--top", type=int, default=DEFAULT_TOP_N)
    p_score.add_argument("--window", type=int, default=14)
    p_score.add_argument("--limit", type=int, default=60)
    p_score.set_defaults(func=_cmd_score)

    p_apply = sub.add_parser("apply", help="write skillOverrides")
    p_apply.add_argument("--top", type=int, default=DEFAULT_TOP_N)
    p_apply.add_argument("--window", type=int, default=14)
    p_apply.add_argument("--dry-run", action="store_true")
    p_apply.add_argument("--force", action="store_true",
                         help="apply even if telemetry below ROUTING_MIN_EVENTS")
    p_apply.add_argument("--skip-version-check", action="store_true")
    p_apply.set_defaults(func=_cmd_apply)

    p_restore = sub.add_parser("restore", help="remove skillOverrides")
    p_restore.add_argument("--dry-run", action="store_true")
    p_restore.set_defaults(func=_cmd_restore)

    p_status = sub.add_parser("status", help="current mode + counts")
    p_status.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
