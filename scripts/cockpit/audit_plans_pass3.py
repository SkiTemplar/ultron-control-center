"""Audit pass 3 — close plans whose work shipped in the v15.1.4 + v15.1.5 +
v15.2 release-prep drop (commits 652d9a1, 2c87b30, ba3ad44 and the
v15.1.1 series). Leave BUS, mobile, AI-detector, auto-updater (in flight),
theme toggle and macOS/Linux ports open as future work.

Usage:
    uv run python scripts/cockpit/audit_plans_pass3.py --dry-run
    uv run python scripts/cockpit/audit_plans_pass3.py
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

PLANS = Path(os.path.expanduser("~/.ultron/plans/PLANS.json"))

# Plans now resolved by the v15.1.4 + v15.1.5 + v15.2 release-prep commits.
# Each value: (commit_hash, justification grounded in actual diff/message).
DONE: dict[str, tuple[str, str]] = {
    "v15.1.4-fixes-and-ui": (
        "652d9a1",
        "Shipped in 652d9a1 'massive feature drop': cost watchdog "
        "(cost_watchdog.rs, CostWatchdog.tsx), Inbox quick capture "
        "(inbox.rs, InboxModal.tsx, Ctrl+Alt+I), Tray menu (tray.rs init_tray), "
        "per-project hotkeys (project_hotkeys.rs, hotkeys.rs Ctrl+Alt+1..9), "
        "multi-action projects (projects.rs +72 lines, Projects.tsx +422), "
        "responsive UI (styles.css +104 lines, 4 breakpoints). Logs tab "
        "removed in d89e14c. Personal section split UI shipped in 2c87b30 "
        "(personal.rs +88, Personal.tsx +326).",
    ),
    "v15.1.5-memory-visual-codex-fallback": (
        "652d9a1",
        "Shipped in 652d9a1: Memory visual Qdrant 2D scatter "
        "(memory_graph.rs +382, MemoryGraph.tsx +405, SVG pseudo-UMAP, 752 "
        "brain_index entries), Codex-fallback con contexto ULTRON "
        "(codex_fallback.rs +659 with 7 unit tests, CodexFallbackButton.tsx "
        "+274, 50K prompt cap), Activity timeline (activity_timeline.rs +407, "
        "ActivityTimeline.tsx +572, heatmap over 8 hook signal sources, "
        "7d/30d windows).",
    ),
    "v15.2-public-release": (
        "652d9a1",
        "Release prep shipped in 652d9a1: LICENSE (MIT), README.md, "
        "CONTRIBUTING.md, docs/INSTALL.md, docs/REPO-SPLIT-PLAN.md, "
        "docs/RELEASE-CHECKLIST-v15.2.md, docs/personas-release-decision.md, "
        "scripts/install.ps1 (+488), scripts/install.sh (+484), "
        "scripts/uninstall.{ps1,sh}. Persona-strip sweep on 26 files (0 "
        "hardcoded C:\\Users\\USER remaining). Skill rename propagation "
        "across 66 files (legacy alias -> canonical public skill name). "
        "Helper src/lib/paths.ts added. "
        "Sub-items still open and tracked separately: auto-updater wiring "
        "(si-p1-b-auto-updater), theme toggle, mobile (v15.3-mobile-app). "
        "Tauri-plugin-updater is in Cargo.toml but not yet invoked from "
        "lib.rs; that delta is owned by si-p1-b-auto-updater.",
    ),
    "ultron-arranque-ligero-reducir-overhead-6k-2k-toke": (
        "652d9a1",
        "Superseded by v15.0b-token-diet which itself shipped via skill-vault "
        "(380 -> 46 active skills, commits 9db7d60, 62e62d7, 9ce419e, d0ca426). "
        "Combined with skill_lazy_loader.py + skill_summarizer.py updates in "
        "652d9a1 the initial-token overhead target is no longer 6k -> 2k but "
        "managed via lazy load + summary. Closing as superseded.",
    ),
}

# Plans demoted to wontfix as part of the v15.2 cleanup. These survived
# pass 2 but inspection of recent commits shows they are no longer the
# right shape of work for ULTRON.
WONTFIX: dict[str, str] = {
    "arch-01-ssot": (
        "Three manifests (skills.manifest.yaml, skill_manifest.json, "
        "agent_manifest.json) survived the v15.2 release prep without merge. "
        "skill_manifest.json got +176 lines, skills.manifest.yaml +148. The "
        "system shipped public with the current SSOT shape — collapsing now "
        "is a destabilising refactor for negligible UX gain. Reopen post-v15.3 "
        "if a concrete pain point emerges."
    ),
    "ops-01-stop-pipeline": (
        "Stop pipeline is already idempotent in practice (atomic writes on "
        "alerts.jsonl, file locks, settings backups). No race condition has "
        "surfaced in the v15.1.x heavy-use period. Closing without a formal "
        "test corpus — reopen if a regression is observed."
    ),
}

# Plans we explicitly keep open as future work.
KEEP_OPEN_WITH_NOTE: dict[str, str] = {
    "v15.1-bus-foundation": (
        "Storage layer landed in a6a2b0b (25 tests) but full MCP server + "
        "mailbox + cross-session registry still pending. Stays open as "
        "part of v15.3 BUS sprint."
    ),
    "v15.2-supervisor": "Stays open as part of v15.3 BUS / mobile pipeline.",
    "v15.3-pipeline": "Stays open as part of v15.3 BUS / mobile pipeline.",
    "v15.4-overnight": "Stays open as part of v15.3 BUS / mobile pipeline.",
    "v15.3-mobile-app": "Stays open — mobile via local server is the v15.3 sprint.",
    "si-p1-b-auto-updater": (
        "tauri-plugin-updater present in Cargo.toml but not yet invoked from "
        "lib.rs / main.rs; auto-updater agent in flight. Leave open."
    ),
    "scan-projects-claude-md": (
        "Manual workaround still works. Reopen if >5 CLAUDE.md containers "
        "appear."
    ),
    "gemini-mcp-rate-limit": (
        "ultron gemini CLI fallback covers the use case. Reopen if the "
        "subscription path also rate-limits."
    ),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report changes but do not write PLANS.json.",
    )
    args = parser.parse_args()

    p = json.loads(PLANS.read_text(encoding="utf-8"))
    now = now_iso()
    today = "2026-05-16"
    resolved: list[str] = []
    wontfix: list[str] = []
    annotated: list[str] = []
    skipped_already_closed: list[str] = []

    for item in p["items"]:
        iid = item.get("id")
        current_status = item.get("status")

        if iid in DONE:
            if current_status in {"resolved", "wontfix"}:
                skipped_already_closed.append(iid)
                continue
            commit, reason = DONE[iid]
            item["status"] = "resolved"
            item["resolved_at"] = now
            item["resolved_in"] = commit
            item["resolved_date"] = today
            item.setdefault("notes", []).append(
                {"ts": now, "text": f"[auto-audit pass3 resolved in {commit}] {reason}"}
            )
            resolved.append(iid)

        elif iid in WONTFIX:
            if current_status in {"resolved", "wontfix"}:
                skipped_already_closed.append(iid)
                continue
            item["status"] = "wontfix"
            item["resolved_at"] = now
            item["resolved_date"] = today
            item.setdefault("notes", []).append(
                {"ts": now, "text": f"[auto-audit pass3 wontfix] {WONTFIX[iid]}"}
            )
            wontfix.append(iid)

        elif iid in KEEP_OPEN_WITH_NOTE:
            note_text = f"[audit pass3] {KEEP_OPEN_WITH_NOTE[iid]}"
            notes = item.setdefault("notes", [])
            if not any(n.get("text") == note_text for n in notes):
                notes.append({"ts": now, "text": note_text})
                annotated.append(iid)

    p["updated_at"] = now

    print("=" * 60)
    print(f"AUDIT PASS 3 — {today}")
    print("=" * 60)
    print(f"resolved={len(resolved)}")
    for iid in resolved:
        print(f"  - {iid}")
    print(f"wontfix={len(wontfix)}")
    for iid in wontfix:
        print(f"  - {iid}")
    print(f"annotated_keep_open={len(annotated)}")
    for iid in annotated:
        print(f"  - {iid}")
    print(f"already_closed_skip={len(skipped_already_closed)}")
    print(f"total_items={len(p['items'])}")

    open_items = [i for i in p["items"] if i.get("status") == "open"]
    deferred_items = [i for i in p["items"] if i.get("status") == "deferred"]
    print(f"remaining_open={len(open_items)} remaining_deferred={len(deferred_items)}")
    for i in open_items:
        print(f"  OPEN: {i['id']} — {i.get('title', '')[:70]}")
    for i in deferred_items:
        print(f"  DEFERRED: {i['id']} — {i.get('title', '')[:70]}")

    if args.dry_run:
        print("\n[DRY RUN] No changes written.")
        return 0

    tmp = PLANS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(p, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PLANS)
    print(f"\nWrote {PLANS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
