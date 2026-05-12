"""ULTRON v14.4 TOKEN HUNTER — Phase 0 baseline measurement.

Measures token cost of every block the harness injects at SessionStart so
we can quantify -50% target (v14.4 acceptance criterion). Reproducible,
offline, no API calls.

Tokens are estimated via tiktoken cl100k_base — best local approximation
of Claude's tokenizer. See ~/.ultron/audits/research-token-measurement-*
for divergence analysis when the matching research lands.

Blocks measured:
  - context.md       (~/.ultron/.tmp/context.md)
  - MEMORY.md        (~/.ultron/MEMORY.md)
  - CLAUDE.md global (~/.claude/CLAUDE.md)
  - skill_listing    (best-effort estimate from ~/.ultron/manifest.cache.json)
  - tool_descriptions (best-effort from ~/.claude/CLAUDE.md tool refs)

CLI:
  python token_baseline.py snapshot              # write TSV + JSON
  python token_baseline.py diff <baseline.json>  # compare current vs baseline
  python token_baseline.py budget                # per-block budget vs actual
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import tiktoken
except ImportError:
    tiktoken = None  # tests can mock; CLI errors out

USER_HOME = Path.home()
ULTRON_DIR = USER_HOME / ".ultron"
AUDITS_DIR = ULTRON_DIR / "audits"
TMP_DIR = ULTRON_DIR / ".tmp"

CONTEXT_MD = TMP_DIR / "context.md"
MEMORY_MD = ULTRON_DIR / "MEMORY.md"
GLOBAL_CLAUDE_MD = USER_HOME / ".claude" / "CLAUDE.md"
MANIFEST_CACHE = ULTRON_DIR / "manifest.cache.json"
SKILLS_REGISTRY_V2 = ULTRON_DIR / "skills" / "registry.json"  # v15.0b WS6 SSOT

JSON_OUT = TMP_DIR / "token-baseline.json"

# Per-block soft budgets (tokens). Surfaces in `budget` command.
# Calibrated against pickup.md observation "context.md should ≤ 400 tok".
DEFAULT_BUDGETS = {
    "context_md": 400,
    "MEMORY_md": 1000,
    "claude_md_global": 800,
    "skill_listing": 35000,    # 1% of 200K window
    "tool_descriptions": 4000,
}


def _get_encoder():
    """Return tiktoken cl100k_base encoder. Cached at import scope."""
    if tiktoken is None:
        raise RuntimeError(
            "tiktoken not installed. Run `uv pip install tiktoken`."
        )
    return tiktoken.get_encoding("cl100k_base")


def measure_block(name: str, content: str) -> dict[str, Any]:
    """Measure one block. Pure function — no IO.

    Returns:
        dict with keys: name, bytes, chars, tokens, method.
    """
    if not isinstance(content, str):
        content = "" if content is None else str(content)
    encoder = _get_encoder()
    return {
        "name": name,
        "bytes": len(content.encode("utf-8")),
        "chars": len(content),
        "tokens": len(encoder.encode(content)),
        "method": "tiktoken-cl100k",
    }


def _read_safe(path: Path) -> str:
    """Read file content, return empty string if missing or unreadable."""
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _estimate_skill_listing() -> str:
    """Approximate the harness "Skills" context block.

    The harness loads `name + description` of every skill it can SEE — i.e. the
    active skills in ~/.claude/skills/ plus plugin skills. NOT the vaulted ones
    (v15.0b moved 334 out of the loaded set). We render from the unified registry
    (~/.ultron/skills/registry.json) filtering to state in {active, plugin}; fall
    back to manifest.cache.json (excluding deprecated entries) if it's missing.
    """
    # Preferred: unified registry v2 (SSOT, real descriptions, state-aware)
    if SKILLS_REGISTRY_V2.exists():
        try:
            data = json.loads(SKILLS_REGISTRY_V2.read_text(encoding="utf-8-sig"))
            skills = data.get("skills") or {}
            lines = []
            for e in (skills.values() if isinstance(skills, dict) else skills):
                if not isinstance(e, dict):
                    continue
                if e.get("state") not in ("active", "plugin"):
                    continue
                name = e.get("name") or ""
                if name:
                    lines.append(f"- {name}: {e.get('description', '')}")
            if lines:
                return "\n".join(lines)
        except (json.JSONDecodeError, OSError):
            pass
    # Fallback: manifest cache, skipping deprecated
    if not MANIFEST_CACHE.exists():
        return ""
    try:
        data = json.loads(MANIFEST_CACHE.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return ""
    skills = data.get("skills") or data.get("entries") or []
    if not isinstance(skills, list):
        return ""
    lines = []
    for entry in skills:
        if not isinstance(entry, dict):
            continue
        if entry.get("deprecated") or entry.get("status") == "deprecated":
            continue
        name = entry.get("name") or entry.get("id") or ""
        desc = entry.get("description") or ""
        if name:
            lines.append(f"- {name}: {desc}")
    return "\n".join(lines)


def _estimate_tool_descriptions() -> str:
    """Best-effort approximation of tool descriptions block.

    Tool descriptions live inside the harness, not in user files. We
    approximate by reading the global CLAUDE.md sections that document
    tool usage (Bash/Edit/Read etc). Real measurement requires harness
    internals — see Research-1 follow-up.
    """
    if not GLOBAL_CLAUDE_MD.exists():
        return ""
    raw = _read_safe(GLOBAL_CLAUDE_MD)
    # Take everything between "Using your tools" and the next H1, if exists.
    marker_start = raw.find("# Using your tools")
    if marker_start == -1:
        marker_start = raw.find("## Using your tools")
    if marker_start == -1:
        return ""
    # Find next H1 after marker
    rest = raw[marker_start:]
    next_h1 = rest.find("\n# ", 1)
    return rest if next_h1 == -1 else rest[:next_h1]


def measure_session_start() -> list[dict[str, Any]]:
    """Measure all 5 blocks. Returns list ordered as TSV columns demand."""
    return [
        measure_block("context_md", _read_safe(CONTEXT_MD)),
        measure_block("MEMORY_md", _read_safe(MEMORY_MD)),
        measure_block("claude_md_global", _read_safe(GLOBAL_CLAUDE_MD)),
        measure_block("skill_listing", _estimate_skill_listing()),
        measure_block("tool_descriptions", _estimate_tool_descriptions()),
    ]


# ── Atomic writers ────────────────────────────────────────────────────────────


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def write_tsv(measurements: list[dict[str, Any]], date_str: str) -> Path:
    """Write TSV to ~/.ultron/audits/token-baseline-<date>.tsv."""
    AUDITS_DIR.mkdir(parents=True, exist_ok=True)
    out = AUDITS_DIR / f"token-baseline-{date_str}.tsv"
    lines = ["block_name\tbytes\tchars\ttokens_estimated\ttokens_method"]
    for m in measurements:
        lines.append(
            f"{m['name']}\t{m['bytes']}\t{m['chars']}\t{m['tokens']}\t{m['method']}"
        )
    _atomic_write(out, "\n".join(lines) + "\n")
    return out


def write_json(measurements: list[dict[str, Any]], date_iso: str) -> Path:
    """Write JSON snapshot to ~/.ultron/.tmp/token-baseline.json."""
    payload = {
        "schema_version": 1,
        "captured_at": date_iso,
        "blocks": measurements,
        "totals": {
            "tokens": sum(m["tokens"] for m in measurements),
            "bytes": sum(m["bytes"] for m in measurements),
        },
    }
    _atomic_write(JSON_OUT, json.dumps(payload, indent=2, ensure_ascii=False))
    return JSON_OUT


# ── CLI ───────────────────────────────────────────────────────────────────────


def cmd_snapshot(args: argparse.Namespace) -> int:
    measurements = measure_session_start()
    now = datetime.now()
    tsv_path = write_tsv(measurements, now.strftime("%Y-%m-%d"))
    json_path = write_json(measurements, now.isoformat(timespec="seconds"))
    total = sum(m["tokens"] for m in measurements)
    print(f"[token-baseline] snapshot ({total:,} tokens total)")
    for m in measurements:
        print(f"  {m['name']:<20} {m['tokens']:>7,} tok  ({m['bytes']:>7,} B)")
    print(f"[token-baseline] TSV  -> {tsv_path}")
    print(f"[token-baseline] JSON -> {json_path}")
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    baseline_path = Path(args.baseline).expanduser()
    if not baseline_path.exists():
        print(f"[token-baseline] baseline not found: {baseline_path}",
              file=sys.stderr)
        return 1
    try:
        baseline = json.loads(baseline_path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"[token-baseline] invalid baseline JSON: {e}", file=sys.stderr)
        return 1

    current = measure_session_start()
    base_blocks = {b["name"]: b for b in baseline.get("blocks", [])}
    cur_blocks = {b["name"]: b for b in current}
    all_names = sorted(set(base_blocks) | set(cur_blocks))

    print(f"[diff] baseline {baseline.get('captured_at', '?')} -> now")
    print(f"  {'block':<20} {'baseline':>10} {'now':>10} {'delta':>10}")
    total_delta = 0
    for name in all_names:
        b = base_blocks.get(name, {}).get("tokens", 0)
        c = cur_blocks.get(name, {}).get("tokens", 0)
        delta = c - b
        total_delta += delta
        sign = "+" if delta > 0 else ""
        print(f"  {name:<20} {b:>10,} {c:>10,} {sign}{delta:>9,}")
    sign = "+" if total_delta > 0 else ""
    print(f"  {'TOTAL':<20} {'':>10} {'':>10} {sign}{total_delta:>9,}")
    return 0


def cmd_budget(args: argparse.Namespace) -> int:
    measurements = measure_session_start()
    print(f"[budget] per-block actual vs default")
    print(f"  {'block':<20} {'actual':>10} {'budget':>10} {'status':>8}")
    over_count = 0
    for m in measurements:
        budget = DEFAULT_BUDGETS.get(m["name"], 0)
        status = "OVER" if budget and m["tokens"] > budget else "ok"
        if status == "OVER":
            over_count += 1
        b_str = f"{budget:,}" if budget else "—"
        print(f"  {m['name']:<20} {m['tokens']:>10,} {b_str:>10} {status:>8}")
    return 1 if over_count > 0 else 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="token_baseline",
                                 description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    p_snap = sub.add_parser("snapshot", help="Write TSV + JSON snapshot")
    p_snap.set_defaults(func=cmd_snapshot)

    p_diff = sub.add_parser("diff", help="Compare current vs baseline JSON")
    p_diff.add_argument("baseline", help="Path to baseline JSON")
    p_diff.set_defaults(func=cmd_diff)

    p_bud = sub.add_parser("budget", help="Show per-block actual vs budget")
    p_bud.set_defaults(func=cmd_budget)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
