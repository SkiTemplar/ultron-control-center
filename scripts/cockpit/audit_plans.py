"""Audit + close stale plans, add new ones.

One-shot script: rerun is idempotent (already-resolved entries stay,
already-present new ids are not duplicated).
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

PLANS = Path(os.path.expanduser("~/.ultron/plans/PLANS.json"))

DONE = {
    "control-center-v15.1-followups": (
        "Plans tab + Logs tab + hotkey editor + diagnose PC + backup status + "
        "10 commits secuenciales en v15.1.1 cubren todos los followups."
    ),
    "ultron-plan-mode": (
        "Implementado como Plans tab en Control Center (kanban + CRUD + open "
        "resolution session + stats)."
    ),
    "tui-buttons-meta-prompter": (
        "TUI deprecated en favor del Control Center (Tauri 2). Meta-prompter "
        "queda como follow-up en la tab Stats si se necesita."
    ),
    "tui-command-buttons-systems-view": (
        "TUI deprecated por Control Center. La vista System ya tiene los "
        "botones (scheduled tasks, run-now, detail panel)."
    ),
    "doctor-warns-cleanup": (
        "Doctor task ahora exit 0x0 con findings logged; warnings residuales "
        "son del legacy doctor, no del Control Center wrapper."
    ),
    "web-polish-es-redesign-fixes": (
        "v15.6-web-refresh resolved; cualquier polish adicional cae bajo "
        "control-center-v15.1-followups (ya cerrado)."
    ),
    "apps-inventory-script-tui-view-weekly-scheduler": (
        "Cubierto por scripts/cockpit/installed_apps.py + System tab + "
        "UltronDoctor-Weekly retargeted al path actual."
    ),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def main() -> int:
    p = json.loads(PLANS.read_text(encoding="utf-8"))
    now = now_iso()

    resolved = 0
    for item in p["items"]:
        if item["id"] in DONE and item.get("status") != "resolved":
            item["status"] = "resolved"
            item["resolved_at"] = now
            notes = item.setdefault("notes", [])
            notes.append({"ts": now, "text": "[auto-audit] " + DONE[item["id"]]})
            resolved += 1

    new_plans = [
        {
            "id": "v15.2-public-release",
            "kind": "sprint",
            "title": "Public release: instalador GitHub + skill picker + persona-strip",
            "status": "open",
            "priority": "p1",
            "effort_hours": [16, 24],
            "tags": [
                "release",
                "installer",
                "open-source",
                "blocker-for-mobile-bus",
            ],
            "spec_path": "~/.ultron/plans/specs/v15.2-public-release.md",
            "description": (
                "Antes de seguir con bus + mobile + dreams, publicar ULTRON en "
                "GitHub. Scope: (1) installer interactivo (clone + "
                "install.ps1/install.sh que copia .claude/skills, scripts/, "
                "configura .venv via uv, scaffolds .ultron-vault placeholder); "
                "(2) skill picker en el installer (descartar skills personales "
                "USER-specific o renombrar sin nombre de persona); "
                "(3) sanitizer paths (no hardcoded C:\\Users\\USER), strip "
                "de secrets/credenciales/auth; (4) repo README + "
                "docs/architecture; (5) smoke-test post-install (doctor.py + "
                "brain_index update); (6) bus/mobile/dreams se quedan en "
                "backlog como p3 hasta despues del release."
            ),
            "created_at": now,
            "resolved_at": None,
        },
        {
            "id": "v15.1.2-plans-ai-brainstorm",
            "kind": "patch",
            "title": "Plans AI brainstorm + priority lanes + dreams-local",
            "status": "open",
            "priority": "p2",
            "effort_hours": [4, 8],
            "tags": ["control-center", "plans", "ai"],
            "spec_path": "~/.ultron/plans/specs/v15.1.2-plans-ai.md",
            "description": (
                "Plans tab gana boton AI brainstorm: textarea con goal "
                "description, llama a Claude inline pidiendo lista estructurada "
                "de plans, parsea y los upserta via add_plan. Lanes de priority "
                "dentro de cada status column. Dreams-local: variante "
                "simplificada del Anthropic Managed Agents Dreams (long-running "
                "background agent) usando Claude CLI + queue local en lugar de "
                "la API."
            ),
            "created_at": now,
            "resolved_at": None,
        },
    ]

    existing = {it["id"] for it in p["items"]}
    added = 0
    for new in new_plans:
        if new["id"] not in existing:
            p["items"].append(new)
            added += 1

    # Demote bus/mobile/anti-hallucination/supervisor/pipeline/overnight to
    # p3 with a note — they wait for the public release.
    DEMOTE = [
        "v15.1-bus-foundation",
        "v15.2-supervisor",
        "v15.3-pipeline",
        "v15.4-overnight",
        "v15.5-mobile",
        "v15.7-anti-hallucination",
    ]
    demoted = 0
    for item in p["items"]:
        if item["id"] in DEMOTE and item.get("priority") in ("p0", "p1", "p2"):
            item["priority"] = "p3"
            notes = item.setdefault("notes", [])
            notes.append(
                {
                    "ts": now,
                    "text": (
                        "[auto-audit] demoted to p3 — waiting for v15.2 public "
                        "release per USER direction 2026-05-15."
                    ),
                }
            )
            demoted += 1

    p["updated_at"] = now
    tmp = PLANS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(p, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PLANS)
    print(
        f"resolved={resolved} added={added} demoted={demoted} "
        f"total={len(p['items'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
