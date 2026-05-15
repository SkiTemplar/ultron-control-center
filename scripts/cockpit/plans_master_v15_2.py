"""Reescribe el roadmap PLANS.json hacia el release público v15.2.

Idempotente — re-ejecuciones no duplican; actualiza fechas si el item ya
existe. Mueve los items que dependen del release a p3 ("waiting for v15.2
public release").
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

PLANS = Path(os.path.expanduser("~/.ultron/plans/PLANS.json"))


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


MASTER = [
    {
        "id": "v15.1.4-fixes-and-ui",
        "kind": "patch",
        "title": "v15.1.4 fixes + per-project hotkeys + multi-action + responsive UI + Logs removal",
        "status": "open",
        "priority": "p1",
        "effort_hours": [8, 12],
        "tags": ["control-center", "ui-ux"],
        "description": (
            "Cierre técnico antes del release público. Incluye:\n"
            "1) Per-project hotkeys (Shift+G+1..9 abre proyecto N con su\n"
            "   stack de acciones).\n"
            "2) Multi-action projects: cada proyecto tiene actions[]\n"
            "   (folder/file/claude-session/codex/gemini); Open all dispara\n"
            "   todo en paralelo.\n"
            "3) Responsive UI: el layout actual no escala con ventanas\n"
            "   grandes; expandir grids y max-width caps.\n"
            "4) Logs tab: borrar del Sidebar definitivamente (no solo\n"
            "   available:false; quitar Tab union entry + render gate).\n"
            "5) Eliminar dead commands run_doctor, system_info,\n"
            "   read_skill_md_inner_raw, skill_md backup rotation.\n"
            "6) Cost watchdog: alert al 80% del weekly Anthropic limit.\n"
            "7) Inbox quick capture global hotkey (Ctrl+Alt+I).\n"
            "8) Tray quick-actions menu.\n"
            "9) Personal section split UI: izquierda = lo que ULTRON sabe\n"
            "   (auto-extracted style fingerprints), derecha = textarea +\n"
            "   Submit que abre Claude para profundizar."
        ),
        "spec_path": "~/.ultron/plans/specs/v15.1.4-fixes-ui.md",
        "created_at": now_iso(),
    },
    {
        "id": "v15.1.5-memory-visual-codex-fallback",
        "kind": "sprint",
        "title": "v15.1.5 Memory visual (Qdrant 2D) + Codex-fallback + Activity timeline",
        "status": "open",
        "priority": "p2",
        "effort_hours": [12, 20],
        "tags": ["control-center", "memory", "stats"],
        "description": (
            "Features ambiciosas que valen su tiempo:\n"
            "1) Memory visual: UMAP/t-SNE 2D scatter de los embeddings de\n"
            "   Qdrant, click → nota completa. Capa que faltaba al Memory\n"
            "   tab (ahora es solo lista + search).\n"
            "2) Codex-fallback con contexto: cuando Claude reach limit,\n"
            "   wrapper detecta y abre Codex session pasando últimas 50\n"
            "   líneas del transcript + context.md + recall brain_index del\n"
            "   topic actual.\n"
            "3) Activity timeline: vista cronológica del día con sesiones,\n"
            "   skills activated, plans tocados, memorias accedidas. Datos\n"
            "   ya están en Stats++ — falta presentación."
        ),
        "spec_path": "~/.ultron/plans/specs/v15.1.5-memory-codex.md",
        "created_at": now_iso(),
    },
    {
        "id": "v15.2-public-release",
        "kind": "sprint",
        "title": "v15.2 PUBLIC RELEASE — installer + skill packs + persona-strip + GitHub",
        "status": "open",
        "priority": "p1",
        "effort_hours": [20, 32],
        "tags": ["release", "installer", "open-source", "blocker-for-mobile"],
        "description": (
            "Objetivo: ULTRON público en GitHub, instalable por terceros,\n"
            "open-source y no invasivo. Sub-items:\n"
            "1) Persona-strip: 3 scripts con C:\\\\Users\\\\USER\\\\... ->\n"
            "   Path.home(). Capability validators dinámicas en build.rs.\n"
            "   Hardcoded D:\\\\USER\\\\BACKUP -> config/backup.toml.\n"
            "2) Repo split: nuevo `ultron` (público), `ultron-skills`\n"
            "   privado->público, `ultron-memory-template` (esqueleto\n"
            "   vacío). Cada usuario clona y rellena su propio vault.\n"
            "3) install.ps1 + install.sh interactivos. Pregunta:\n"
            "   - ¿Crear ~/.ultron/?\n"
            "   - ¿Vault? (clona memory-template o usa existente)\n"
            "   - ¿Hooks en ~/.claude/settings.json? (merge no destructivo)\n"
            "   - ¿Skills? (paquetes: core / dev / personal-assistant /\n"
            "     gaming / finance / creative) — boolean toggles.\n"
            "   - ¿Features opcionales? News, Gaming tab, Memory visual,\n"
            "     Personal — boolean toggles que activan/desactivan tabs.\n"
            "4) Skill renaming: descartar nombres de personas\n"
            "   (Pana/Alfred/Don-Claudio/Tio-Gilito/Tolkien etc.) -> alias\n"
            "   genéricos (orchestrator/sys-admin/game-dev/finance/writer).\n"
            "   Los nombres de persona quedan como aliases opcionales.\n"
            "5) Skill detection auto: el installer escanea ~/.claude/skills\n"
            "   existentes del user y los registra; offer to import vs.\n"
            "   fresh install.\n"
            "6) README + docs/: getting-started, architecture (3-layer\n"
            "   memory, tri-model orchestration), SYSTEM-MAP, threat-model,\n"
            "   contributing.\n"
            "7) Smoke-test post-install: doctor.py + brain_index update +\n"
            "   verify Control Center launches.\n"
            "8) Tauri auto-updater wired a GitHub releases.\n"
            "9) Theme toggle (al menos light disponible) — hoy hardcoded\n"
            "   OLED black.\n"
            "10) Telemetry export TSV/JSON desde Stats tab."
        ),
        "spec_path": "~/.ultron/plans/specs/v15.2-public-release.md",
        "created_at": now_iso(),
    },
    {
        "id": "v15.3-mobile-app",
        "kind": "sprint",
        "title": "v15.3 ULTRON Remote — mobile companion via Tailscale/local server",
        "status": "open",
        "priority": "p3",
        "effort_hours": [40, 60],
        "tags": ["mobile", "remote", "deferred-to-post-release"],
        "description": (
            "Después del release público: app móvil que ejecuta acciones en\n"
            "el ordenador via servidor local + Tailscale. Defer hasta v15.2\n"
            "shipped."
        ),
        "spec_path": "~/.ultron/plans/specs/v15.3-mobile.md",
        "created_at": now_iso(),
    },
]


def main() -> int:
    p = json.loads(PLANS.read_text(encoding="utf-8"))
    now = now_iso()
    existing = {it["id"]: i for i, it in enumerate(p["items"])}
    added = 0
    updated = 0
    for entry in MASTER:
        if entry["id"] in existing:
            idx = existing[entry["id"]]
            current = p["items"][idx]
            # Patch updateable fields without overwriting notes / status
            # the user may have changed manually.
            for k in ("title", "description", "priority", "effort_hours", "tags", "spec_path"):
                current[k] = entry[k]
            updated += 1
        else:
            entry["resolved_at"] = None
            p["items"].append(entry)
            added += 1

    p["updated_at"] = now
    tmp = PLANS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(p, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PLANS)
    print(f"added={added} updated={updated} total={len(p['items'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
