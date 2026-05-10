#!/usr/bin/env python3
"""
ULTRON v12.4 -- Route Quality Metrics + Conflict Solver (Task 6D)

Stores per-edge observed metrics in ~/.ultron/skill_cache/route_quality.json.
Implements conflict_score() for deterministic route selection when multiple
routes could handle the same request.

Scoring formula:
  score = domain_fit*0.30 + observed_success*0.25 + safety_fit*0.15
        + token_efficiency*0.15 + memory_fit*0.10 + recency_fit*0.05

Commands:
    route_quality.py init            Seed route_quality.json from skill manifest
    route_quality.py status          Show top/worst routes by score
    route_quality.py score <from> <to>   Print conflict score for an edge
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CACHE_DIR     = Path.home() / ".ultron" / "skill_cache"
QUALITY_FILE  = CACHE_DIR / "route_quality.json"
MANIFEST_PATH = Path.home() / ".ultron" / "skill_manifest.json"

# ── Failure Recovery States (Task 8C) ─────────────────────────────────────────
RECOVERY_STATES = [
    "retry_same_with_L2",
    "retry_same_with_L3_target",
    "switch_to_fallback",
    "escalate_to_ultron",
    "ask_USER",
    "mark_route_degraded",
]

# Token hard stops per mode (Task 8C)
TOKEN_HARD_STOPS: dict[str, list[str]] = {
    "LOW":    ["L0"],                         # cannot load L2+
    "MEDIUM": ["L0", "L1", "L2"],             # cannot load L4
    "HIGH":   ["L0", "L1", "L2", "L3"],       # L3 target-only
    "ULTRA":  ["L0", "L1", "L2", "L3", "L4"], # all levels with justification
}


def _empty_edge(from_skill: str, to_skill: str) -> dict:
    return {
        "from":            from_skill,
        "to":              to_skill,
        "runs":            0,
        "successes":       0,
        "fallbacks":       0,
        "corrections":     0,
        "avg_token_cost":  0,
        "avg_duration_sec": 0,
        "last_outcome":    "unknown",
        "last_used":       None,
    }


def _compute_score(edge: dict, mode: str = "MEDIUM",
                   domain_fit: float = 0.8, safety_fit: float = 1.0) -> float:
    """Conflict scoring formula. Returns 0.0–1.0."""
    runs = edge.get("runs", 0)

    # Observed success rate (default 0.7 with no data — optimistic prior)
    if runs >= 3:
        observed_success = edge.get("successes", 0) / runs
    else:
        observed_success = 0.70  # prior

    # Token efficiency: lower cost relative to mode budget is better
    budget = {"LOW": 500, "MEDIUM": 2000, "HIGH": 5000, "ULTRA": 20000}.get(mode, 2000)
    avg_cost = edge.get("avg_token_cost", 0)
    if avg_cost and avg_cost < budget:
        token_efficiency = 1.0 - (avg_cost / budget) * 0.5
    else:
        token_efficiency = 0.5  # unknown cost → neutral

    # Memory fit: penalise if route is known to load L4 without ULTRA
    mem_fit = 1.0 if mode in ("HIGH", "ULTRA") else 0.8

    # Recency: penalise if last_outcome was failure
    recency_fit = 0.5 if edge.get("last_outcome") == "failed" else 1.0

    # USER_signal removed in v12.5 (Auditor 3): field was 100% "unknown"
    # because no caller ever set it — pure dead weight in the formula.
    # Reweighted: domain_fit kept at 0.30, observed_success bumped to 0.30
    # (was the most-loadbearing real signal), other weights unchanged.
    score = (
        domain_fit       * 0.30
        + observed_success * 0.30
        + safety_fit       * 0.15
        + token_efficiency * 0.15
        + mem_fit          * 0.05
        + recency_fit      * 0.05
    )
    return round(min(1.0, max(0.0, score)), 4)


def load_quality() -> dict:
    if QUALITY_FILE.exists():
        try:
            return json.loads(QUALITY_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": "1.0", "updated": "", "edges": {}}


def save_quality(data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    data["updated"] = datetime.now().isoformat()
    QUALITY_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def record_outcome(from_skill: str, to_skill: str,
                   success: bool, token_cost: int = 0,
                   duration_sec: float = 0.0) -> None:
    """Update route quality metrics after a skill handoff completes.

    USER_signal parameter removed in v12.5 — was never set by any caller
    (Auditor 3 finding); the scoring branch using it has been deleted.
    """
    data = load_quality()
    key = f"{from_skill}→{to_skill}"
    edge = data["edges"].setdefault(key, _empty_edge(from_skill, to_skill))

    runs = edge["runs"] + 1
    edge["runs"] = runs

    if success:
        edge["successes"] = edge.get("successes", 0) + 1
        edge["last_outcome"] = "success"
    else:
        edge["last_outcome"] = "failed"

    # Rolling average for token cost and duration
    prev_avg_cost = edge.get("avg_token_cost", 0)
    prev_avg_dur  = edge.get("avg_duration_sec", 0)
    if token_cost > 0:
        edge["avg_token_cost"] = round(prev_avg_cost + (token_cost - prev_avg_cost) / runs)
    if duration_sec > 0:
        edge["avg_duration_sec"] = round(prev_avg_dur + (duration_sec - prev_avg_dur) / runs, 1)

    edge["last_used"] = datetime.now(timezone.utc).isoformat()
    save_quality(data)


def resolve_conflict(candidates: list[dict], mode: str = "MEDIUM") -> dict | None:
    """Select the best route from a list of candidate edges.

    candidates: list of {from, to, task_type, domain_fit (0-1), safety_fit (0-1)}
    Returns the winning edge dict augmented with score and reason, or None.
    """
    if not candidates:
        return None
    if len(candidates) == 1:
        return {**candidates[0], "score": 0.8, "reason": "only candidate"}

    data = load_quality()
    scored = []
    for c in candidates:
        key = f"{c['from']}→{c['to']}"
        edge = data["edges"].get(key, _empty_edge(c["from"], c["to"]))
        domain_fit  = c.get("domain_fit", 0.8)
        safety_fit  = c.get("safety_fit", 1.0)
        score = _compute_score(edge, mode, domain_fit, safety_fit)
        scored.append((score, c, edge))

    scored.sort(key=lambda x: -x[0])
    best_score, best_c, _   = scored[0]
    second_score, second_c, _ = scored[1] if len(scored) > 1 else (0, {}, {})

    gap = best_score - second_score

    # Clear winner
    if gap >= 0.10:
        return {**best_c, "score": best_score,
                "reason": f"best score ({best_score:.2f}), gap {gap:.2f} over {second_c.get('to','?')}"}

    # Close race — prefer lower token cost if low risk
    best_edge_data = data["edges"].get(f"{best_c['from']}→{best_c['to']}",
                                       _empty_edge(best_c["from"], best_c["to"]))
    if best_c.get("safety_fit", 1.0) >= 0.9:
        return {**best_c, "score": best_score,
                "reason": f"tie-break on token cost (score {best_score:.2f} vs {second_score:.2f})"}

    # High-risk close race — escalate
    return {"from": best_c.get("from"), "to": "ultron",
            "score": 0.0, "reason": f"close high-risk tie ({best_score:.2f} vs {second_score:.2f}) — escalate"}


def mode_allows_level(mode: str, level: str) -> bool:
    """Return True if the given mode permits loading the given memory level."""
    allowed = TOKEN_HARD_STOPS.get(mode, TOKEN_HARD_STOPS["MEDIUM"])
    # Treat "L3-target-only" as L3, "L3-target-files-only" as L3, etc.
    base = level.split("-")[0] if "-" in level else level
    return base in allowed


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_init(_args) -> int:
    """Seed route_quality.json from manifest route_edges."""
    if not MANIFEST_PATH.exists():
        print("[route_quality] Manifest not found. Run: skill_manifest.py rebuild")
        return 1
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    data = load_quality()

    seeded = 0
    for name, entry in manifest.get("skills", {}).items():
        for edge in entry.get("route_edges", []):
            to_skill = edge.get("to", "")
            if not to_skill:
                continue
            key = f"{name}→{to_skill}"
            if key not in data["edges"]:
                data["edges"][key] = _empty_edge(name, to_skill)
                seeded += 1

    save_quality(data)
    print(f"[route_quality] Seeded {seeded} edges  →  {QUALITY_FILE}")
    return 0


def cmd_status(_args) -> int:
    data = load_quality()
    edges = data.get("edges", {})
    if not edges:
        print("[route_quality] No edges yet. Run: route_quality.py init")
        return 1

    # Score all edges with neutral domain/safety fit
    scored = []
    for key, edge in edges.items():
        score = _compute_score(edge)
        scored.append((score, key, edge))
    scored.sort(key=lambda x: -x[0])

    print(f"\nRoute Quality  [{data.get('updated','never')[:16]}]  {len(edges)} edges")
    print("=" * 60)
    print("Top 10:")
    for score, key, edge in scored[:10]:
        runs = edge.get("runs", 0)
        print(f"  {score:.2f}  {key:<40} runs={runs}  last={edge.get('last_outcome','?')}")
    if len(scored) > 10:
        print(f"\nBottom {min(5, len(scored)-10)}:")
        for score, key, edge in scored[-5:]:
            runs = edge.get("runs", 0)
            print(f"  {score:.2f}  {key:<40} runs={runs}")
    print()
    return 0


def cmd_score(args) -> int:
    data = load_quality()
    key = f"{args.from_skill}→{args.to_skill}"
    edge = data["edges"].get(key, _empty_edge(args.from_skill, args.to_skill))
    score = _compute_score(edge)
    print(f"\nEdge: {key}")
    print(f"Score: {score}")
    for k, v in edge.items():
        print(f"  {k:<22} {v}")
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.4 Route Quality Metrics")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init",   help="Seed route_quality.json from manifest route_edges")
    sub.add_parser("status", help="Show top/worst routes by score")
    sp = sub.add_parser("score", help="Print conflict score for one edge")
    sp.add_argument("from_skill")
    sp.add_argument("to_skill")
    args = p.parse_args()
    if args.cmd == "init":   return cmd_init(args)
    if args.cmd == "status": return cmd_status(args)
    if args.cmd == "score":  return cmd_score(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
