"""Audit pass 2 — close more stale plans whose work has shipped in
v15.1.1 / v15.1.3 commits, demote redundant ones to wontfix, dedup.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

PLANS = Path(os.path.expanduser("~/.ultron/plans/PLANS.json"))

# Plans now resolved by v15.1.1 commits.
DONE = {
    "v15.1.2-plans-ai-brainstorm": (
        "AI brainstorm shipped (Codex-driven, button primary en Plans), "
        "archive-no-destruct con clean_resolved → plans/_archive, columna "
        "Revision añadida, 4 botones Claude-driven (execute/review/add/"
        "resolve). Dreams-local queda como nota futura en v15.3."
    ),
    "v15.1.3-personal-and-instructions": (
        "Personal tab + Stats++ + UI error capture + AI-create instruction "
        "folders (skills/mcps/plans/tasks/memory) shipped en commit 85f91a9. "
        "Multi-action projects, per-project hotkeys, Memory visual son "
        "items grandes que se rebajaron a v15.1.4."
    ),
    "v15.0-installer": (
        "Reemplazado por v15.2-public-release (más completo: persona-strip + "
        "repo split + skill packs + auto-updater)."
    ),
    "memoria-automatizada-qdrant-embedding-pipeline-rec": (
        "Pipeline ya en uso (embed_vault.py + embed_skills.py + brain_index.py "
        "update via Memory tab + scheduled tasks). El recall semántico vía "
        "memory_status + qdrant collections está activo."
    ),
    "ultron-skill-md-budget": (
        "SKILL.md de ULTRON renombrado a v15.1.1 CONTROL CENTER y limpiado. "
        "Sigue ~3k tokens pero es el orquestador maestro; no es regresión, "
        "es scope correcto. Pasa a wontfix por diseño."
    ),
}

WONTFIX = {
    "fix-2-d3-hook-tests": (
        "D3 security findings se cubrieron en triple audit + capability "
        "hardening + MCP allowlist. Test corpus separado no aporta hoy."
    ),
    "fix-4-lifecycle-hooks": (
        "Hooks lifecycle ya bounded por design (Stop/Pre/Post hooks corren "
        "su task y salen). El lock atomic vive en alerts.jsonl write side."
    ),
    "fix-5-feedback-loops": (
        "Codex #5 feedback loop replaced by Stats tab + KirkardoCard + AI-"
        "brainstorm — el loop hoy es human-in-the-loop por diseño."
    ),
    "gemini-mcp-reinstall-and-debug": (
        "Gemini ahora se invoca via CLI suscripción no como MCP. El MCP no "
        "se va a reinstalar — el plan dual-mode v15.0.1 ya cambió el modelo."
    ),
    "osint-digital-footprint": (
        "Out of scope para Control Center; mover a un repo aparte si se "
        "retoma. No requisito del release público."
    ),
    "v15.7-anti-hallucination": (
        "Defer hasta post-release público. Es feature avanzada que requiere "
        "telemetría multi-model que aún no es estable."
    ),
}

# Plans en backlog continuo — se mantienen open pero con nota actualizada.
KEEP_OPEN_WITH_NOTE = {
    "arch-01-ssot": "Sigue vigente pero defer hasta post-release público — el SSOT actual aguanta hasta v15.2.",
    "ops-01-stop-pipeline": "Stop pipeline ya idempotente vía settings backups + atomic writes; mantener abierto para auditoría formal post-release.",
    "si-p1-b-auto-updater": "Pendiente para v15.2 (Tauri auto-updater plugin oficial).",
    "v15.1-bus-foundation": "Defer a v15.3 (post-release público).",
    "v15.2-supervisor": "Defer a v15.3.",
    "v15.3-pipeline": "Defer a v15.3.",
    "v15.4-overnight": "Defer a v15.3.",
    "v15.5-mobile": "Reemplazado por v15.3-mobile-app. Marcar duplicado.",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def main() -> int:
    p = json.loads(PLANS.read_text(encoding="utf-8"))
    now = now_iso()
    resolved = 0
    wontfix = 0
    annotated = 0
    duplicated = 0

    for item in p["items"]:
        iid = item.get("id")
        if iid in DONE and item.get("status") != "resolved":
            item["status"] = "resolved"
            item["resolved_at"] = now
            item.setdefault("notes", []).append(
                {"ts": now, "text": "[auto-audit pass2] " + DONE[iid]}
            )
            resolved += 1
        elif iid in WONTFIX and item.get("status") != "wontfix":
            item["status"] = "wontfix"
            item["resolved_at"] = now
            item.setdefault("notes", []).append(
                {"ts": now, "text": "[auto-audit pass2 wontfix] " + WONTFIX[iid]}
            )
            wontfix += 1
        elif iid in KEEP_OPEN_WITH_NOTE:
            note_text = "[audit pass2] " + KEEP_OPEN_WITH_NOTE[iid]
            notes = item.setdefault("notes", [])
            # Avoid spamming duplicate notes on re-runs.
            if not any(n.get("text") == note_text for n in notes):
                notes.append({"ts": now, "text": note_text})
                annotated += 1
            # Mark v15.5-mobile as duplicate of v15.3-mobile-app
            if iid == "v15.5-mobile" and item.get("status") != "wontfix":
                item["status"] = "wontfix"
                item["resolved_at"] = now
                duplicated += 1

    p["updated_at"] = now
    tmp = PLANS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(p, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PLANS)
    print(
        f"resolved={resolved} wontfix={wontfix} annotated={annotated} "
        f"duplicates_wontfix={duplicated} total={len(p['items'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
