"""ULTRON v14.5 META-PROMPTER — Phase 1 prompt improver.

Generates an improvement proposal for an existing prompt using a fixed
meta-prompt template (Anthropic cookbook pattern). The improved prompt is
returned as a string with a unified diff vs the original; it is NEVER
auto-applied (anti-laundering invariant from macro plan).

Inputs the improver consumes:
  - current_prompt:    text of the prompt to improve
  - sample_outputs:    list of recent outputs the prompt produced
  - user_edits:        list of (was, became) pairs captured from feedback hook
  - failure_modes:     list of human-flagged failure descriptions

Outputs:
  - meta_prompt:       the rendered meta-prompt sent to Claude/Codex
  - improved_prompt:   the model-suggested rewrite
  - diff:              unified diff of current vs improved
  - rationale:         model-extracted reasoning section

This module does NOT call any API. The actual model invocation is the caller's
responsibility (Claude tool use, codex-duet.ps1, etc.). The module returns
either a payload ready to send (`build_meta_prompt`) or, when given a model-
response string, parses it (`parse_response`).

CLI:
  prompt_improver.py preview <path>          # render meta-prompt + payload
  prompt_improver.py diff <current> <new>    # unified diff
  prompt_improver.py status                  # corpus + last-improved markers
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import sys
import textwrap
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _feedback_jsonl() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "prompt-feedback.jsonl"


def _improver_log() -> Path:
    return _user_home() / ".ultron" / "audits" / "prompt-improver-log.jsonl"


# ── Data shapes ────────────────────────────────────────────────────────────────


@dataclass
class ImproverInput:
    current_prompt: str
    sample_outputs: list[str] = field(default_factory=list)
    user_edits: list[tuple[str, str]] = field(default_factory=list)
    failure_modes: list[str] = field(default_factory=list)
    target_label: str = ""

    def fingerprint(self) -> str:
        h = hashlib.sha1()
        h.update(self.current_prompt.encode("utf-8"))
        for s in self.sample_outputs:
            h.update(b"\x00")
            h.update(s.encode("utf-8"))
        for a, b in self.user_edits:
            h.update(b"\x00")
            h.update(a.encode("utf-8"))
            h.update(b.encode("utf-8"))
        return h.hexdigest()[:16]


@dataclass
class ImproverPayload:
    meta_prompt: str
    fingerprint: str
    target_label: str
    sample_count: int
    edit_count: int
    failure_count: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ImproverResponse:
    improved_prompt: str
    rationale: str
    raw: str

    def diff_against(self, original: str) -> str:
        return "".join(difflib.unified_diff(
            original.splitlines(keepends=True),
            self.improved_prompt.splitlines(keepends=True),
            fromfile="current",
            tofile="improved",
            lineterm="",
        ))


# ── Meta-prompt template (Anthropic cookbook pattern, frozen) ──────────────────


_META_PROMPT_TEMPLATE = textwrap.dedent("""\
    You are an expert prompt engineer. Improve the following prompt without
    changing its purpose or interface (parameters, output schema). Keep what
    works; rewrite only what causes the failure modes listed.

    INVARIANTS:
    - Do NOT change the prompt's intent or required output format.
    - Preserve any explicit constraints (token limits, language, persona).
    - Do NOT add new dependencies the original did not have.
    - Output the improved prompt as plain text, NO commentary inside it.

    INPUTS:

    [CURRENT PROMPT — verbatim]
    ----------8<----------
    {current_prompt}
    ----------8<----------

    [SAMPLE OUTPUTS — recent runs of the current prompt]
    {sample_block}

    [USER EDITS — {edit_count} (was → became), high-value signal]
    {edit_block}

    [FAILURE MODES — human-flagged]
    {failure_block}

    REQUIRED RESPONSE FORMAT (do not deviate):

    <RATIONALE>
    <one short paragraph: which failure modes you addressed, what changed.>
    </RATIONALE>

    <IMPROVED_PROMPT>
    <the rewritten prompt verbatim, ready to drop in>
    </IMPROVED_PROMPT>
""")


def _format_samples(samples: list[str], max_each: int = 800) -> str:
    if not samples:
        return "(none provided)"
    lines = []
    for i, s in enumerate(samples, 1):
        snippet = s.strip()
        if len(snippet) > max_each:
            snippet = snippet[:max_each] + "...[truncated]"
        lines.append(f"--- sample {i} ---\n{snippet}")
    return "\n".join(lines)


def _format_edits(edits: list[tuple[str, str]], max_each: int = 240) -> str:
    if not edits:
        return "(none provided)"
    out = []
    for i, (was, became) in enumerate(edits, 1):
        w = was.strip()[:max_each]
        b = became.strip()[:max_each]
        out.append(f"#{i}\n  was:    {w}\n  became: {b}")
    return "\n".join(out)


def _format_failures(failures: list[str]) -> str:
    if not failures:
        return "(none provided)"
    return "\n".join(f"- {f}" for f in failures)


# ── Public API ─────────────────────────────────────────────────────────────────


def build_meta_prompt(inp: ImproverInput) -> ImproverPayload:
    """Render the meta-prompt for the given input. Pure: no IO, no model call."""
    rendered = _META_PROMPT_TEMPLATE.format(
        current_prompt=inp.current_prompt.strip(),
        sample_block=_format_samples(inp.sample_outputs),
        edit_count=len(inp.user_edits),
        edit_block=_format_edits(inp.user_edits),
        failure_block=_format_failures(inp.failure_modes),
    )
    return ImproverPayload(
        meta_prompt=rendered,
        fingerprint=inp.fingerprint(),
        target_label=inp.target_label,
        sample_count=len(inp.sample_outputs),
        edit_count=len(inp.user_edits),
        failure_count=len(inp.failure_modes),
    )


_RATIONALE_OPEN = "<RATIONALE>"
_RATIONALE_CLOSE = "</RATIONALE>"
_IMPROVED_OPEN = "<IMPROVED_PROMPT>"
_IMPROVED_CLOSE = "</IMPROVED_PROMPT>"


def parse_response(raw_response: str) -> ImproverResponse | None:
    """Extract <RATIONALE> + <IMPROVED_PROMPT> from a model reply.

    Returns None if either section is missing or empty (caller should treat
    this as a malformed reply — never auto-apply).
    """
    text = raw_response or ""
    rationale = _extract_block(text, _RATIONALE_OPEN, _RATIONALE_CLOSE)
    improved = _extract_block(text, _IMPROVED_OPEN, _IMPROVED_CLOSE)
    if not rationale or not improved:
        return None
    return ImproverResponse(
        improved_prompt=improved.strip() + "\n",
        rationale=rationale.strip(),
        raw=text,
    )


def _extract_block(text: str, open_tag: str, close_tag: str) -> str | None:
    start = text.find(open_tag)
    if start == -1:
        return None
    start += len(open_tag)
    end = text.find(close_tag, start)
    if end == -1:
        return None
    return text[start:end].strip()


def diff_prompts(current: str, improved: str) -> str:
    return "".join(difflib.unified_diff(
        current.splitlines(keepends=True),
        improved.splitlines(keepends=True),
        fromfile="current",
        tofile="improved",
        lineterm="",
    ))


# ── Telemetry log ──────────────────────────────────────────────────────────────


def log_improvement(
    inp: ImproverInput,
    response: ImproverResponse | None,
    *,
    accepted: bool = False,
    note: str = "",
) -> None:
    """Append-only log so callers can audit what was proposed and what stuck."""
    out = _improver_log()
    out.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "target_label": inp.target_label,
        "fingerprint": inp.fingerprint(),
        "samples": len(inp.sample_outputs),
        "edits": len(inp.user_edits),
        "failures": len(inp.failure_modes),
        "got_response": response is not None,
        "accepted": accepted,
        "note": note,
    }
    if response is not None:
        record["rationale"] = response.rationale[:400]
    with out.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# ── Loader for feedback corpus ─────────────────────────────────────────────────


def load_feedback_for(target_label: str, limit: int = 20) -> dict[str, Any]:
    """Read recent ImproverInput-shaped feedback from prompt-feedback.jsonl.

    Returns {"sample_outputs": [...], "user_edits": [...], "failure_modes": [...]}.
    Defensive: missing file → empty payload, malformed lines skipped silently.
    """
    out = {"sample_outputs": [], "user_edits": [], "failure_modes": []}
    f = _feedback_jsonl()
    if not f.exists():
        return out
    try:
        text = f.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in reversed(text.splitlines()):
        if len(out["sample_outputs"]) >= limit:
            break
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("target") != target_label:
            continue
        if ev.get("kind") == "sample" and ev.get("output"):
            out["sample_outputs"].append(ev["output"])
        elif ev.get("kind") == "edit" and ev.get("was") is not None:
            out["user_edits"].append((ev["was"], ev.get("became", "")))
        elif ev.get("kind") == "failure" and ev.get("description"):
            out["failure_modes"].append(ev["description"])
    return out


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_preview(args: argparse.Namespace) -> int:
    path = Path(args.path)
    if not path.exists():
        print(f"ERROR: prompt file not found: {path}", file=sys.stderr)
        return 2
    current = path.read_text(encoding="utf-8")
    feedback = load_feedback_for(args.target or path.stem)
    inp = ImproverInput(
        current_prompt=current,
        sample_outputs=feedback["sample_outputs"],
        user_edits=feedback["user_edits"],
        failure_modes=feedback["failure_modes"],
        target_label=args.target or path.stem,
    )
    payload = build_meta_prompt(inp)
    print(json.dumps(payload.to_dict(), indent=2, ensure_ascii=False))
    if args.dump:
        print("\n--- META-PROMPT ---\n")
        print(payload.meta_prompt)
    return 0


def _cmd_diff(args: argparse.Namespace) -> int:
    cur = Path(args.current)
    new = Path(args.improved)
    if not cur.exists() or not new.exists():
        print("ERROR: both files must exist", file=sys.stderr)
        return 2
    diff = diff_prompts(
        cur.read_text(encoding="utf-8"),
        new.read_text(encoding="utf-8"),
    )
    print(diff or "(no diff)")
    return 0 if not diff else 1


def _cmd_feedback(args: argparse.Namespace) -> int:
    """Append a manual feedback entry (edit/failure) to prompt-feedback.jsonl."""
    kind = args.kind
    if kind not in ("edit", "failure"):
        print("ERROR: --kind must be edit or failure", file=sys.stderr)
        return 2
    out = _feedback_jsonl()
    out.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "kind": kind,
        "target": args.target,
    }
    if kind == "edit":
        if not args.was or not args.became:
            print("ERROR: edit kind needs --was and --became", file=sys.stderr)
            return 2
        record["was"] = args.was
        record["became"] = args.became
    else:  # failure
        if not args.description:
            print("ERROR: failure kind needs --description", file=sys.stderr)
            return 2
        record["description"] = args.description
    with out.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(json.dumps({"appended": str(out), "kind": kind}, indent=2))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    log = _improver_log()
    feedback = _feedback_jsonl()
    payload = {
        "improver_log": str(log),
        "improver_log_exists": log.exists(),
        "improver_log_lines": (
            sum(1 for _ in log.open("r", encoding="utf-8"))
            if log.exists() else 0
        ),
        "feedback_jsonl": str(feedback),
        "feedback_jsonl_exists": feedback.exists(),
        "feedback_jsonl_lines": (
            sum(1 for _ in feedback.open("r", encoding="utf-8"))
            if feedback.exists() else 0
        ),
    }
    print(json.dumps(payload, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prompt_improver.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prev = sub.add_parser("preview", help="render meta-prompt for a target")
    p_prev.add_argument("path")
    p_prev.add_argument("--target", default="")
    p_prev.add_argument("--dump", action="store_true",
                        help="also print the rendered meta-prompt body")
    p_prev.set_defaults(func=_cmd_preview)

    p_diff = sub.add_parser("diff", help="unified diff between two prompt files")
    p_diff.add_argument("current")
    p_diff.add_argument("improved")
    p_diff.set_defaults(func=_cmd_diff)

    p_st = sub.add_parser("status", help="improver/feedback log counts")
    p_st.set_defaults(func=_cmd_status)

    p_fb = sub.add_parser("feedback", help="append manual edit/failure entry")
    p_fb.add_argument("--kind", required=True, choices=("edit", "failure"))
    p_fb.add_argument("--target", required=True, help="prompt name / skill label")
    p_fb.add_argument("--was", help="(edit) original text fragment")
    p_fb.add_argument("--became", help="(edit) what user replaced it with")
    p_fb.add_argument("--description", help="(failure) human-readable description")
    p_fb.set_defaults(func=_cmd_feedback)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
