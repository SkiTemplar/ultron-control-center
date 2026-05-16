#!/usr/bin/env python3
"""
ULTRON v13.1 — Thompson Sampling routing decision (Sprint 4 F3).

Closes SI-CRIT-2 (route_quality measured but never affects routing) by
providing a `decide()` function that mode handlers can call when faced with
2+ candidate personas/skills with similar capability priority.

Algorithm: Thompson Sampling over Beta(α, β) distributions per edge.
  - α = successes + 1 (smoothed)
  - β = (runs - successes) + 1
  - For each candidate, draw a sample; pick highest sample → exploration vs
    exploitation balance native to Beta distribution.

Guards (avoid using sparse data):
  - Each candidate needs runs ≥ MIN_RUNS (default 5).
  - Best candidate's success rate must exceed FLOOR (default 0.7) OR be at
    least 20% better than worst candidate.
  - Otherwise → return None (caller falls back to capability-based routing).

Usage from mode handlers / cockpit scripts:

    from routing_decide import decide_persona
    pick = decide_persona(["gamedev-engineer", "terry-davis"], context="ue5 multiplayer")
    if pick is None:
        # fall back to original capability-based selection
        pass
    else:
        # use bandit pick
        pass

CLI:
    routing_decide.py decide --candidates gamedev-engineer terry-davis  # try a decision
    routing_decide.py inspect --candidates gamedev-engineer terry-davis # show edge stats
    routing_decide.py stats                                         # global telemetry summary
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import ROUTE_QUALITY_JSON

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MIN_RUNS = 5         # minimum samples per candidate to trust telemetry
FLOOR    = 0.7       # winning success rate must exceed this OR
SUPERIORITY = 0.20   # be ≥20pp better than worst


def _load_route_quality() -> dict:
    if not ROUTE_QUALITY_JSON.exists():
        return {}
    try:
        # File written by route_quality_aggregator with UTF-8 BOM (PS5.1 default)
        return json.loads(ROUTE_QUALITY_JSON.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return {}


def _edge_stats(persona: str, route_quality: dict) -> tuple[int, int]:
    """Return aggregated (runs, successes) for edges TARGETING this persona.

    Schema observed (~/.ultron/skill_cache/route_quality.json):
        {"edges": {"source→target": {"from": ..., "to": ..., "runs": N,
                                       "successes": M, ...}, ...}}

    We aggregate "how often this persona succeeded when chosen as target".
    """
    runs, successes = 0, 0
    edges = route_quality.get("edges") if isinstance(route_quality, dict) else None
    if not edges:
        return 0, 0
    iter_edges = edges.values() if isinstance(edges, dict) else edges
    for e in iter_edges:
        if not isinstance(e, dict):
            continue
        if e.get("to") == persona:
            runs      += int(e.get("runs", 0) or 0)
            successes += int(e.get("successes", 0) or 0)
    return runs, successes


def _thompson_sample(successes: int, runs: int, rng: random.Random | None = None) -> float:
    """Draw one Thompson sample: Beta(successes+1, failures+1)."""
    rng = rng or random.Random()
    alpha = successes + 1
    beta  = max(runs - successes, 0) + 1
    # random.betavariate is stdlib, sufficient precision for our needs
    return rng.betavariate(alpha, beta)


def decide_persona(candidates: list[str], context: str = "",
                   *, seed: int | None = None) -> str | None:
    """Pick best persona via Thompson Sampling. Returns None if data too sparse.

    None signals to the caller: 'use your normal capability-based routing'.
    """
    if not candidates or len(candidates) < 2:
        return None
    rq = _load_route_quality()
    stats = {p: _edge_stats(p, rq) for p in candidates}
    # Guard 1: every candidate must have MIN_RUNS samples
    if any(runs < MIN_RUNS for runs, _ in stats.values()):
        return None
    # Guard 2: best success rate must exceed FLOOR or differ from worst by SUPERIORITY
    rates = {p: (s / r) if r else 0.0 for p, (r, s) in stats.items()}
    best_rate  = max(rates.values())
    worst_rate = min(rates.values())
    if best_rate < FLOOR and (best_rate - worst_rate) < SUPERIORITY:
        return None
    # Thompson sample each candidate
    rng = random.Random(seed)
    samples = {p: _thompson_sample(s, r, rng) for p, (r, s) in stats.items()}
    return max(samples, key=samples.get)


# ─── CLI ───────────────────────────────────────────────────────────────────────

def cmd_decide(args) -> int:
    pick = decide_persona(args.candidates, context=" ".join(args.context),
                           seed=args.seed)
    if pick is None:
        print(f"[routing_decide] data too sparse — caller should use fallback routing")
        print(f"  candidates: {args.candidates}")
        return 1
    print(f"[routing_decide] pick: {pick}")
    return 0


def cmd_inspect(args) -> int:
    rq = _load_route_quality()
    print(f"[routing_decide] inspecting {len(args.candidates)} candidate(s):\n")
    for p in args.candidates:
        runs, successes = _edge_stats(p, rq)
        rate = (successes / runs * 100) if runs else 0
        print(f"  {p:<25} runs={runs:<4} successes={successes:<4} rate={rate:.1f}%")
    print(f"\n  thresholds: MIN_RUNS={MIN_RUNS}  FLOOR={FLOOR*100:.0f}%  "
          f"SUPERIORITY={SUPERIORITY*100:.0f}pp")
    return 0


def cmd_stats(_args) -> int:
    rq = _load_route_quality()
    edges = rq.get("edges", [])
    if not isinstance(edges, list):
        edges = []
    eligible = [e for e in edges if isinstance(e, dict) and (e.get("runs") or 0) >= MIN_RUNS]
    print(f"[routing_decide] route_quality: {len(edges)} edges, {len(eligible)} eligible (≥{MIN_RUNS} runs)")
    print(f"  threshold gates: MIN_RUNS={MIN_RUNS} FLOOR={FLOOR} SUPERIORITY={SUPERIORITY}")
    return 0


def main():
    p = argparse.ArgumentParser(prog="routing_decide",
                                description="ULTRON v13.1 Thompson Sampling routing decision")
    sub = p.add_subparsers(dest="cmd", required=True)

    sd = sub.add_parser("decide", help="Pick best candidate via Thompson Sampling")
    sd.add_argument("--candidates", nargs="+", required=True)
    sd.add_argument("--context", nargs="*", default=[])
    sd.add_argument("--seed", type=int)
    sd.set_defaults(func=cmd_decide)

    si = sub.add_parser("inspect", help="Show telemetry stats for candidates")
    si.add_argument("--candidates", nargs="+", required=True)
    si.set_defaults(func=cmd_inspect)

    ss = sub.add_parser("stats", help="Global route_quality summary")
    ss.set_defaults(func=cmd_stats)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
