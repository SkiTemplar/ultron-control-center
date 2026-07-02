"""check_ids.py — chequeo de gobernanza del memory-bench (READ-ONLY).

Lee una lista JSON de canonical_ids por stdin y verifica contra brain.db que
todo id devuelto por el recall es un item ACTIVE y no-Secret. Emite una linea
JSON: {"checked": n, "non_active": [...], "secret": [...]}.

Solo SELECT — el write-path sigue siendo exclusivo de MemoryService.
"""

import json
import os
import sqlite3
import sys

BRAIN = os.path.join(os.path.expanduser("~"), ".ultron", "brain.db")


def main() -> None:
    ids = json.loads(sys.stdin.read() or "[]")
    if not ids:
        print(json.dumps({"checked": 0, "non_active": [], "secret": []}))
        return

    con = sqlite3.connect(f"file:{BRAIN}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    placeholders = ",".join("?" for _ in ids)
    rows = con.execute(
        f"SELECT id, status, sensitivity FROM memory_items WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    by_id = {r["id"]: r for r in rows}

    non_active = []
    secret = []
    for mid in ids:
        row = by_id.get(mid)
        if row is None:
            non_active.append(f"{mid}:MISSING")
            continue
        if row["status"] != "active":
            non_active.append(f"{mid}:{row['status']}")
        if (row["sensitivity"] or "").lower() == "secret":
            secret.append(mid)

    print(json.dumps({"checked": len(ids), "non_active": non_active, "secret": secret}))


if __name__ == "__main__":
    main()
