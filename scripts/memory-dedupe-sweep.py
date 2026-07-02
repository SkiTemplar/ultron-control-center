"""memory-dedupe-sweep.py — purga de duplicados EXACTOS del corpus de memoria.

Contexto (2026-07-02, masterplan (b)): el write-path ya BLOQUEA twins exactos
nuevos (MemoryError::Duplicate), pero el corpus legado acumulo cientos de
grupos identicos (mismo content_hash + scope + project_id) que inflaban el
dup_rate del pack de recall a ~0.33 y tapaban slots del top-8.

Politica de conservacion por grupo: sobrevive el item con mayor access_count
(el mas consultado); empate -> updated_at mas reciente; empate -> id menor
(determinista). El resto se purga via `ultron-memory forget --id` — el unico
write-path permitido (regla de oro: solo MemoryService escribe memoria).

La frontera scope/proyecto se respeta (CONTRACTS §4): un texto identico en
OTRO proyecto NO es duplicado y sobrevive. Solo se tocan items ACTIVE.

Uso:
  uv run python scripts/memory-dedupe-sweep.py            # dry-run (no escribe)
  uv run python scripts/memory-dedupe-sweep.py --execute  # purga real
"""

import json
import os
import sqlite3
import subprocess
import sys

BRAIN = os.path.join(os.path.expanduser("~"), ".ultron", "brain.db")
EXE = os.environ.get(
    "ULTRON_MEMORY_BIN",
    os.path.join(os.path.expanduser("~"), ".ultron", "bin", "ultron-memory.exe"),
)


def find_groups() -> list[list[sqlite3.Row]]:
    """Grupos de items ACTIVE con content_hash identico (mismo scope+proyecto)."""
    con = sqlite3.connect(f"file:{BRAIN}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    keys = con.execute(
        "SELECT content_hash, scope, project_id, COUNT(*) n FROM memory_items "
        "WHERE status='active' AND content_hash IS NOT NULL "
        "GROUP BY content_hash, scope, project_id HAVING n > 1"
    ).fetchall()
    groups = []
    for k in keys:
        rows = con.execute(
            "SELECT id, access_count, updated_at, summary FROM memory_items "
            "WHERE status='active' AND content_hash=? AND scope=? AND project_id IS ? "
            "ORDER BY access_count DESC, updated_at DESC, id ASC",
            (k["content_hash"], k["scope"], k["project_id"]),
        ).fetchall()
        if len(rows) > 1:
            groups.append(rows)
    con.close()
    return groups


def main() -> None:
    execute = "--execute" in sys.argv
    groups = find_groups()
    victims = [r["id"] for g in groups for r in g[1:]]

    print(f"grupos: {len(groups)} · sobrevive 1 por grupo · a purgar: {len(victims)}")
    if not execute:
        for g in groups[:5]:
            print(f"  n={len(g)}  keep={g[0]['id'][:8]}  :: {(g[0]['summary'] or '')[:90]}")
        print(json.dumps({"dry_run": True, "groups": len(groups), "victims": len(victims)}))
        return

    ok, fail = 0, 0
    for i, vid in enumerate(victims, 1):
        r = subprocess.run(
            [EXE, "forget", "--id", vid],
            capture_output=True,
            text=True,
            encoding="utf-8-sig",
        )
        if r.returncode == 0 and '"ok":true' in (r.stdout or "").replace(" ", ""):
            ok += 1
        else:
            fail += 1
            print(f"FALLO {vid}: {(r.stderr or r.stdout or '')[:160]}")
        if i % 200 == 0:
            print(f"  ... {i}/{len(victims)}")

    print(json.dumps({"dry_run": False, "groups": len(groups), "purged": ok, "failed": fail}))


if __name__ == "__main__":
    main()
