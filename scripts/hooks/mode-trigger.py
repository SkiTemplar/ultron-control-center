#!/usr/bin/env python3
"""
ULTRON UserPromptSubmit hook — auto-register session mode on /high /ultra /learn.

Reads the user's prompt from stdin JSON, detects mode triggers, and calls
memory_sync.py mode <MODE> so the Stop hook sees the correct mode and fires
vault sync + session_compactor. Without this, Stop always reads MEDIUM and
skips all L2 memory operations.

Also detects Hiper Plans intent (planning keywords or explicit invocation)
and appends to ~/.ultron/.tmp/hiper-plans-signals.jsonl for telemetry. Does
NOT inject into the prompt — Hiper Plans activation flows through Claude
Code's native skill auto-discovery from SKILL.md description, gated by the
session mode. See ~/.ultron/plans/2026-05-08-hiper-plans-master.md sec E.4.

Side-effect only — never blocks, never modifies the prompt, always exits 0.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# F02 fix: cockpit path injection so hook_input_validator imports cleanly.
_COCKPIT_PATH = str(
    Path.home() / ".claude" / "skills" / "ultron" / "scripts" / "cockpit"
)
if _COCKPIT_PATH not in sys.path:
    sys.path.insert(0, _COCKPIT_PATH)

MEMORY_SYNC = (
    Path.home() / ".claude" / "skills" / "ultron" / "scripts" / "cockpit" / "memory_sync.py"
)

# Map trigger → canonical mode name accepted by memory_sync.py
_MODE_MAP = {
    "ultra":      "ULTRA",
    "high":       "HIGH",
    "learn":      "LEARN",
    # Dual/triple commands: maxdual/maxtriple require ULTRA per dual-mode-protocol
    "maxdual":    "ULTRA",
    "maxtriple":  "ULTRA",
    # /dual /triple /contrast auto-escalate to HIGH (per SKILL.md OVERLAYS)
    "dual":       "HIGH",
    "triple":     "HIGH",
    "contrast":   "HIGH",
    # /minidual /minitriple /thinking are overlays, do not change mode tier
}

# Phrases that auto-promote to HIGH
_AUTO_HIGH_RE = re.compile(
    r"guarda\s+en\s+memoria|recuerda\s+que|actualiza\s+la\s+memoria"
    r"|save\s+to\s+memory|remember\s+that"
    r"|refresca\s+knowledge|consolida\s+memoria|limpia\s+memoria"
    r"|mejora\s+tu\s+skill",
    re.IGNORECASE,
)

# Order matters: longer prefixes (maxdual, maxtriple) before shorter (dual, triple)
_SLASH_MODE_RE = re.compile(
    r"/(?P<mode>maxdual|maxtriple|ultra|high|learn|dual|triple|contrast)\b",
    re.IGNORECASE,
)

# ── Hiper Plans intent detection (telemetry only — does NOT inject into prompt)
# Keep these regexes in sync with:
#   ~/.claude/skills/hiper-plans/SKILL.md (description triggers)
#   ~/.claude/skills/hiper-plans/tests/intent-corpus.md (20 hand-labeled prompts)
_HIPER_PLANS_NAME_RE = re.compile(
    r"/hiperplan\b|hiper\s*plan|hyper\s*plan|plan\s+profundo|deep\s+plan|spec\s+driven",
    re.IGNORECASE,
)
_HIPER_PLANS_INTENT_RE = re.compile(
    r"\b(plan|estrategia|dise[ñn]a|arquitectura|roadmap|spec|"
    r"refactor.*completo|implementa.*\w+\s+(en\s+)?(\d+|varias?)\s*fase)",
    re.IGNORECASE,
)
_HIPER_PLANS_LOG = Path.home() / ".ultron" / ".tmp" / "hiper-plans-signals.jsonl"


def _detect_mode(prompt: str) -> str | None:
    m = _SLASH_MODE_RE.search(prompt)
    if m:
        return _MODE_MAP[m.group("mode").lower()]
    if _AUTO_HIGH_RE.search(prompt):
        return "HIGH"
    return None


def _detect_hiper_plans_signal(prompt: str, mode: str | None) -> str | None:
    """Return signal kind if Hiper Plans should be considered.

    Returns "by-name" for explicit invocation (any mode except LOW),
    "by-intent" for keyword + mode HIGH/ULTRA, else None.

    LOW mode HARD-forbids Hiper Plans regardless of trigger (per spec E.5).
    MEDIUM never auto-fires by intent (Stechly NeurIPS 2024 — CoT does
    not generalize OOD, overhead unjustified for routine tasks).
    """
    if mode == "LOW":
        return None
    if _HIPER_PLANS_NAME_RE.search(prompt):
        return "by-name"
    if mode in ("HIGH", "ULTRA") and _HIPER_PLANS_INTENT_RE.search(prompt):
        return "by-intent"
    return None


def _log_hiper_plans_signal(signal: str, mode: str | None, prompt: str) -> None:
    """Append a telemetry line to ~/.ultron/.tmp/hiper-plans-signals.jsonl.

    Best-effort. Failures are silent — telemetry never blocks the hook.
    """
    try:
        _HIPER_PLANS_LOG.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "signal": signal,
            "mode": mode or "MEDIUM",
            "prompt_preview": prompt[:200],
        }
        with _HIPER_PLANS_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _set_mode(mode: str) -> None:
    if not MEMORY_SYNC.exists():
        return
    try:
        uv_ok = subprocess.run(
            ["uv", "--version"], capture_output=True, timeout=3
        ).returncode == 0
        cmd = (["uv", "run", "python"] if uv_ok else ["python"]) + [
            str(MEMORY_SYNC), "mode", mode
        ]
        subprocess.run(cmd, capture_output=True, timeout=10)
    except Exception:
        pass


def main() -> None:
    # F-MaxDual-R3-H1 fix: read stdin via the BOUNDED + VALIDATED helper
    # (`safe_load_stdin`) so the 4 MiB cap, null-byte rejection, schema
    # validation, and alert emission all run before any logic touches
    # the payload. Previous implementation did its own unbounded
    # `sys.stdin.read()` + `json.loads(raw)`, which bypassed the hook
    # input validator's size cap on the live UserPromptSubmit path.
    try:
        from hook_input_validator import safe_load_stdin
    except Exception:
        sys.exit(0)
    data = safe_load_stdin("UserPromptSubmit")
    if data is None:
        # Validation failed (oversized, malformed, schema mismatch, null
        # byte). The validator already emitted the deduped warn alert.
        # Hook contract: exit 0, never block user flow — Claude still
        # receives the prompt; we just skip the mode side-effect.
        sys.exit(0)

    if data.get("hook_event_name") != "UserPromptSubmit":
        sys.exit(0)

    prompt = data.get("prompt", "")
    if not isinstance(prompt, str):
        sys.exit(0)

    mode = _detect_mode(prompt)
    if mode:
        _set_mode(mode)

    # Telemetry: Hiper Plans intent detection. Does NOT inject into prompt
    # (skill activation flows through Claude Code's native auto-discovery
    # via SKILL.md description). The JSONL log lets us audit which prompts
    # would have triggered the skill — useful for tuning the regex.
    signal = _detect_hiper_plans_signal(prompt, mode)
    if signal is not None:
        _log_hiper_plans_signal(signal, mode, prompt)

    sys.exit(0)


if __name__ == "__main__":
    main()
