# Ingesta canonica de memorias extraidas -> ultron-memory candidate -> inbox
# (con auto-approve ON, los limpios se promueven e indexan en Qdrant ultron_memory).
# Uso: uv run python ingest.py [--limit N] [--bin PATH]
import json, subprocess, re, sys, os

BIN = r"C:\Users\USER\.ultron\control-center\src-tauri\target\release\ultron-memory.exe"
SRC = r"C:\Users\USER\.ultron\cockpit\memory-ingest\extracted.json"

limit = None
offset = 0
args = sys.argv[1:]
if "--limit" in args:
    limit = int(args[args.index("--limit") + 1])
if "--offset" in args:
    offset = int(args[args.index("--offset") + 1])
if "--bin" in args:
    BIN = args[args.index("--bin") + 1]

def slugify(name: str) -> str:
    tok = re.split(r"[—(\-\s]", (name or "").strip())[0]
    return re.sub(r"[^a-z0-9]", "", tok.lower()) or "unknown"

d = json.load(open(SRC, encoding="utf-8"))
projs = d["result"]["projects"]

ok = 0
fail = 0
done = 0
seen = 0
per = {}
for p in projs:
    slug = slugify(p.get("project", ""))
    for m in p.get("memories", []):
        seen += 1
        if seen <= offset:
            continue
        if limit is not None and done >= limit:
            break
        payload = {
            "type": m.get("type", "fact"),
            "scope": "project",
            "title": m.get("title", ""),
            "summary": m.get("summary", ""),
            "content": m.get("content", ""),
            "importance": float(m.get("importance", 0.5)),
            "project": slug,
            "tags": m.get("tags", []),
        }
        done += 1
        try:
            r = subprocess.run(
                [BIN, "candidate"],
                input=json.dumps(payload, ensure_ascii=False),
                capture_output=True, text=True, encoding="utf-8", timeout=120,
            )
            out = json.loads((r.stdout or "{}").strip())
            if out.get("candidate_id"):
                ok += 1
                per[slug] = per.get(slug, 0) + 1
            else:
                fail += 1
                print("  NOID", slug, "::", (r.stdout or "")[:80], (r.stderr or "")[:120])
        except Exception as e:
            fail += 1
            print("  ERR", slug, "::", str(e)[:140])
    if limit is not None and done >= limit:
        break

print("=" * 50)
print("INGESTA COMPLETA  ok=%d  fail=%d  total=%d" % (ok, fail, done))
for k, v in sorted(per.items()):
    print("   %-22s %d" % (k, v))
