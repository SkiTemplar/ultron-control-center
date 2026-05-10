"""ULTRON v14.5 META-PROMPTER — Phase 4 self-eval scorer.

Builds a meta-prompt that asks Claude/Codex to score a (prompt, output) pair
across four dimensions on a 0-10 scale, parses the structured reply, and
caches results by (prompt_sha1, output_sha1).

Dimensions (from macro plan v14.3 Phase 4):
  - precision      (does the output answer what the prompt asked?)
  - concision      (is it appropriately compact?)
  - format         (does it respect required structure / schema?)
  - completeness   (does it cover the requested scope without gaps?)

Module is pure-IO with no API calls; the actual model invocation is the
caller's responsibility. Tests use fixed mock responses.

Length-bias guard: the meta-prompt explicitly tells the judge NOT to reward
verbosity. The acceptance criterion (length-neutrality test in macro plan)
is enforced by `assess_length_bias()` over a corpus of (short, long) pairs.

CLI:
  prompt_eval.py preview <prompt_file> <output_file>      # render meta-prompt
  prompt_eval.py parse <response_file>                    # ScoreCard JSON
  prompt_eval.py cache-stats                              # cache size
  prompt_eval.py length-bias <pairs_file>                 # bias check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import textwrap
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _cache_file() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "prompt-eval-cache.json"


# ── Data shapes ────────────────────────────────────────────────────────────────


_DIMENSIONS = ("precision", "concision", "format", "completeness")


@dataclass
class ScoreCard:
    precision: float
    concision: float
    format: float
    completeness: float
    rationale: str = ""

    def composite(self) -> float:
        """Average across all 4 dimensions."""
        return round(
            (self.precision + self.concision + self.format + self.completeness) / 4,
            2,
        )

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["composite"] = self.composite()
        return d


# ── Meta-prompt template ───────────────────────────────────────────────────────


_EVAL_TEMPLATE = textwrap.dedent("""\
    You are an expert evaluator. Score the OUTPUT against the PROMPT on four
    independent dimensions. Each score is an integer or one decimal place,
    range 0.0..10.0. Be strict: most outputs score 5-7; reserve 9-10 for
    exceptional, 0-3 for near-failure.

    DIMENSIONS:
      precision     — does the output answer the question / fulfill the task?
      concision     — is the length appropriate? Penalize verbosity AND padding;
                      DO NOT reward extra length unless it carries new content.
      format        — does it respect the structure/schema the prompt required?
      completeness  — does it cover all parts of the request without gaps?

    LENGTH-NEUTRALITY GUARD: shorter outputs that fully answer score HIGHER
    on concision than longer ones with the same answer.

    [PROMPT]
    ----------8<----------
    {prompt}
    ----------8<----------

    [OUTPUT]
    ----------8<----------
    {output}
    ----------8<----------

    REQUIRED RESPONSE FORMAT (do not deviate, machine-parsed):

    <SCORES>
    precision: <0.0..10.0>
    concision: <0.0..10.0>
    format: <0.0..10.0>
    completeness: <0.0..10.0>
    </SCORES>

    <RATIONALE>
    <one short paragraph: which dimension dominates the verdict, why.>
    </RATIONALE>
""")


def build_eval_prompt(prompt: str, output: str) -> str:
    """Render the judge meta-prompt. Pure: no IO, no model call."""
    return _EVAL_TEMPLATE.format(
        prompt=prompt.strip()[:6000],
        output=output.strip()[:6000],
    )


# ── Parsing ────────────────────────────────────────────────────────────────────


_SCORES_RE = re.compile(r"<SCORES>\s*(.*?)\s*</SCORES>", re.DOTALL)
_RATIONALE_RE = re.compile(r"<RATIONALE>\s*(.*?)\s*</RATIONALE>", re.DOTALL)


def parse_eval_response(raw: str) -> ScoreCard | None:
    if not raw:
        return None
    s_match = _SCORES_RE.search(raw)
    if not s_match:
        return None
    scores: dict[str, float] = {}
    for line in s_match.group(1).splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip().lower()
        if k not in _DIMENSIONS:
            continue
        try:
            scores[k] = max(0.0, min(10.0, float(v.strip())))
        except ValueError:
            continue
    if set(scores) != set(_DIMENSIONS):
        return None
    rationale_match = _RATIONALE_RE.search(raw)
    rationale = rationale_match.group(1).strip() if rationale_match else ""
    return ScoreCard(
        precision=scores["precision"],
        concision=scores["concision"],
        format=scores["format"],
        completeness=scores["completeness"],
        rationale=rationale,
    )


# ── Cache ──────────────────────────────────────────────────────────────────────


def _key_for(prompt: str, output: str) -> str:
    h = hashlib.sha1()
    h.update(prompt.encode("utf-8"))
    h.update(b"\x00")
    h.update(output.encode("utf-8"))
    return h.hexdigest()


def _load_cache() -> dict[str, Any]:
    f = _cache_file()
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(data: dict[str, Any]) -> None:
    f = _cache_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(f.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, f)


def cache_get(prompt: str, output: str) -> ScoreCard | None:
    cache = _load_cache()
    entry = cache.get(_key_for(prompt, output))
    if not entry:
        return None
    try:
        return ScoreCard(**{k: v for k, v in entry.items() if k in (*_DIMENSIONS, "rationale")})
    except TypeError:
        return None


def cache_put(prompt: str, output: str, card: ScoreCard) -> None:
    cache = _load_cache()
    cache[_key_for(prompt, output)] = card.to_dict()
    _save_cache(cache)


def cache_stats() -> dict[str, Any]:
    cache = _load_cache()
    return {
        "entries": len(cache),
        "path": str(_cache_file()),
        "exists": _cache_file().exists(),
    }


# ── Length-bias check ──────────────────────────────────────────────────────────


def assess_length_bias(pairs: list[tuple[str, str, str]]) -> dict[str, Any]:
    """Check whether the judge rewards verbose outputs disproportionately.

    `pairs` = list of (prompt, short_output, long_output) tuples where the
    short and long outputs convey the SAME information. Each pair must have
    been scored already (cache hits) — the function only inspects cache.

    Returns a summary including:
      - mean delta (long_score - short_score) on concision
      - count where long > short on concision (failure signal)
      - count where long < short on concision (expected)

    Bias <10% per macro plan acceptance: |concision_delta| < 1.0 average.
    """
    deltas: list[float] = []
    for prompt, short_out, long_out in pairs:
        s_short = cache_get(prompt, short_out)
        s_long = cache_get(prompt, long_out)
        if s_short is None or s_long is None:
            continue
        deltas.append(s_long.concision - s_short.concision)
    if not deltas:
        return {"pairs_evaluated": 0, "verdict": "insufficient"}
    mean = sum(deltas) / len(deltas)
    return {
        "pairs_evaluated": len(deltas),
        "mean_concision_delta": round(mean, 3),
        "long_higher": sum(1 for d in deltas if d > 0),
        "long_lower": sum(1 for d in deltas if d < 0),
        "tied": sum(1 for d in deltas if d == 0),
        "verdict": "ok" if abs(mean) < 1.0 else "biased",
    }


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_preview(args: argparse.Namespace) -> int:
    p = Path(args.prompt_file).read_text(encoding="utf-8")
    o = Path(args.output_file).read_text(encoding="utf-8")
    print(build_eval_prompt(p, o))
    return 0


def _cmd_parse(args: argparse.Namespace) -> int:
    raw = Path(args.response_file).read_text(encoding="utf-8")
    card = parse_eval_response(raw)
    if card is None:
        print(json.dumps({"error": "parse failed"}, indent=2))
        return 2
    print(json.dumps(card.to_dict(), indent=2, ensure_ascii=False))
    return 0


def _cmd_cache_stats(args: argparse.Namespace) -> int:
    print(json.dumps(cache_stats(), indent=2))
    return 0


def _cmd_length_bias(args: argparse.Namespace) -> int:
    pairs_data = json.loads(Path(args.pairs_file).read_text(encoding="utf-8"))
    pairs = [(p["prompt"], p["short"], p["long"]) for p in pairs_data]
    print(json.dumps(assess_length_bias(pairs), indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prompt_eval.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prev = sub.add_parser("preview")
    p_prev.add_argument("prompt_file")
    p_prev.add_argument("output_file")
    p_prev.set_defaults(func=_cmd_preview)

    p_parse = sub.add_parser("parse")
    p_parse.add_argument("response_file")
    p_parse.set_defaults(func=_cmd_parse)

    p_cs = sub.add_parser("cache-stats")
    p_cs.set_defaults(func=_cmd_cache_stats)

    p_lb = sub.add_parser("length-bias")
    p_lb.add_argument("pairs_file")
    p_lb.set_defaults(func=_cmd_length_bias)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
