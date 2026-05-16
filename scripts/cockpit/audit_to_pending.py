#!/usr/bin/env python3
"""
ULTRON v13.1 — Auto-extract pending_actions from repo-evaluator audits (Sprint 4 F11).

Closes the manual-feed gap: previously every repo-evaluator audit produced FIX/SEC/
OPS/ARCH/LRN items that someone had to MANUALLY add to pending_actions. Now
this runs automatically (idempotent — same ID = update, not duplicate).

Pattern matched in audit markdown:

    ### FIX-1 [v12.6 — HOY] Title here
    **Status:** ...
    **Effort:** M (4-6h) | **Impact:** CRITICAL | **Confidence:** 100%

    ### SEC-01 — Rotación inmediata de secretos (BLOQUEANTE)
    **Cubre:** ...
    **Effort:** M | **Impact:** HIGH

Severity inferred from Impact label:
    CRITICAL/BLOQUEANTE  → critical
    HIGH                 → high
    MEDIUM               → medium
    LOW                  → low

CLI:
    audit_to_pending.py extract <audit-md>          # extract from one
    audit_to_pending.py extract-all [--since DATE]  # all audits since DATE
    audit_to_pending.py dry-run <audit-md>          # preview without writing
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import AUDITS_DIR, PENDING_ACTIONS_JSON

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# Match `### TAG-NNN ...` where TAG is a known issue-type prefix
ITEM_HEADER_RE = re.compile(
    r"^###\s+(?P<id>(?:FIX|SEC|OPS|ARCH|LRN|H|M|L|S|V|F|C|SI|H-CRIT|M-CRIT|S-CRIT|V-CRIT|H-MED|M-MED|SI-CRIT|SI-MED)-?\d+(?:\.\d+)?)\s*[—-]?\s*(?P<title>[^\n]+)$",
    re.MULTILINE,
)
META_RE = re.compile(
    r"\*\*(?P<key>Status|Effort|Impact|Confidence|Cubre|Plazo|Severity)\*\*\s*:\s*(?P<value>[^\n*|]+)",
    re.IGNORECASE,
)

# FIX-B (v13.2): security-aware severity patterns added BEFORE literal CRITICAL/HIGH.
# Covers CVSS 9/10, RCE, credential/key/plaintext exposure, auth bypass, injection.
# F02 (API key plaintext) and F04 (CVSS 10.0 RCE) were classified "medium" without this.
SEVERITY_FROM_IMPACT = [
    (re.compile(r"\bCVSS\s*10\b|\bCVSS\s*[9]\.\d", re.IGNORECASE), "critical"),
    (re.compile(
        r"\b(RCE|remote\s*code\s*exec|arbitrary\s*code|command\s*injection|"
        r"plaintext.{0,20}(key|secret|token|password|api.?key|credential)|"
        r"credential.{0,20}(leak|explos|plaintext)|"
        r"auth\s*bypass|privilege\s*escal)",
        re.IGNORECASE), "high"),
    (re.compile(r"\b(CRITICAL|CR[Ií]TICO|BLOQUEANTE|BLOCKING)\b", re.IGNORECASE), "critical"),
    (re.compile(r"\b(HIGH|ALTO)\b", re.IGNORECASE),     "high"),
    (re.compile(r"\b(MEDIUM|MEDIO|MED)\b", re.IGNORECASE), "medium"),
    (re.compile(r"\b(LOW|BAJO)\b", re.IGNORECASE),       "low"),
]


def extract_items(audit_md: Path) -> list[dict]:
    """Parse an audit markdown and yield pending_action candidate dicts."""
    text = audit_md.read_text(encoding="utf-8")
    items: list[dict] = []

    for m in ITEM_HEADER_RE.finditer(text):
        item_id = m.group("id").strip().upper()
        title = m.group("title").strip()
        # Clean prefixes like `[v12.6 — HOY]` from title
        title = re.sub(r"\[[^\]]*\]\s*", "", title).strip()
        if not title:
            continue

        # Capture body until next ### or end
        body_start = m.end()
        next_match = re.search(r"^###\s", text[body_start:], re.MULTILINE)
        body_end = body_start + next_match.start() if next_match else len(text)
        body = text[body_start:body_end]

        meta = {}
        for mm in META_RE.finditer(body):
            meta[mm.group("key").lower()] = mm.group("value").strip().rstrip("*").rstrip("|").strip()

        # Infer severity from Impact (or Severity) + title (catches "CVSS 10.0 RCE" in headings)
        severity = "medium"  # default
        impact_text = (meta.get("impact", "") + " " + meta.get("severity", "") + " " + title).strip()
        for pat, sev in SEVERITY_FROM_IMPACT:
            if pat.search(impact_text):
                severity = sev
                break
        # If item_id starts with CRIT or contains CRIT → bump to critical
        if "CRIT" in item_id and severity not in {"critical", "high"}:
            severity = "high"

        is_blocking = bool(re.search(r"BLOQUEANTE|BLOCKING|BLOQUEA|USER ACTION", body + " " + title, re.IGNORECASE))
        # Blocking items are critical regardless of impact text
        if is_blocking and severity not in {"critical"}:
            severity = "critical"
        # SEC/V- prefix items default to high (security)
        if severity == "medium" and re.match(r"^(SEC|V-|H-CRIT)", item_id):
            severity = "high"

        # Description = first 300 chars of body (Status + Effort summary)
        desc_lines = []
        for k in ("status", "cubre", "effort", "impact", "plazo"):
            if k in meta:
                desc_lines.append(f"{k}: {meta[k]}")
        description = " | ".join(desc_lines)[:500]

        items.append({
            "id": item_id,
            "severity": severity,
            "title": title[:200],
            "source": audit_md.name,
            "description": description,
            "blocking": is_blocking,
        })
    return items


def run_pending_add(item: dict) -> bool:
    """Invoke pending_actions.py add with the item. Returns True on success."""
    script = Path(__file__).parent / "pending_actions.py"
    args = [
        sys.executable, str(script), "add",
        "--id",       item["id"],
        "--severity", item["severity"],
        "--title",    item["title"],
        "--source",   item["source"],
    ]
    if item.get("description"):
        args += ["--description", item["description"][:500]]
    if item.get("blocking"):
        args += ["--blocking"]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=8)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


# ─── CLI ───────────────────────────────────────────────────────────────────────

def cmd_dry_run(args) -> int:
    items = extract_items(Path(args.audit))
    print(f"[audit→pending] would extract {len(items)} item(s) from {args.audit}:\n")
    for it in items:
        flag = " [BLOCKING]" if it["blocking"] else ""
        print(f"  {it['severity']:<8} {it['id']:<12}{flag} {it['title']}")
    return 0


def cmd_extract(args) -> int:
    items = extract_items(Path(args.audit))
    written, failed = 0, 0
    for it in items:
        if run_pending_add(it):
            written += 1
        else:
            failed += 1
    print(f"[audit→pending] {args.audit}: written={written} failed={failed}")
    return 0 if failed == 0 else 1


def cmd_extract_all(args) -> int:
    cutoff = None
    if args.since:
        try:
            cutoff = datetime.fromisoformat(args.since)
        except ValueError:
            print(f"[audit→pending] invalid --since date: {args.since}", file=sys.stderr)
            return 2
    if not AUDITS_DIR.exists():
        print(f"[audit→pending] audits dir missing: {AUDITS_DIR}", file=sys.stderr)
        return 1
    # FIX-C (v13.2): narrow glob to exclude *-nota-*, *-matrix-*, *-metrics-* summary files.
    # These share the "repo-evaluator-total*" prefix but are summaries, not full audits.
    # Extracting from them caused false items or silent empty extractions.
    _all = sorted(AUDITS_DIR.glob("repo-evaluator-total*.md"))
    audits = [a for a in _all if not re.search(r'-(nota|matrix|metrics)-', a.name)]
    if not audits:
        # Fallback: no strict audits found — warn and use all (back-compat)
        print(f"[audit→pending] warn: no strict audits found after filter, using all {len(_all)}")
        audits = _all
    if cutoff:
        audits = [a for a in audits
                  if datetime.fromtimestamp(a.stat().st_mtime) >= cutoff]
    total_w, total_f, total_i = 0, 0, 0
    for a in audits:
        items = extract_items(a)
        total_i += len(items)
        for it in items:
            if run_pending_add(it):
                total_w += 1
            else:
                total_f += 1
        print(f"  {a.name}: {len(items)} items")
    print(f"\n[audit→pending] processed {len(audits)} audit(s) — items={total_i} written={total_w} failed={total_f}")
    return 0 if total_f == 0 else 1


def main():
    p = argparse.ArgumentParser(prog="audit_to_pending",
                                description="ULTRON v13.1 audit → pending_actions auto-extract")
    sub = p.add_subparsers(dest="cmd", required=True)

    sd = sub.add_parser("dry-run", help="Preview extraction without writing")
    sd.add_argument("audit")
    sd.set_defaults(func=cmd_dry_run)

    se = sub.add_parser("extract", help="Extract items from one audit + write to queue")
    se.add_argument("audit")
    se.set_defaults(func=cmd_extract)

    sa = sub.add_parser("extract-all", help="Process all repo-evaluator-total audits in dir")
    sa.add_argument("--since", help="Only audits modified after ISO date (e.g. 2026-05-03)")
    sa.set_defaults(func=cmd_extract_all)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
